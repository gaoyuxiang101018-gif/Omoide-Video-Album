"""Read-only video discovery and metadata classification for PocketFilm.

DJI QuickTime Keys values and camera fields were checked against:
https://github.com/erik-sutton95/dji-clip-color (Apache-2.0).
The optional djmd paths / enums (2=D-Log, 22=D-Log2) were checked against:
https://github.com/TzRay/dlog_color_classifier (MIT).
These are reverse-engineered metadata rules, not a DJI schema guarantee.
No filename, pixel appearance, or missing-field fallback selects a Log mode.
"""

from __future__ import annotations

import json
import math
import os
import re
import stat
import struct
import subprocess
from dataclasses import dataclass, field
from fractions import Fraction
from pathlib import Path
from typing import BinaryIO, Callable, Iterable, Iterator

CLASSIFIER_VERSION = "1.0.1"

VIDEO_EXTENSIONS = frozenset({
    ".mp4", ".mov", ".m4v", ".mkv", ".avi", ".mts", ".m2ts", ".webm",
    ".wmv", ".mpg", ".mpeg", ".ts", ".3gp", ".mxf", ".lrf", ".lrv", ".xrf",
})
PROXY_EXTENSIONS = frozenset({".lrf", ".lrv", ".xrf"})
GAMMA_KEYS = ("com.dji.camera.ColorGammaSxS", "DjiCameraColorGammaSxS")
CAMERA_KEYS = ("com.dji.camera.CameraModel", "com.apple.quicktime.model", "\xa9mdl")
_WANTED_KEYS = frozenset(GAMMA_KEYS + CAMERA_KEYS)
_CONTAINERS = frozenset({"moov", "udta", "meta", "trak", "mdia", "minf", "stbl"})
_MAX_READ_BYTES = 4 * 1024 * 1024
_MAX_METADATA_BYTES = 1024 * 1024
_MAX_PACKET_BYTES = 256 * 1024
_MAX_BOXES = 20000
_MAX_DEPTH = 12
# DJI's manufacturer-submitted SGS report identifies PP-041 as Osmo Pocket 4P.
# https://fccid.io/m/fe8f41e196bbb7de8beb75d8731d328e86e8c5579d308b1b6f85146cb9c6cc8d.pdf
_CAMERA_MODEL_ALIASES = {"PP-041": "DJI Osmo Pocket 4P"}


def _cancelled(cancel) -> bool:
    if cancel is None:
        return False
    if callable(cancel):
        return bool(cancel())
    return bool(cancel.is_set())


def _is_link(st) -> bool:
    return stat.S_ISLNK(st.st_mode) or bool(
        getattr(st, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    )


def _file_identity(path: str, st) -> tuple | str:
    # Windows DirEntry.stat caches FindFirstFile data, whose file ID is always 0.
    # A separate stat call obtains the real ID and permits hardlink deduplication.
    if not st.st_ino:
        try:
            st = os.stat(path, follow_symlinks=False)
        except OSError:
            pass
    return (st.st_dev, st.st_ino) if st.st_ino else os.path.normcase(os.path.realpath(path))


def discover_videos(roots: Iterable[str | os.PathLike], recursive: bool = True, cancel=None,
                    include_proxies: bool = False) -> Iterator[str]:
    """Yield absolute paths once, without traversing symlinks or Windows junctions.

    Overlapping roots and hardlinks are deduplicated. Inaccessible / missing roots
    or entries are skipped; callers should validate selected roots in their UI.
    ``cancel`` accepts a callable or a threading.Event and is checked per entry.
    A root may also be an individual video file. Directory symlinks are skipped
    even when they are passed as a root, so a scan cannot leave selected trees.
    DJI LRF/LRV/XRF proxies are excluded unless ``include_proxies=True``.
    """
    if isinstance(roots, (str, os.PathLike)):
        roots = [roots]
    pending = [os.path.abspath(os.fspath(root)) for root in roots]
    extensions = VIDEO_EXTENSIONS if include_proxies else VIDEO_EXTENSIONS - PROXY_EXTENSIONS
    seen_dirs: set[tuple | str] = set()
    seen_files: set[tuple | str] = set()
    while pending and not _cancelled(cancel):
        path = pending.pop()
        try:
            st = os.lstat(path)
        except OSError:
            continue
        if _is_link(st):
            continue
        identity = (st.st_dev, st.st_ino) if st.st_ino else os.path.normcase(os.path.realpath(path))
        if stat.S_ISREG(st.st_mode):
            if Path(path).suffix.casefold() in extensions and identity not in seen_files:
                seen_files.add(identity)
                yield path
            continue
        if not stat.S_ISDIR(st.st_mode) or identity in seen_dirs:
            continue
        seen_dirs.add(identity)
        try:
            with os.scandir(path) as entries:
                for entry in entries:
                    if _cancelled(cancel):
                        return
                    try:
                        child_stat = entry.stat(follow_symlinks=False)
                    except OSError:
                        continue
                    if _is_link(child_stat):
                        continue
                    if stat.S_ISDIR(child_stat.st_mode):
                        if recursive:
                            pending.append(entry.path)
                    elif stat.S_ISREG(child_stat.st_mode) and Path(entry.name).suffix.casefold() in extensions:
                        child_id = _file_identity(entry.path, child_stat)
                        if child_id not in seen_files:
                            seen_files.add(child_id)
                            yield os.path.abspath(entry.path)
        except OSError:
            continue


class MetadataError(ValueError):
    """Invalid or deliberately bounded ISO BMFF metadata."""


@dataclass
class _Box:
    kind: str
    start: int
    payload: int
    end: int
    children: list["_Box"] = field(default_factory=list)


class _BMFFReader:
    def __init__(self, handle: BinaryIO, size: int):
        self.handle, self.size = handle, size
        self.bytes_read = 0
        self.boxes_read = 0

    def read(self, offset: int, length: int) -> bytes:
        if offset < 0 or length < 0 or offset + length > self.size:
            raise MetadataError("元数据偏移超出文件范围")
        if length > _MAX_METADATA_BYTES or self.bytes_read + length > _MAX_READ_BYTES:
            raise MetadataError("元数据超过安全读取上限")
        self.handle.seek(offset)
        data = self.handle.read(length)
        self.bytes_read += len(data)
        if len(data) != length:
            raise MetadataError("元数据不完整")
        return data

    def header(self, offset: int, end: int) -> _Box:
        self.boxes_read += 1
        if self.boxes_read > _MAX_BOXES:
            raise MetadataError("容器结构超过解析上限")
        if offset + 8 > end:
            raise MetadataError("容器头不完整")
        length, kind = struct.unpack(">I4s", self.read(offset, 8))
        header_size = 8
        if length == 1:
            if offset + 16 > end:
                raise MetadataError("64位容器头不完整")
            length = struct.unpack(">Q", self.read(offset + 8, 8))[0]
            header_size = 16
        elif length == 0:
            length = end - offset
        if length < header_size or offset + length > end:
            raise MetadataError("容器大小无效或超出父容器")
        return _Box(kind.decode("latin1"), offset, offset + header_size, offset + length)

    def children(self, start: int, end: int, depth: int = 0) -> list[_Box]:
        if depth > _MAX_DEPTH:
            raise MetadataError("容器嵌套超过解析上限")
        boxes = []
        offset = start
        while offset + 8 <= end:
            box = self.header(offset, end)
            if box.kind in _CONTAINERS:
                child_start = box.payload
                if box.kind == "meta" and box.end - box.payload >= 8:
                    prefix = self.read(box.payload, 8)
                    direct_size = struct.unpack_from(">I", prefix)[0]
                    # ISO meta has a 4-byte version/flags; DJI QT meta may omit it.
                    if not (8 <= direct_size <= box.end - box.payload):
                        child_start += 4
                box.children = self.children(child_start, box.end, depth + 1)
            boxes.append(box)
            offset = box.end
        return boxes


def _direct(box: _Box, kind: str) -> _Box | None:
    return next((child for child in box.children if child.kind == kind), None)


def _path(box: _Box, *kinds: str) -> _Box | None:
    for kind in kinds:
        box = _direct(box, kind)
        if box is None:
            return None
    return box


def _decode_text(raw: bytes, data_type: int = 1) -> str | None:
    try:
        if data_type in (0, 1):
            text = raw.rstrip(b"\x00").decode("utf-8")
        elif data_type == 2:
            text = raw.decode("utf-16-be").rstrip("\x00")
        elif data_type in (21, 22) and 0 < len(raw) <= 8:
            text = str(int.from_bytes(raw, "big", signed=data_type == 21))
        else:
            return None
    except UnicodeDecodeError:
        return None
    text = text.strip("\x00 \t\r\n")
    if not text or any(ord(char) < 32 for char in text):
        return None
    return text


def _keys(reader: _BMFFReader, box: _Box) -> dict[int, str]:
    raw = reader.read(box.payload, box.end - box.payload)
    if len(raw) < 8:
        raise MetadataError("QuickTime keys 不完整")
    count = struct.unpack_from(">I", raw, 4)[0]
    if count > 4096:
        raise MetadataError("QuickTime key 数量超出上限")
    names, offset = {}, 8
    for index in range(1, count + 1):
        if offset + 8 > len(raw):
            raise MetadataError("QuickTime key 条目不完整")
        length = struct.unpack_from(">I", raw, offset)[0]
        if length < 8 or offset + length > len(raw):
            raise MetadataError("QuickTime key 大小无效")
        name = _decode_text(raw[offset + 8:offset + length])
        if name in _WANTED_KEYS:
            names[index] = name
        offset += length
    return names


def _add_tag(tags: dict[str, list[str]], key: str, value: str | None):
    if value is not None and value not in tags.setdefault(key, []):
        tags[key].append(value)


def _collect_metadata(reader: _BMFFReader, boxes: list[_Box], tags: dict[str, list[str]]):
    for box in boxes:
        if box.kind == "meta":
            keys_box, ilst = _direct(box, "keys"), _direct(box, "ilst")
            if keys_box and ilst:
                names = _keys(reader, keys_box)
                for item in reader.children(ilst.payload, ilst.end):
                    index = int.from_bytes(item.kind.encode("latin1"), "big")
                    if index not in names:
                        continue
                    for child in reader.children(item.payload, item.end):
                        if child.kind == "data" and child.end - child.payload >= 8:
                            raw = reader.read(child.payload, child.end - child.payload)
                            data_type = struct.unpack_from(">I", raw)[0] & 0xFFFFFF
                            _add_tag(tags, names[index], _decode_text(raw[8:], data_type))
        elif box.kind == "\xa9mdl" and box.end - box.payload <= 512:
            raw = reader.read(box.payload, box.end - box.payload)
            value = _decode_text(raw)
            # DJI stores plain text; standard QT udta may prefix length/language.
            if value is None and len(raw) >= 4:
                text_length = struct.unpack_from(">H", raw)[0]
                if 0 < text_length <= len(raw) - 4:
                    value = _decode_text(raw[4:4 + text_length])
            _add_tag(tags, "\xa9mdl", value)
        if box.children:
            _collect_metadata(reader, box.children, tags)


def _first_djmd_packet(reader: _BMFFReader, top: list[_Box]) -> bytes | None:
    if any(box.kind == "moof" for box in top):
        return None  # Fragmented sample tables require a separate parser.
    for moov in (box for box in top if box.kind == "moov"):
        for track in (box for box in moov.children if box.kind == "trak"):
            stbl = _path(track, "mdia", "minf", "stbl")
            if stbl is None:
                continue
            stsd = _direct(stbl, "stsd")
            if stsd is None or stsd.end - stsd.payload < 8:
                continue
            entries = reader.children(stsd.payload + 8, stsd.end)
            if not any(box.kind == "djmd" for box in entries):
                continue
            stsc = _direct(stbl, "stsc")
            offsets = _direct(stbl, "stco") or _direct(stbl, "co64")
            stsz, stz2 = _direct(stbl, "stsz"), _direct(stbl, "stz2")
            if stsc is None or offsets is None or (stsz is None and stz2 is None):
                raise MetadataError("djmd sample table 缺失")
            if stsc.end - stsc.payload < 20:
                raise MetadataError("djmd stsc 不完整")
            raw = reader.read(stsc.payload, 20)
            count, first_chunk, samples_per_chunk, description = struct.unpack_from(">4I", raw, 4)
            if count < 1 or first_chunk != 1 or samples_per_chunk < 1:
                raise MetadataError("djmd 首个chunk映射不受支持")
            if not 1 <= description <= len(entries) or entries[description - 1].kind != "djmd":
                raise MetadataError("djmd 首个sample描述不匹配")
            offset_size = 8 if offsets.kind == "co64" else 4
            if offsets.end - offsets.payload < 8 + offset_size:
                raise MetadataError("djmd chunk offset 不完整")
            raw = reader.read(offsets.payload, 8 + offset_size)
            if struct.unpack_from(">I", raw, 4)[0] < 1:
                raise MetadataError("djmd 无chunk")
            offset = int.from_bytes(raw[8:], "big")
            if stsz is not None:
                if stsz.end - stsz.payload < 12:
                    raise MetadataError("djmd stsz 不完整")
                raw = reader.read(stsz.payload, 12)
                sample_size, sample_count = struct.unpack_from(">2I", raw, 4)
                if sample_count < 1:
                    raise MetadataError("djmd 无sample")
                if sample_size == 0:
                    if stsz.end - stsz.payload < 16:
                        raise MetadataError("djmd 首个sample大小缺失")
                    sample_size = struct.unpack(">I", reader.read(stsz.payload + 12, 4))[0]
            else:
                if stz2.end - stz2.payload < 13:
                    raise MetadataError("djmd stz2 不完整")
                raw = reader.read(stz2.payload, 12)
                field_size, sample_count = raw[7], struct.unpack_from(">I", raw, 8)[0]
                if sample_count < 1 or field_size not in (4, 8, 16):
                    raise MetadataError("djmd stz2 格式不受支持")
                raw = reader.read(stz2.payload + 12, 2 if field_size == 16 else 1)
                sample_size = raw[0] >> 4 if field_size == 4 else int.from_bytes(raw, "big")
            if not 0 < sample_size <= _MAX_PACKET_BYTES:
                raise MetadataError("djmd 首包超过读取上限或为空")
            if not any(box.kind == "mdat" and box.payload <= offset and offset + sample_size <= box.end for box in top):
                raise MetadataError("djmd sample不在媒体数据范围内")
            return reader.read(offset, sample_size)
    return None


def _varint(data: bytes, offset: int) -> tuple[int, int]:
    value = 0
    for shift in range(0, 70, 7):
        if offset >= len(data):
            break
        byte = data[offset]
        offset += 1
        value |= (byte & 127) << shift
        if byte < 128:
            return value, offset
    raise MetadataError("djmd varint不完整或过长")


def _proto_fields(data: bytes) -> list[tuple[int, int, int | bytes]]:
    fields, offset = [], 0
    while offset < len(data):
        key, offset = _varint(data, offset)
        number, wire = key >> 3, key & 7
        if number < 1:
            raise MetadataError("djmd字段号无效")
        if wire == 0:
            value, offset = _varint(data, offset)
        elif wire in (1, 2, 5):
            if wire == 2:
                length, offset = _varint(data, offset)
            else:
                length = 8 if wire == 1 else 4
            if offset + length > len(data):
                raise MetadataError("djmd字段超出首包")
            value = data[offset:offset + length]
            offset += length
        else:
            raise MetadataError("djmd wire类型不受支持")
        fields.append((number, wire, value))
        if len(fields) > 8192:
            raise MetadataError("djmd字段过多")
    return fields


def _proto_value(packet: bytes, path: tuple[int, ...], value_number: int) -> int | None:
    current = packet
    for number in path:
        nested = [value for field_number, wire, value in _proto_fields(current)
                  if field_number == number and wire == 2]
        if not nested:
            return None
        current = nested[0]
    values = [value for number, wire, value in _proto_fields(current) if number == value_number and wire == 0]
    if len(set(values)) > 1:
        raise MetadataError("djmd颜色字段存在冲突")
    return values[0] if values else None


def read_bmff_metadata(path: str | os.PathLike) -> dict:
    """Seek through ISO BMFF boxes; never read the movie's entire mdat.

    Return ``tags`` (known key -> list of values), ``gamma_enum``, ``record_mode``,
    ``warnings``, and ``bytes_read``. Corrupt/unsupported data becomes a warning.
    Read limits: total 4 MiB, any payload 1 MiB, first djmd packet 256 KiB,
    20,000 boxes and 12 nested levels. Supports faststart and tail moov, 64-bit
    sizes, QT/ISO meta, plain ©mdl, stco/co64 and stsz/stz2 first sample.
    """
    result = {"tags": {}, "gamma_enum": None, "record_mode": None, "warnings": [], "bytes_read": 0}
    reader = None
    try:
        with open(path, "rb") as handle:
            reader = _BMFFReader(handle, os.fstat(handle.fileno()).st_size)
            # Reject non-BMFF formats early. No arbitrary byte-string search.
            if reader.size < 8:
                return result
            kind = reader.read(4, 4)
            if kind not in (b"ftyp", b"moov", b"mdat", b"wide", b"free", b"skip", b"uuid"):
                return result
            top = reader.children(0, reader.size)
            _collect_metadata(reader, top, result["tags"])
            try:
                packet = _first_djmd_packet(reader, top)
                if packet:
                    result["gamma_enum"] = _proto_value(packet, (2, 2, 3), 1)
                    result["record_mode"] = _proto_value(packet, (2, 3), 5)
            except MetadataError as exc:
                result["warnings"].append(str(exc))
    except (OSError, MetadataError, struct.error) as exc:
        result["warnings"].append(str(exc))
    finally:
        if reader:
            result["bytes_read"] = reader.bytes_read
    return result


def normalize_profile(value: str | None) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip().casefold().replace("\u2011", "-").replace("\u2013", "-")
    aliases = {
        "d-log": "DLog", "dlog": "DLog", "d-log2": "DLog2", "d-log 2": "DLog2", "dlog2": "DLog2",
        "d-log m": "DLogM", "d-logm": "DLogM", "dlogm": "DLogM",
        "rec.709": "Normal", "rec709": "Normal", "rec. 709": "Normal", "normal": "Normal",
        "rec.2100 hlg": "HLG", "hlg": "HLG", "rec.2100 pq": "PQ", "pq": "PQ",
    }
    return aliases.get(text)


def _bit_depth(stream: dict) -> int | None:
    pix = str(stream.get("pix_fmt", "")).casefold()
    match = re.fullmatch(r"(?:yuv[a]?\d{3}|gbr[a]?)p(9|10|12|14|16)(?:le|be)", pix)
    if match:
        return int(match.group(1))
    match = re.fullmatch(r"p(010|012|016|210|212|216|410|412|416)(?:le|be)", pix)
    if match:
        return int(match.group(1)[-2:])
    if pix in {"yuv420p", "yuvj420p", "yuv422p", "yuvj422p", "yuv444p", "yuvj444p", "yuva420p", "gbrp", "gbrap", "nv12", "nv21", "rgb24", "bgr24", "rgba", "bgra", "gray"}:
        return 8
    if pix in {"rgb48le", "rgb48be", "rgba64le", "rgba64be", "gray16le", "gray16be"}:
        return 16
    if pix in {"gray10le", "gray10be", "x2rgb10le", "x2rgb10be", "x2bgr10le", "x2bgr10be"}:
        return 10
    for key in ("bits_per_raw_sample",):
        try:
            depth = int(stream.get(key, 0))
        except (ValueError, TypeError):
            continue
        if 1 <= depth <= 32:
            return depth
    return None


def classify_metadata(stream: dict, format_tags: dict | None = None, bmff: dict | None = None) -> dict:
    """Classify explicit source mode independently from the camera model.

    Rec.709 stream/VUI flags alone never confirm Normal mode. Log labels outrank
    generic Rec.709 tags. Conflicting explicit modes or HDR transfer flags are
    ``Unknown``. Camera names are copied from genuine model metadata only.
    """
    bmff = bmff or {}
    values: dict[str, list[str]] = {}
    evidence: list[str] = []
    for key, raw_values in bmff.get("tags", {}).items():
        for value in raw_values if isinstance(raw_values, list) else [raw_values]:
            _add_tag(values, key, str(value))
    for tags in (format_tags or {}, stream.get("tags", {}) or {}):
        for key, value in tags.items():
            # ffprobe may expose keys using their own spelling / capitalization.
            canonical = next((known for known in _WANTED_KEYS if known.casefold() == key.casefold()), None)
            if canonical:
                _add_tag(values, canonical, str(value))
    camera = "Unknown"
    raw_model = "Unknown"
    for key in CAMERA_KEYS:
        models = values.get(key, [])
        clean = [value for value in models if _decode_text(value.encode("utf-8"))]
        if clean:
            if len(set(clean)) == 1:
                raw_model = clean[0]
                camera = _CAMERA_MODEL_ALIASES.get(raw_model.upper(), raw_model)
                evidence.append(f"相机字段 {key}={raw_model}")
                if camera != raw_model:
                    evidence.append(f"型号映射 {raw_model}={camera}（DJI送检SGS报告 SZCR251100526406，FCC ID 2ANDR-PP041，第1/6页）")
            else:
                evidence.append(f"相机字段 {key} 存在冲突")
            break
    profiles: set[str] = set()
    unknown_label = False
    for key in GAMMA_KEYS:
        for value in values.get(key, []):
            evidence.append(f"颜色字段 {key}={value}")
            profile = normalize_profile(value)
            if profile:
                profiles.add(profile)
            else:
                unknown_label = True
    gamma_enum = bmff.get("gamma_enum")
    if gamma_enum is not None:
        evidence.append(f"djmd 2.2.3.1={gamma_enum}（已知逆向映射：2=D-Log，22=D-Log2）")
        enum_profile = {2: "DLog", 22: "DLog2"}.get(gamma_enum)
        if enum_profile:
            profiles.add(enum_profile)
    if bmff.get("record_mode") is not None:
        evidence.append(f"djmd record_mode={bmff['record_mode']}（不单独用于颜色分类）")
    transfer = str(stream.get("color_transfer") or "").casefold()
    hdr_profile = {"arib-std-b67": "HLG", "smpte2084": "PQ"}.get(transfer)
    if hdr_profile:
        evidence.append(f"视频传递函数 color_transfer={transfer}")
        profiles.add(hdr_profile)
    depth = _bit_depth(stream)
    if depth:
        evidence.append(f"视频位深={depth}bit，pix_fmt={stream.get('pix_fmt', '未标记')}")
    evidence.extend(f"读取提示：{message}" for message in bmff.get("warnings", []))
    if len(profiles) > 1:
        profile = "Unknown"
        evidence.append("颜色元数据存在冲突，需要确认拍摄模式")
    elif profiles and not unknown_label:
        profile = next(iter(profiles))
    else:
        profile = "Unknown"
        evidence.append("缺少可确认的拍摄模式；通用Rec.709标记不能排除DJI Log")
    category = {"DLog": "DLog", "DLog2": "DLog2", "DLogM": "DLogM", "HLG": "HDR_HLG", "PQ": "HDR_PQ"}.get(profile, "Unknown")
    if profile == "Normal" and depth in (8, 10):
        category = "Normal10" if depth == 10 else "Normal8"
    return {"camera": camera, "camera_raw": raw_model, "profile": profile, "category": category, "bit_depth": depth,
            "evidence": evidence, "status": "ok" if category != "Unknown" else "pending_review"}


def _number(value, default=0.0) -> float:
    try:
        result = float(Fraction(str(value)))
        return result if math.isfinite(result) else default
    except (ValueError, ZeroDivisionError, TypeError):
        return default


def probe_video(path: str | os.PathLike, ffprobe_path: str | os.PathLike = "ffprobe") -> dict:
    """Return JSON-serializable video information with no modification of inputs.

    Uses the first real video stream (``V:0`` excludes album-art/cover streams).
    ffprobe has a 30 second timeout; FFmpeg network protocols are disabled.
    Missing tools, damaged files, and no video stream return ``status=error``.
    Known proxy extensions stay Unknown even if they have familiar stream flags.
    """
    full = os.path.abspath(os.fspath(path))
    result = {
        "path": full, "name": os.path.basename(full), "folder": os.path.dirname(full),
        "size": 0, "mtime_ns": 0, "duration": 0.0, "width": 0, "height": 0,
        "fps": 0.0, "codec": "", "bit_depth": None, "color_primaries": "",
        "color_transfer": "", "color_space": "", "camera": "Unknown", "camera_raw": "Unknown", "profile": "Unknown",
        "category": "Unknown", "evidence": [], "status": "pending_review", "error": "",
    }
    try:
        st = os.stat(full)
        if not stat.S_ISREG(st.st_mode):
            raise OSError("不是普通文件")
        result.update(size=st.st_size, mtime_ns=st.st_mtime_ns)
    except OSError as exc:
        result.update(status="error", error=str(exc))
        return result
    bmff = read_bmff_metadata(full)
    result.update(classify_metadata({}, bmff=bmff))
    try:
        completed = subprocess.run(
            [os.fspath(ffprobe_path), "-v", "error", "-protocol_whitelist", "file,pipe", "-probesize", "5242880",
             "-analyzeduration", "3000000", "-select_streams", "V:0", "-show_streams", "-show_format", "-of", "json", full],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), check=False,
        )
        if completed.returncode != 0:
            raise MetadataError(completed.stderr.decode("utf-8", "replace").strip()[:1200] or "ffprobe 无法读取视频")
        data = json.loads(completed.stdout.decode("utf-8-sig"))
        streams = data.get("streams", [])
        if not streams:
            raise MetadataError("文件中未找到可读取的视频流")
        stream, container = streams[0], data.get("format", {})
        result.update(classify_metadata(stream, container.get("tags", {}), bmff))
        result.update(
            duration=_number(stream.get("duration"), _number(container.get("duration"))),
            width=int(stream.get("width", 0)), height=int(stream.get("height", 0)),
            fps=_number(stream.get("avg_frame_rate"), _number(stream.get("r_frame_rate"))),
            codec=str(stream.get("codec_name", "")),
            color_primaries=str(stream.get("color_primaries", "")),
            color_transfer=str(stream.get("color_transfer", "")), color_space=str(stream.get("color_space", "")),
        )
        if Path(full).suffix.casefold() in PROXY_EXTENSIONS:
            result.update(profile="Unknown", category="Unknown", status="pending_review")
            result["evidence"].append("代理文件：请使用MP4/MOV原片确认相机拍摄颜色模式")
        after = os.stat(full)
        if (after.st_size, after.st_mtime_ns) != (st.st_size, st.st_mtime_ns):
            result.update(profile="Unknown", category="Unknown", status="pending_review")
            result["evidence"].append("分析期间文件发生变化，请重新扫描")
    except subprocess.TimeoutExpired:
        result.update(status="error", error="分析超时（30秒），请确认文件可读取")
    except (OSError, ValueError, TypeError, KeyError, MetadataError) as exc:
        result.update(status="error", error=str(exc))
    return result
