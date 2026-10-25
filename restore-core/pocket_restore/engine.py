from __future__ import annotations

import json
import math
import os
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from collections import deque
from pathlib import Path
from typing import Callable

from .metadata import probe_dji_metadata

ASSETS = Path(__file__).resolve().parent / "assets"
PROFILES = {"auto", "dlog", "dlog2", "hlg", "rec709"}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".m4v", ".mkv", ".mts", ".m2ts", ".avi"}
NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


class RestoreError(Exception):
    pass


class Cancelled(RestoreError):
    pass


def find_tool(name: str) -> str | None:
    override = os.environ.get("POCKET_RESTORE_" + name.upper())
    if override and Path(override).is_file():
        return str(Path(override).resolve())
    bases = [Path(sys.executable).resolve().parent] if getattr(sys, "frozen", False) else []
    bases.append(Path(__file__).resolve().parent.parent)
    for base in bases:
        local = base / "tools" / (name + ".exe")
        if local.is_file():
            return str(local)
    return shutil.which(name)


def _run_json(command: list[str], timeout: int = 45) -> dict:
    try:
        result = subprocess.run(command, capture_output=True, timeout=timeout,
                                creationflags=NO_WINDOW, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RestoreError(f"无法读取视频信息：{exc}") from exc
    if result.returncode:
        detail = result.stderr.decode("utf-8", "replace")[-1500:]
        raise RestoreError("视频信息读取失败：" + detail)
    try:
        return json.loads(result.stdout.decode("utf-8"))
    except (ValueError, UnicodeError) as exc:
        raise RestoreError("视频探测返回了无效数据") from exc


def probe_video(path: str | Path) -> dict:
    ffprobe = find_tool("ffprobe")
    if not ffprobe:
        raise RestoreError("未找到 ffprobe")
    raw = _run_json([ffprobe, "-v", "error", "-show_streams", "-show_format",
                     "-of", "json", str(path)])
    videos = [s for s in raw.get("streams", [])
              if s.get("codec_type") == "video" and not s.get("disposition", {}).get("attached_pic")]
    if not videos:
        raise RestoreError("文件没有可处理的视频轨道")
    video = videos[0]
    pixel = video.get("pix_fmt", "")
    depth = int(video.get("bits_per_raw_sample") or 0)
    if not depth:
        match = re.search(r"(?:p|gray|gbrp)(10|12|14|16)(?:le|be)?$", pixel)
        depth = int(match.group(1)) if match else (10 if pixel.startswith("p010") else 8)
    try:
        duration = float(raw.get("format", {}).get("duration") or video.get("duration") or 0)
    except (TypeError, ValueError):
        duration = 0
    return {
        "codec": video.get("codec_name"), "codec_profile": video.get("profile"),
        "pixel_format": pixel, "bit_depth": depth,
        "width": video.get("width"), "height": video.get("height"),
        "frame_rate": video.get("avg_frame_rate"), "duration_seconds": duration,
        "color_space": video.get("color_space"),
        "color_primaries": video.get("color_primaries"),
        "color_transfer": video.get("color_transfer"),
        "color_range": video.get("color_range"),
        "audio_streams": sum(s.get("codec_type") == "audio" for s in raw.get("streams", [])),
    }


def inspect(path: str | Path) -> dict:
    result = probe_dji_metadata(path)
    try:
        video = probe_video(path)
        result["video"] = video
        if result["color_profile"] == "unknown" and result["status"] == "unknown":
            transfer, primaries = video["color_transfer"], video["color_primaries"]
            if transfer == "arib-std-b67" and primaries == "bt2020":
                result.update(color_profile="hlg", status="identified")
                result["evidence"].append({"source": "ffprobe", "key": "HDR tags", "value": "BT.2020 HLG"})
            elif transfer == "smpte2084" and primaries == "bt2020":
                result["warnings"].append("检测到 PQ HDR；当前还原核心不处理 PQ 输入")
        # A Rec.709 container tag alone cannot distinguish an unrecognised DJI Log file.
    except RestoreError as exc:
        result["video"] = None
        result["warnings"].append(str(exc))
        result["status"] = "error"
    return result


def _encoders() -> set[str]:
    ffmpeg = find_tool("ffmpeg")
    if not ffmpeg:
        return set()
    try:
        proc = subprocess.run([ffmpeg, "-hide_banner", "-encoders"], capture_output=True,
                              timeout=10, creationflags=NO_WINDOW)
        return set(re.findall(r"^\s*V\S*\s+(\S+)", proc.stdout.decode("utf-8", "replace"), re.M))
    except (OSError, subprocess.TimeoutExpired):
        return set()


def capabilities() -> dict:
    sdr = [p for p in ("dlog", "dlog2") if (ASSETS / "luts" / f"{p}_sdr.cube").is_file()] + ["hlg", "rec709"]
    try:
        hdr_verified = json.loads((ASSETS / "hdr_readiness.json").read_text(encoding="utf-8")).get("verified_profiles", [])
    except (OSError, ValueError):
        hdr_verified = []
    hdr = [p for p in ("dlog", "dlog2") if p in hdr_verified
           and (ASSETS / "luts" / f"{p}_hlg.cube").is_file()
           and (ASSETS / "luts" / f"{p}_hlg_shaper.cube").is_file()]
    if "hlg" in hdr_verified:
        hdr.append("hlg")
    encoders = _encoders()
    return {
        "schema_version": 1, "version": "0.1.0", "sdr_profiles": sdr,
        "hdr_profiles": hdr, "supported_output_modes": ["sdr"] + (["hlg"] if hdr else []),
        "ffmpeg_available": bool(find_tool("ffmpeg")),
        "ffprobe_available": bool(find_tool("ffprobe")),
        "encoders": sorted(encoders & {"hevc_nvenc", "libx265"}),
        "hdr_unavailable_reason": None if hdr else "HDR 官方转换与输出仍在验证，暂不可用",
        "mimo_visual_match_verified": False,
        "hdr_preset": "HLG / 203-nit diffuse white / 1000-nit nominal display",
    }


def validate_request(request: dict) -> dict:
    if not isinstance(request, dict) or request.get("schema_version", 1) != 1:
        raise RestoreError("不支持的任务格式")
    files = request.get("files")
    if not isinstance(files, list) or not files or len(files) > 10000:
        raise RestoreError("请选择 1 至 10000 个视频")
    if request.get("overwrite"):
        raise RestoreError("禁止覆盖原文件或已存在的输出")
    normalized = dict(request)
    normalized["files"] = []
    seen = set()
    for item in files:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str):
            raise RestoreError("每个视频必须提供绝对路径")
        path = Path(item["path"])
        if not path.is_absolute() or "\x00" in item["path"]:
            raise RestoreError("视频路径必须是有效绝对路径")
        profile = item.get("profile", "auto")
        if not isinstance(profile, str) or profile not in PROFILES:
            raise RestoreError("不支持的输入模式：" + str(profile))
        key = os.path.normcase(str(path.resolve()))
        if key not in seen:
            seen.add(key)
            normalized["files"].append({"path": str(path.resolve()), "profile": profile})
    output = request.get("output_dir")
    if not isinstance(output, str) or "\x00" in output or not Path(output).is_absolute():
        raise RestoreError("请提供独立的绝对输出目录")
    normalized["output_dir"] = str(Path(output).resolve())
    if not isinstance(request.get("output_mode", "sdr"), str) or request.get("output_mode", "sdr") not in {"sdr", "hlg"}:
        raise RestoreError("输出模式必须为 sdr 或 hlg")
    if request.get("look", "standard") != "standard":
        raise RestoreError("当前只支持 standard 官方标准还原")
    if not isinstance(request.get("encoder", "auto"), str) or request.get("encoder", "auto") not in {"auto", "cpu"}:
        raise RestoreError("编码方式必须为 auto 或 cpu")
    for key in ("trim_start", "trim_duration"):
        if key in request:
            value = request[key]
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
                raise RestoreError("测试片段时长必须是非负有限数字")
            if key == "trim_duration" and value == 0:
                raise RestoreError("测试片段时长必须大于零")
    cancel = request.get("cancel_file")
    if cancel is not None and (not isinstance(cancel, str) or "\x00" in cancel or not Path(cancel).is_absolute()):
        raise RestoreError("取消标记必须为绝对路径")
    normalized.setdefault("output_mode", "sdr")
    normalized.setdefault("encoder", "auto")
    normalized.setdefault("job_id", uuid.uuid4().hex)
    if not isinstance(normalized["job_id"], str) or len(normalized["job_id"]) > 200:
        raise RestoreError("任务标识无效")
    return normalized


def filter_chain(video: dict, mode: str, with_lut: bool, nvenc: bool) -> str:
    matrix = video.get("color_space")
    matrix = {"bt709": "709", "bt2020nc": "2020_ncl", "bt2020c": "2020_cl",
              "smpte170m": "170m", "bt470bg": "470bg"}.get(matrix, "709")
    input_range = "full" if video.get("color_range") == "pc" else "limited"
    # Equal input/output transfer and primaries preserve the encoded Log samples.
    to_rgb = (f"zscale=matrixin={matrix}:matrix=gbr:rangein={input_range}:range=full:"
              "transferin=709:transfer=709:primariesin=709:primaries=709,format=gbrpf32le")
    parts = [to_rgb]
    if with_lut:
        if mode == "hlg":
            parts.append("lut1d=file=shaper.cube:interp=linear")
        parts.append("lut3d=file=transform.cube:interp=tetrahedral")
    if mode == "hlg":
        matrix_out, transfer, primaries = "2020_ncl", "arib-std-b67", "2020"
    else:
        matrix_out, transfer, primaries = "709", "709", "709"
    parts.append(f"zscale=matrixin=gbr:matrix={matrix_out}:rangein=full:range=limited:"
                 f"transferin={transfer}:transfer={transfer}:primariesin={primaries}:"
                 f"primaries={primaries}:dither=error_diffusion,format=yuv420p10le")
    if nvenc:
        parts.append("format=p010le")
    for side_type in ("MASTERING_DISPLAY_METADATA", "CONTENT_LIGHT_LEVEL", "DYNAMIC_HDR_PLUS"):
        parts.append("sidedata=mode=delete:type=" + side_type)
    return ",".join(parts)


def filter_hlg_to_sdr(video: dict, nvenc: bool) -> str:
    if (video.get("color_transfer"), video.get("color_primaries")) != ("arib-std-b67", "bt2020"):
        raise RestoreError("HLG 转普通视频需要明确的 BT.2020 HLG 色彩标记")
    matrix = {"bt2020nc": "2020_ncl", "bt2020c": "2020_cl"}.get(video.get("color_space"))
    if matrix is None:
        raise RestoreError("HLG 原片的色彩矩阵不是 BT.2020")
    source_range = "full" if video.get("color_range") == "pc" else "limited"
    # Fixed 1000-nit HLG display / 100-nit SDR preset. Linear units have peak 10.
    parts = [
        f"zscale=matrixin={matrix}:primariesin=2020:transferin=arib-std-b67:rangein={source_range}:"
        "matrix=gbr:primaries=709:transfer=linear:range=full:npl=100:agamma=0",
        "format=gbrpf32le",
        "setparams=color_primaries=bt709:color_trc=linear:colorspace=bt709",
        "tonemap=tonemap=mobius:param=0.3:desat=2:peak=10",
        "zscale=matrixin=gbr:primariesin=709:transferin=linear:rangein=full:"
        "matrix=709:primaries=709:transfer=709:range=limited:dither=error_diffusion:agamma=0",
        "format=yuv420p10le",
        "sidedata=mode=delete:type=MASTERING_DISPLAY_METADATA",
        "sidedata=mode=delete:type=CONTENT_LIGHT_LEVEL",
        "sidedata=mode=delete:type=DYNAMIC_HDR_PLUS",
        "setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709",
    ]
    if nvenc:
        parts.append("format=p010le")
    return ",".join(parts)


def choose_output(source: Path, directory: Path, mode: str) -> Path:
    label = "HLG" if mode == "hlg" else "SDR"
    for number in range(100000):
        suffix = "" if number == 0 else f"_{number + 1}"
        candidate = directory / f"{source.stem}_{label}{suffix}.mp4"
        if not candidate.exists() and os.path.normcase(str(candidate.resolve())) != os.path.normcase(str(source.resolve())):
            return candidate
    raise RestoreError("输出文件重名过多，请更换输出目录")


def _cancelled(request: dict) -> bool:
    return bool(request.get("cancel_file") and Path(request["cancel_file"]).exists())


def _stop_process(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=8)


def _stream_process(command: list[str], cwd: Path, request: dict,
                    index: int, duration: float, emit: Callable) -> None:
    messages: queue.Queue = queue.Queue()
    errors: deque[str] = deque(maxlen=35)
    try:
        process = subprocess.Popen(command, cwd=str(cwd), stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, creationflags=NO_WINDOW)
    except OSError as exc:
        raise RestoreError(f"无法启动编码器：{exc}") from exc

    def read_progress():
        assert process.stdout is not None
        for line in iter(process.stdout.readline, b""):
            messages.put(line.decode("utf-8", "replace").strip())

    def read_errors():
        assert process.stderr is not None
        for line in iter(process.stderr.readline, b""):
            errors.append(line.decode("utf-8", "replace").strip())

    readers = [threading.Thread(target=read_progress, daemon=True), threading.Thread(target=read_errors, daemon=True)]
    for reader in readers:
        reader.start()
    last_emit = 0.0
    seconds = 0.0
    try:
        while process.poll() is None or not messages.empty():
            if _cancelled(request):
                raise Cancelled("用户取消")
            try:
                line = messages.get(timeout=0.15)
            except queue.Empty:
                continue
            key, _, value = line.partition("=")
            if key == "out_time_us":
                try:
                    seconds = max(0.0, float(value) / 1000000)
                except ValueError:
                    pass
            if key == "progress" and time.monotonic() - last_emit >= 0.2:
                fraction = min(0.995, seconds / duration) if duration > 0 else None
                emit({"type": "progress", "index": index, "fraction": fraction,
                      "processed_seconds": seconds})
                last_emit = time.monotonic()
        code = process.wait()
        for reader in readers:
            reader.join(timeout=2)
        if code:
            raise RestoreError("编码失败：" + "\n".join(errors)[-2500:])
    finally:
        _stop_process(process)
        for reader in readers:
            reader.join(timeout=2)
        if process.stdout:
            process.stdout.close()
        if process.stderr:
            process.stderr.close()


def _command(ffmpeg: str, source: Path, staging: Path, video: dict,
             request: dict, with_lut: bool, nvenc: bool) -> list[str]:
    command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-n"]
    if request.get("trim_start", 0):
        command += ["-ss", str(request["trim_start"])]
    command += ["-i", str(source)]
    if "trim_duration" in request:
        command += ["-t", str(request["trim_duration"])]
    graph = filter_hlg_to_sdr(video, nvenc) if request.get("_hlg_to_sdr") else filter_chain(video, request["output_mode"], with_lut, nvenc)
    command += ["-map", "0:v:0", "-map", "0:a?", "-map_metadata", "-1", "-map_chapters", "-1", "-vf", graph]
    if nvenc:
        command += ["-c:v", "hevc_nvenc", "-profile:v", "main10", "-preset", "p5", "-tune", "hq",
                    "-rc", "vbr", "-cq", "18", "-b:v", "0", "-pix_fmt", "p010le"]
    else:
        command += ["-c:v", "libx265", "-profile:v", "main10", "-preset", "fast", "-crf", "18",
                    "-pix_fmt", "yuv420p10le", "-x265-params", "log-level=error:pools=4"]
    if request["output_mode"] == "hlg":
        command += ["-color_primaries", "bt2020", "-color_trc", "arib-std-b67", "-colorspace", "bt2020nc"]
    else:
        command += ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"]
    command += ["-color_range", "tv", "-c:a", "aac", "-b:a", "192k", "-tag:v", "hvc1",
                "-movflags", "+faststart+write_colr", "-progress", "pipe:1", "-nostats", str(staging)]
    return command


def verify_output(path: Path, source_video: dict, expected_duration: float, mode: str,
                  request: dict) -> dict:
    if _cancelled(request):
        raise Cancelled("用户取消")
    output = probe_video(path)
    expected_tags = ("bt2020", "arib-std-b67", "bt2020nc") if mode == "hlg" else ("bt709", "bt709", "bt709")
    actual_tags = (output["color_primaries"], output["color_transfer"], output["color_space"])
    if output["codec"] != "hevc" or output["bit_depth"] != 10 or actual_tags != expected_tags:
        raise RestoreError("输出视频的编码、位深或色彩标记不正确")
    if output["duration_seconds"] <= 0 or (expected_duration > 0 and abs(output["duration_seconds"] - expected_duration) > 0.35):
        raise RestoreError("输出视频时长与原片不一致")
    if source_video["audio_streams"] != output["audio_streams"]:
        raise RestoreError("输出音轨数与原片不一致")
    ffmpeg = find_tool("ffmpeg")
    assert ffmpeg
    try:
        check = subprocess.run([ffmpeg, "-v", "error", "-nostdin", "-i", str(path), "-t", "1",
                                "-map", "0:v:0", "-map", "0:a?", "-f", "null", "-"],
                               capture_output=True, timeout=45, creationflags=NO_WINDOW)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RestoreError("输出解码检查失败：" + str(exc)) from exc
    if check.returncode:
        raise RestoreError("输出无法正常解码：" + check.stderr.decode("utf-8", "replace")[-1500:])
    return {"codec_and_color_tags": True, "duration_and_audio": True,
            "first_second_decode": True, "video": output,
            "mimo_visual_match_verified": False}


def render_item(item: dict, request: dict, index: int, emit: Callable, available_encoders: set[str]) -> dict:
    source = Path(item["path"])
    if not source.is_file() or source.suffix.lower() not in VIDEO_EXTENSIONS:
        raise RestoreError("原片不存在或格式不受支持")
    detected = inspect(source)
    if detected["status"] == "error" or detected.get("video") is None:
        raise RestoreError("原片探测失败：" + "; ".join(detected["warnings"]))
    profile = detected["color_profile"] if item["profile"] == "auto" else item["profile"]
    if profile == "unknown":
        raise RestoreError("无法可靠识别拍摄模式，请明确选择 D-Log 或 D-Log 2")
    if profile not in {"dlog", "dlog2", "hlg", "rec709"}:
        raise RestoreError("当前不支持此拍摄模式")
    mode = request["output_mode"]
    if profile == "rec709" and mode == "hlg":
        raise RestoreError("普通 SDR 转 HDR 未开放；请选择原始 Log 或 HLG 素材")
    request = {**request, "_hlg_to_sdr": profile == "hlg" and mode == "sdr"}
    video = detected["video"]
    expected_duration = max(0.0, video["duration_seconds"] - request.get("trim_start", 0))
    if expected_duration <= 0:
        raise RestoreError("测试起点超出视频时长，或原片时长未知")
    if "trim_duration" in request:
        expected_duration = min(expected_duration, request["trim_duration"])
    lut = ASSETS / "luts" / f"{profile}_{mode}.cube" if profile in {"dlog", "dlog2"} else None
    if lut and not lut.is_file():
        raise RestoreError("此模式的还原转换尚不可用")
    shaper = ASSETS / "luts" / f"{profile}_hlg_shaper.cube" if lut and mode == "hlg" else None
    if shaper and not shaper.is_file():
        raise RestoreError("HDR 暗部精度转换资源未就绪")
    directory = Path(request["output_dir"])
    directory.mkdir(parents=True, exist_ok=True)
    output = choose_output(source, directory, mode)
    staging = directory / (".pocket_restore_" + uuid.uuid4().hex + ".mp4")
    stat_before = source.stat()
    emit({"type": "item_started", "index": index, "source": str(source), "output": str(output),
          "profile": profile, "source_mode": detected["color_profile"], "mode": mode})
    encoder = "hevc_nvenc" if request["encoder"] == "auto" and "hevc_nvenc" in available_encoders else "libx265"
    if encoder not in available_encoders:
        raise RestoreError("未找到可用的 10-bit HEVC 编码器")
    ffmpeg = find_tool("ffmpeg")
    assert ffmpeg
    try:
        with tempfile.TemporaryDirectory(prefix="pocket_restore_") as scratch:
            scratch_path = Path(scratch)
            if lut:
                shutil.copyfile(lut, scratch_path / "transform.cube")
            if shaper:
                shutil.copyfile(shaper, scratch_path / "shaper.cube")
            try:
                _stream_process(_command(ffmpeg, source, staging, video, request, bool(lut), encoder == "hevc_nvenc"),
                                scratch_path, request, index, expected_duration, emit)
            except RestoreError as exc:
                if isinstance(exc, Cancelled) or encoder != "hevc_nvenc" or "libx265" not in available_encoders:
                    raise
                staging.unlink(missing_ok=True)
                emit({"type": "encoder_fallback", "index": index, "encoder": "libx265", "reason": str(exc)})
                encoder = "libx265"
                _stream_process(_command(ffmpeg, source, staging, video, request, bool(lut), False),
                                scratch_path, request, index, expected_duration, emit)
        verification = verify_output(staging, video, expected_duration, mode, request)
        if _cancelled(request):
            raise Cancelled("用户取消")
        stat_after = source.stat()
        if (stat_before.st_size, stat_before.st_mtime_ns) != (stat_after.st_size, stat_after.st_mtime_ns):
            raise RestoreError("处理期间原片发生变化，未提交输出")
        # On Windows rename fails if another job has taken the output name.
        for attempt in range(100):
            try:
                if os.name == "nt":
                    staging.rename(output)
                else:
                    os.link(staging, output)
                    staging.unlink()
                break
            except FileExistsError:
                output = choose_output(source, directory, mode)
        else:
            raise RestoreError("无法安全提交输出文件")
        emit({"type": "progress", "index": index, "fraction": 1.0, "processed_seconds": expected_duration})
        return {"index": index, "output": str(output), "profile": profile,
                "encoder": encoder, "verification": verification}
    finally:
        staging.unlink(missing_ok=True)


def run_job(request: dict, emit: Callable) -> dict:
    request = validate_request(request)
    if not find_tool("ffmpeg") or not find_tool("ffprobe"):
        raise RestoreError("需要可用的 ffmpeg 和 ffprobe")
    available_encoders = _encoders()
    total = len(request["files"])
    succeeded = failed = 0
    cancelled = False
    results = []
    emit({"type": "job_started", "job_id": request["job_id"], "total": total})
    for index, item in enumerate(request["files"]):
        if _cancelled(request):
            cancelled = True
            break
        try:
            result = render_item(item, request, index, emit, available_encoders)
            results.append(result)
            succeeded += 1
            emit({"type": "item_done", **result})
        except Cancelled:
            cancelled = True
            break
        except (RestoreError, OSError, ValueError) as exc:
            failed += 1
            emit({"type": "item_error", "index": index, "source": item["path"], "error": str(exc)})
    if cancelled:
        emit({"type": "job_cancelled", "job_id": request["job_id"]})
    summary = {"type": "job_done", "job_id": request["job_id"], "total": total,
               "succeeded": succeeded, "failed": failed, "cancelled": cancelled}
    emit(summary)
    return {**summary, "results": results}
