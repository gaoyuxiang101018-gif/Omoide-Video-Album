"""Local, synchronous bridge to the separately packaged PocketRestoreCore CLI.

Call ``run_export`` from a worker thread. The event callback runs on that same
thread; a GUI should forward events through its own signals.
"""

from __future__ import annotations

import collections
import json
import logging
import os
from pathlib import Path
import queue
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
from typing import Callable
import uuid


LOGGER = logging.getLogger(__name__)
DEVELOPMENT_CORE_DIR = Path(__file__).resolve().parent / 'restore'
CAPABILITIES_TIMEOUT_SECONDS = 30.0
EXPORT_STARTUP_TIMEOUT_SECONDS = 120.0
EXPORT_IDLE_TIMEOUT_SECONDS = 600.0
CANCEL_GRACE_SECONDS = 45.0
POLL_SECONDS = 0.1
MAX_EVENT_LINE_LENGTH = 1_048_576

CATEGORY_PROFILES = {
    "DLog": "dlog",
    "DLog2": "dlog2",
    "HDR_HLG": "hlg",
    "Normal10": "rec709",
    "Normal8": "rec709",
}
MANUAL_PROFILES = frozenset({"dlog", "dlog2", "hlg", "rec709"})
OUTPUT_MODES = frozenset({"sdr", "hlg"})


def _application_roots() -> list[Path]:
    if getattr(sys, "frozen", False):
        roots = [Path(os.environ.get('OMOIDE_INSTALL_DIR', str(Path(sys.executable).resolve().parent))) / 'pocketfilm', Path(sys.executable).resolve().parent]
        bundle_root = getattr(sys, "_MEIPASS", None)
        if bundle_root:
            roots.append(Path(bundle_root).resolve())
    else:
        roots = [Path(__file__).resolve().parent]
    return list(dict.fromkeys(roots))


def _resolve_backend() -> tuple[list[str], Path] | None:
    """A packaged GUI never attempts to execute itself as a Python runtime."""
    roots = _application_roots()
    for root in roots:
        for name in ("PocketRestoreCore.exe", "PocketRestoreCoreCLI.exe"):
            candidate = root / "restore" / name
            if candidate.is_file():
                return [str(candidate)], candidate.parent

    if getattr(sys, "frozen", False):
        return None

    for root in roots:
        candidate = root / "restore" / "pocket_restore_cli.py"
        if candidate.is_file():
            return [sys.executable, str(candidate)], candidate.parent

    for name in ("PocketRestoreCore.exe", "PocketRestoreCoreCLI.exe"):
        candidate = DEVELOPMENT_CORE_DIR / name
        if candidate.is_file():
            return [str(candidate)], candidate.parent
    candidate = DEVELOPMENT_CORE_DIR / "pocket_restore_cli.py"
    if candidate.is_file():
        return [sys.executable, str(candidate)], candidate.parent
    return None


def _safe_log_text(value: str) -> str:
    text = value[:4096]
    text = re.sub(r"\bsk-[A-Za-z0-9_-]+", "[credential removed]", text)
    text = re.sub(
        r"(?i)(bearer\s+)[^\s\"']+", r"\1[credential removed]", text
    )
    text = re.sub(
        r"(?i)(\b(?:api[_ -]?key|access[_ -]?token|password|secret)\b"
        r"[\"']?\s*[:=]\s*[\"']?)[^\s\"',;]+",
        r"\1[credential removed]",
        text,
    )
    return text.strip()


def _subprocess_options(cwd: Path) -> dict:
    environment = os.environ.copy()
    environment["PYTHONIOENCODING"] = "utf-8"
    environment["PYTHONUTF8"] = "1"
    options = {
        "cwd": str(cwd),
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "text": True,
        "encoding": "utf-8",
        "errors": "replace",
        "env": environment,
    }
    if os.name == "nt":
        options["creationflags"] = (
            subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
        )
    else:
        options["start_new_session"] = True
    return options


def _unavailable(reason: str) -> dict:
    return {
        "schema_version": 1,
        "available": False,
        "ffmpeg_available": False,
        "sdr_profiles": [],
        "hdr_profiles": [],
        "supported_output_modes": [],
        "unavailable_reason": reason,
        "hdr_unavailable_reason": reason,
    }


def capabilities() -> dict:
    """Return validated backend capabilities, including a stable availability flag."""
    backend = _resolve_backend()
    if backend is None:
        return _unavailable("还原组件尚未就绪，请检查软件目录中的 restore 文件夹。")
    command, cwd = backend
    try:
        completed = subprocess.run(
            [*command, "capabilities"],
            timeout=CAPABILITIES_TIMEOUT_SECONDS,
            check=False,
            **_subprocess_options(cwd),
        )
    except subprocess.TimeoutExpired:
        return _unavailable("还原组件读取能力超时。")
    except OSError as error:
        LOGGER.warning("Cannot start restore capabilities: %s", _safe_log_text(str(error)))
        return _unavailable("无法启动还原组件。")

    if completed.stderr:
        for line in completed.stderr.splitlines():
            LOGGER.warning("Restore capabilities: %s", _safe_log_text(line))
    if completed.returncode != 0:
        return _unavailable("还原组件未能返回可用能力。")
    try:
        payload = json.loads(completed.stdout.lstrip("\ufeff"))
    except (json.JSONDecodeError, TypeError):
        return _unavailable("还原组件返回的能力信息格式无效。")
    if not isinstance(payload, dict) or payload.get("schema_version") != 1:
        return _unavailable("还原组件接口版本不兼容。")
    for name in ("sdr_profiles", "hdr_profiles", "supported_output_modes"):
        if not isinstance(payload.get(name), list) or not all(
            isinstance(item, str) for item in payload[name]
        ):
            return _unavailable("还原组件返回的能力信息不完整。")
    if not isinstance(payload.get("ffmpeg_available"), bool):
        return _unavailable("还原组件返回的编码器状态无效。")

    result = dict(payload)
    result["available"] = payload["ffmpeg_available"]
    if not result["available"]:
        result["unavailable_reason"] = "还原组件缺少可用的视频编码器。"
    if "hlg" not in payload["supported_output_modes"] or not payload["hdr_profiles"]:
        result["hdr_unavailable_reason"] = (
            payload.get("hdr_unavailable_reason") or "此还原组件暂不支持 HDR 导出。"
        )
    else:
        result["hdr_unavailable_reason"] = payload.get("hdr_unavailable_reason")
    return result


def _prepare_files(files: list[dict]) -> list[dict]:
    if not isinstance(files, list) or not files:
        raise ValueError("请先选择需要导出的视频。")
    prepared = []
    seen: set[str] = set()
    for item in files:
        if not isinstance(item, dict):
            raise ValueError("视频选择信息格式无效。")
        path_value = item.get("path")
        if not isinstance(path_value, (str, os.PathLike)) or not str(path_value).strip():
            raise ValueError("视频路径不能为空。")
        path = Path(path_value).expanduser().resolve()
        if not path.is_file():
            raise ValueError(f"找不到视频文件：{path.name}")
        current_stat = path.stat()
        if (item.get("size") is not None and current_stat.st_size != item["size"]) or (
            item.get("mtime_ns") is not None and current_stat.st_mtime_ns != item["mtime_ns"]
        ):
            raise ValueError(f"原片在扫描后已改变，请重新扫描后再还原：{path.name}")
        category = item.get("category", "Unknown")
        if category == "HDR_PQ":
            raise ValueError(f"暂不支持此 PQ 视频的还原：{path.name}")
        if not isinstance(category, str):
            raise ValueError(f"视频分类信息无效：{path.name}")
        manual_profile = item.get("manual_profile")
        if manual_profile is not None and (
            not isinstance(manual_profile, str) or manual_profile not in MANUAL_PROFILES
        ):
            raise ValueError(f"手动指定的颜色模式无效：{path.name}")
        profile = manual_profile or CATEGORY_PROFILES.get(category)
        if profile is None:
            raise ValueError(f"请先为无法识别的视频明确选择颜色模式：{path.name}")
        key = os.path.normcase(str(path))
        if key not in seen:
            prepared.append({"path": str(path), "profile": profile})
            seen.add(key)
    return prepared


class _ProcessTree:
    """Keep a task's child encoders together for exceptional watchdog cleanup."""

    def __init__(self, process: subprocess.Popen):
        self.process = process
        self._job = None
        self._kernel32 = None
        if os.name == "nt":
            self._attach_windows_job()

    def _attach_windows_job(self) -> None:
        import ctypes
        from ctypes import wintypes

        class BasicLimit(ctypes.Structure):
            _fields_ = [
                ("per_process_time", ctypes.c_longlong),
                ("per_job_time", ctypes.c_longlong),
                ("limit_flags", wintypes.DWORD),
                ("minimum_working_set", ctypes.c_size_t),
                ("maximum_working_set", ctypes.c_size_t),
                ("active_process_limit", wintypes.DWORD),
                ("affinity", ctypes.c_size_t),
                ("priority_class", wintypes.DWORD),
                ("scheduling_class", wintypes.DWORD),
            ]

        class IoCounters(ctypes.Structure):
            _fields_ = [(name, ctypes.c_ulonglong) for name in (
                "read_operations", "write_operations", "other_operations",
                "read_bytes", "write_bytes", "other_bytes",
            )]

        class ExtendedLimit(ctypes.Structure):
            _fields_ = [
                ("basic", BasicLimit),
                ("io", IoCounters),
                ("process_memory_limit", ctypes.c_size_t),
                ("job_memory_limit", ctypes.c_size_t),
                ("peak_process_memory", ctypes.c_size_t),
                ("peak_job_memory", ctypes.c_size_t),
            ]

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        kernel32.SetInformationJobObject.argtypes = [
            wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
        ]
        kernel32.SetInformationJobObject.restype = wintypes.BOOL
        kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
        kernel32.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
        kernel32.TerminateJobObject.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
        job = kernel32.CreateJobObjectW(None, None)
        if not job:
            return
        limits = ExtendedLimit()
        limits.basic.limit_flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.
        success = kernel32.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits))
        if success:
            success = kernel32.AssignProcessToJobObject(job, wintypes.HANDLE(int(self.process._handle)))
        if not success:
            kernel32.CloseHandle(job)
            LOGGER.warning("Restore watchdog could not attach a Windows job (%s).", ctypes.get_last_error())
            return
        self._job, self._kernel32 = job, kernel32

    def stop_unresponsive(self) -> None:
        """Only used after the cooperative cancel marker has exceeded its grace period."""
        if self.process.poll() is not None:
            return
        if self._job:
            self._kernel32.TerminateJobObject(self._job, 1)
        elif os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(self.process.pid), "/T", "/F"],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW,
                timeout=15, check=False,
            )
        else:
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def close(self) -> None:
        if self._job:
            self._kernel32.CloseHandle(self._job)
            self._job = None


def _read_stdout(stream, messages: queue.Queue) -> None:
    try:
        for line in stream:
            messages.put(("line", line))
    except (OSError, ValueError) as error:
        messages.put(("read_error", _safe_log_text(str(error))))
    finally:
        messages.put(("eof", None))


def _read_stderr(stream, tail: collections.deque) -> None:
    try:
        for line in stream:
            sanitized = _safe_log_text(line)
            if sanitized:
                tail.append(sanitized)
                LOGGER.warning("Restore backend: %s", sanitized)
    except (OSError, ValueError):
        pass


def _result(job_id: str, total: int) -> dict:
    return {
        "schema_version": 1,
        "job_id": job_id,
        "status": "failed",
        "succeeded": 0,
        "failed": 0,
        "total": total,
        "cancelled": False,
        "exit_code": None,
        "error": None,
        "warnings": [],
        "events": [],
    }


def run_export(
    files: list[dict],
    output_dir: str,
    output_mode: str,
    on_event: Callable[[dict], None],
    cancel: threading.Event,
) -> dict:
    """Export selected files without changing sources; return a terminal summary.

    ``files`` entries require ``path`` and ``category``. An unknown category needs
    an explicit ``manual_profile``. Output modes are ``sdr`` and ``hlg``. Unknown
    and unsupported modes fail before launching the backend. Normal cancellation
    uses the backend's cancel marker, allowing it to clean up temporary outputs.
    """
    job_id = uuid.uuid4().hex
    result = _result(job_id, len(files) if isinstance(files, list) else 0)
    if not callable(on_event) or not isinstance(cancel, threading.Event):
        result["error"] = "导出事件或取消参数无效。"
        return result
    if cancel.is_set():
        result.update(status="cancelled", cancelled=True)
        return result
    try:
        if not isinstance(output_mode, str) or output_mode not in OUTPUT_MODES:
            raise ValueError("导出模式必须是普通 SDR 或 HDR HLG。")
        prepared_files = _prepare_files(files)
        result["total"] = len(prepared_files)
        if not isinstance(output_dir, (str, os.PathLike)) or not str(output_dir).strip():
            raise ValueError("请选择导出目录。")
        output_path = Path(output_dir).expanduser().resolve()
        if output_path.exists() and not output_path.is_dir():
            raise ValueError("导出路径不是文件夹。")
    except (ValueError, OSError, RuntimeError) as error:
        result["error"] = str(error)
        return result

    backend = _resolve_backend()
    if backend is None:
        result["error"] = "还原组件尚未就绪，请检查软件目录中的 restore 文件夹。"
        return result
    available = capabilities()
    if not available.get("available"):
        result["error"] = available.get("unavailable_reason", "还原组件不可用。")
        return result
    if output_mode not in available.get("supported_output_modes", []):
        result["error"] = available.get("hdr_unavailable_reason") or "此导出模式尚不可用。"
        return result
    supported_profiles = available.get("hdr_profiles" if output_mode == "hlg" else "sdr_profiles", [])
    if any(item["profile"] not in supported_profiles for item in prepared_files):
        result["error"] = "所选视频包含该导出模式暂不支持的颜色模式。"
        return result

    command, cwd = backend
    process = None
    process_tree = None
    readers: list[threading.Thread] = []
    terminal = None
    saw_cancelled = False
    cancel_sent_at = None
    last_event_at = time.monotonic()
    started_at = last_event_at
    received_event = False
    callback_failed = False
    stdout_eof = False
    stderr_tail: collections.deque[str] = collections.deque(maxlen=20)
    messages: queue.Queue = queue.Queue()

    with tempfile.TemporaryDirectory(prefix="pocketfilm-export-") as job_directory:
        request_path = Path(job_directory) / "request.json"
        cancel_path = Path(job_directory) / "cancel"

        def request_cancel(reason: str | None = None) -> None:
            nonlocal cancel_sent_at
            if reason and not result["error"]:
                result["error"] = reason
            if cancel_sent_at is None:
                cancel_path.touch(exist_ok=True)
                cancel_sent_at = time.monotonic()

        try:
            output_path.mkdir(parents=True, exist_ok=True)
            request = {
                "schema_version": 1,
                "job_id": job_id,
                "files": prepared_files,
                "output_dir": str(output_path),
                "output_mode": output_mode,
                "look": "standard",
                "encoder": "auto",
                "cancel_file": str(cancel_path),
            }
            request_path.write_text(json.dumps(request, ensure_ascii=False), encoding="utf-8")
            process = subprocess.Popen(
                [*command, "restore", "--request", str(request_path)],
                **_subprocess_options(cwd),
            )
            process_tree = _ProcessTree(process)
            readers = [
                threading.Thread(target=_read_stdout, args=(process.stdout, messages), daemon=True),
                threading.Thread(target=_read_stderr, args=(process.stderr, stderr_tail), daemon=True),
            ]
            for reader in readers:
                reader.start()

            while True:
                now = time.monotonic()
                if cancel.is_set():
                    request_cancel()
                if cancel_sent_at is None:
                    if not received_event and now - started_at > EXPORT_STARTUP_TIMEOUT_SECONDS:
                        request_cancel("还原组件启动超时，已请求停止任务。")
                    elif received_event and now - last_event_at > EXPORT_IDLE_TIMEOUT_SECONDS:
                        request_cancel("还原组件长时间未报告进度，已请求停止任务。")
                elif now - cancel_sent_at > CANCEL_GRACE_SECONDS and process.poll() is None:
                    result["error"] = (
                        (result["error"] + " ") if result["error"] else ""
                    ) + "还原组件未响应停止请求，已停止该任务的进程。请检查未完成的输出。"
                    process_tree.stop_unresponsive()
                    process.wait(timeout=15)
                    break

                try:
                    kind, value = messages.get(timeout=POLL_SECONDS)
                except queue.Empty:
                    if process.poll() is not None and stdout_eof:
                        break
                    continue
                if kind == "eof":
                    stdout_eof = True
                    if process.poll() is not None and messages.empty():
                        break
                    continue
                if kind == "read_error":
                    request_cancel("无法读取还原组件的进度信息。")
                    continue
                if len(value) > MAX_EVENT_LINE_LENGTH:
                    result["warnings"].append("忽略了一条过大的还原进度消息。")
                    continue
                try:
                    event = json.loads(value.lstrip("\ufeff"))
                    if not isinstance(event, dict) or not isinstance(event.get("type"), str):
                        raise ValueError("Invalid event")
                except (json.JSONDecodeError, ValueError, TypeError):
                    if value.strip():
                        if "忽略了无法解析的还原进度消息。" not in result["warnings"]:
                            result["warnings"].append("忽略了无法解析的还原进度消息。")
                        LOGGER.warning("Restore backend returned malformed progress JSON.")
                    continue
                received_event = True
                last_event_at = time.monotonic()
                if event["type"] != "progress":
                    result["events"].append(event)
                if event["type"] == "job_done":
                    terminal = event
                elif event["type"] == "job_cancelled":
                    saw_cancelled = True
                elif event["type"] == "job_error":
                    result["error"] = _safe_log_text(str(event.get("error", "还原组件拒绝了导出任务。")))
                if not callback_failed:
                    try:
                        on_event(event)
                    except Exception:
                        callback_failed = True
                        LOGGER.warning("Restore progress callback failed; requesting cancellation.")
                        request_cancel("界面未能接收导出进度，已请求停止任务。")

            result["exit_code"] = process.wait(timeout=15)
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
            LOGGER.warning("Restore adapter failure: %s", _safe_log_text(str(error)))
            if not result["error"]:
                result["error"] = "导出任务无法继续，请检查还原组件和导出目录。"
            if process is not None and process.poll() is None:
                try:
                    request_cancel()
                    process.wait(timeout=CANCEL_GRACE_SECONDS)
                except (OSError, subprocess.TimeoutExpired):
                    if process_tree is not None:
                        process_tree.stop_unresponsive()
                        process.wait(timeout=15)
            if process is not None:
                result["exit_code"] = process.poll()
        finally:
            if process_tree is not None:
                process_tree.close()
            for reader in readers:
                reader.join(timeout=5)
            if process is not None:
                if process.stdout:
                    process.stdout.close()
                if process.stderr:
                    process.stderr.close()

    if terminal is not None:
        for name in ("succeeded", "failed"):
            value = terminal.get(name)
            if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= result["total"]:
                result[name] = value
            else:
                result["error"] = result["error"] or "还原组件返回的完成统计无效。"
        if terminal.get("total") != result["total"]:
            result["error"] = result["error"] or "还原组件返回的视频数量与任务不一致。"
        if not saw_cancelled and result["succeeded"] + result["failed"] != result["total"]:
            result["error"] = result["error"] or "还原组件未处理全部选中的视频。"
    elif not saw_cancelled and not result["error"]:
        result["error"] = "还原组件未返回完整的完成信息。"
    if terminal is None:
        result["succeeded"] = len({
            event.get("index") for event in result["events"]
            if event["type"] == "item_done" and isinstance(event.get("index"), int)
        })
        result["failed"] = len({
            event.get("index") for event in result["events"]
            if event["type"] == "item_error" and isinstance(event.get("index"), int)
        })

    if result["error"]:
        result["status"] = "failed"
    elif saw_cancelled:
        result.update(status="cancelled", cancelled=True)
    elif result["exit_code"] != 0 and not (terminal is not None and result["failed"]):
        result["error"] = "还原组件异常退出，请检查导出结果。"
        result["status"] = "failed"
    elif result["failed"]:
        result["status"] = "partial" if result["succeeded"] else "failed"
    else:
        result["status"] = "completed"
    return result
