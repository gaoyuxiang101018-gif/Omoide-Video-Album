"""Read DJI recording metadata from ISO-BMFF files without changing them.

Only DJI's explicit ColorGammaSxS field determines ``color_profile``. The
ordinary ``colr`` box is intentionally not used: DJI log recordings can be
tagged Rec.709 there. No filename or image-content inference is performed.
This is an independent parser, using only Python's standard library.
"""

from __future__ import annotations

import os
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Iterator

_PROXY_EXTENSIONS = {".lrf", ".lrv", ".xrf"}
_GAMMA_KEYS = {"com.dji.camera.ColorGammaSxS", "DjiCameraColorGammaSxS"}
_CAMERA_KEYS = {"com.dji.camera.CameraModel", "com.apple.quicktime.model"}
_CONTAINERS = {b"moov", b"udta", b"trak", b"mdia", b"minf", b"stbl", b"edts", b"dinf", b"meco"}
_PROFILE_NAMES = {
    "d-log": "dlog",
    "d-log2": "dlog2",
    "rec.2100 hlg": "hlg",
    "rec.709": "rec709",
}
_MAX_METADATA_BYTES = 1024 * 1024
_MAX_BOXES = 100_000
_MAX_DEPTH = 16


class _ParseError(ValueError):
    """Invalid or unsupported metadata structure; do not guess a profile."""


@dataclass(frozen=True)
class _Box:
    kind: bytes
    offset: int
    payload: int
    end: int


class _Reader:
    def __init__(self, file: BinaryIO, size: int) -> None:
        self.file = file
        self.size = size
        self.box_count = 0

    def read(self, offset: int, length: int) -> bytes:
        if offset < 0 or length < 0 or offset + length > self.size:
            raise _ParseError(f"Read exceeds file boundary at byte {offset}.")
        self.file.seek(offset)
        data = self.file.read(length)
        if len(data) != length:
            raise _ParseError(f"File ended unexpectedly at byte {offset}.")
        return data

    def boxes(self, start: int, end: int) -> Iterator[_Box]:
        offset = start
        while offset < end:
            self.box_count += 1
            if self.box_count > _MAX_BOXES:
                raise _ParseError("Container exceeds the supported box-count limit.")
            if end - offset < 8:
                raise _ParseError(f"Truncated box header at byte {offset}.")
            size, kind = struct.unpack(">I4s", self.read(offset, 8))
            header = 8
            if size == 1:
                if end - offset < 16:
                    raise _ParseError(f"Truncated extended box header at byte {offset}.")
                size = struct.unpack(">Q", self.read(offset + 8, 8))[0]
                header = 16
            elif size == 0:
                size = end - offset
            if kind == b"uuid":
                header += 16
            if size < header or size > end - offset:
                raise _ParseError(f"Invalid box size at byte {offset}.")
            yield _Box(kind, offset, offset + header, offset + size)
            offset += size

    def payload(self, box: _Box) -> bytes:
        length = box.end - box.payload
        if length > _MAX_METADATA_BYTES:
            raise _ParseError(f"Metadata box exceeds 1 MiB at byte {box.offset}.")
        return self.read(box.payload, length)


def _text(raw: bytes, encoding: str, context: str) -> str:
    # A terminal NUL is a common C-string terminator; embedded NULs indicate
    # malformed text and must never turn an unknown string into a valid mode.
    try:
        value = raw.decode(encoding, errors="strict").rstrip("\x00").strip()
    except UnicodeDecodeError as exc:
        raise _ParseError(f"Invalid {encoding} text in {context}.") from exc
    if "\x00" in value or any(ord(char) < 32 for char in value):
        raise _ParseError(f"Embedded NUL or control character in {context}.")
    return value


def _keys(reader: _Reader, box: _Box) -> list[tuple[bytes, str]]:
    data = reader.payload(box)
    if len(data) < 8 or data[:4] != b"\x00" * 4:
        raise _ParseError(f"Invalid keys FullBox at byte {box.offset}.")
    count = struct.unpack_from(">I", data, 4)[0]
    if count > (len(data) - 8) // 8:
        raise _ParseError(f"Invalid keys entry count at byte {box.offset}.")
    entries: list[tuple[bytes, str]] = []
    cursor = 8
    for _ in range(count):
        if cursor + 8 > len(data):
            raise _ParseError(f"Truncated key entry at byte {box.offset}.")
        size, namespace = struct.unpack_from(">I4s", data, cursor)
        if size < 8 or size > len(data) - cursor:
            raise _ParseError(f"Invalid key entry size at byte {box.offset}.")
        name = _text(data[cursor + 8 : cursor + size], "utf-8", "metadata key")
        entries.append((namespace, name))
        cursor += size
    if cursor != len(data):
        raise _ParseError(f"Unexpected trailing bytes in keys at byte {box.offset}.")
    return entries


def _data_text(reader: _Reader, box: _Box, key: str) -> str:
    data = reader.payload(box)
    if len(data) < 8:
        raise _ParseError(f"Truncated data box for {key} at byte {box.offset}.")
    type_and_version = struct.unpack_from(">I", data, 0)[0]
    version, data_type = type_and_version >> 24, type_and_version & 0xFFFFFF
    if version != 0 or data_type not in (1, 2):
        raise _ParseError(f"Unsupported text data type {data_type} for {key}.")
    encoding = "utf-8" if data_type == 1 else "utf-16-be"
    return _text(data[8:], encoding, key)


def _meta(reader: _Reader, box: _Box, evidence: list[dict]) -> None:
    if box.end - box.payload < 4:
        raise _ParseError(f"Truncated meta FullBox at byte {box.offset}.")
    prefix = reader.read(box.payload, 4)
    if prefix == b"\x00" * 4:
        start = box.payload + 4
    elif box.end - box.payload >= 8 and reader.read(box.payload + 4, 4) in {
        b"hdlr", b"keys", b"ilst", b"free",
    }:
        # Legacy QuickTime meta containers omit FullBox version/flags.
        start = box.payload
    else:
        raise _ParseError(f"Unsupported meta header at byte {box.offset}.")
    children = list(reader.boxes(start, box.end))
    key_boxes = [child for child in children if child.kind == b"keys"]
    if len(key_boxes) > 1:
        raise _ParseError(f"Multiple keys tables in meta at byte {box.offset}.")
    entries = _keys(reader, key_boxes[0]) if key_boxes else []
    for child in children:
        if child.kind != b"ilst":
            continue
        for item in reader.boxes(child.payload, child.end):
            index = struct.unpack(">I", item.kind)[0]
            item_children = list(reader.boxes(item.payload, item.end))
            if not entries or not 1 <= index <= len(entries):
                continue
            namespace, key = entries[index - 1]
            if namespace != b"mdta" or key not in _GAMMA_KEYS | _CAMERA_KEYS:
                continue
            data_boxes = [part for part in item_children if part.kind == b"data"]
            if not data_boxes:
                raise _ParseError(f"Missing data box for {key} at byte {item.offset}.")
            for part in data_boxes:
                evidence.append({
                    "source": "quicktime_mdta",
                    "key": key,
                    "value": _data_text(reader, part, key),
                    "offset": part.offset,
                })


def _model_atom(reader: _Reader, box: _Box, evidence: list[dict]) -> None:
    data = reader.payload(box)
    if len(data) >= 8 and data[4:8] == b"data":
        children = list(reader.boxes(box.payload, box.end))
        for child in children:
            if child.kind == b"data":
                evidence.append({
                    "source": "quicktime_userdata", "key": "©mdl",
                    "value": _data_text(reader, child, "©mdl"), "offset": child.offset,
                })
        return
    if len(data) >= 4:
        string_length = struct.unpack_from(">H", data, 0)[0]
        if string_length == len(data) - 4:
            data = data[4:]
    evidence.append({
        "source": "quicktime_userdata", "key": "©mdl",
        "value": _text(data, "utf-8", "©mdl"), "offset": box.offset,
    })


def _walk(reader: _Reader, start: int, end: int, evidence: list[dict], depth: int = 0) -> bool:
    if depth > _MAX_DEPTH:
        raise _ParseError("Container exceeds the supported nesting-depth limit.")
    found_movie = False
    for box in reader.boxes(start, end):
        if box.kind == b"moov":
            found_movie = True
        if box.kind in _CONTAINERS:
            found_movie = _walk(reader, box.payload, box.end, evidence, depth + 1) or found_movie
        elif box.kind == b"meta":
            _meta(reader, box, evidence)
        elif box.kind == b"\xa9mdl":
            _model_atom(reader, box, evidence)
    return found_movie


def probe_dji_metadata(path: str | os.PathLike[str]) -> dict:
    """Return explicit DJI profile and camera evidence; input is opened read-only.

    Result keys: path, color_profile, camera_model, evidence, warnings, status.
    Profiles are dlog/dlog2/hlg/rec709/unknown. Status is identified, unknown,
    skipped (DJI proxy sidecar), or error (I/O/invalid container). Unknown and
    error results must not be automatically converted. D-Log M is intentionally
    unknown because it is not D-Log. ``evidence`` contains source/key/value/offset.
    """
    result = {
        "path": None, "color_profile": "unknown", "camera_model": None,
        "evidence": [], "warnings": [], "status": "unknown",
    }
    try:
        file_path = os.fspath(path)
        if not isinstance(file_path, str) or "\x00" in file_path:
            raise ValueError("Path must be text without NUL characters.")
        result["path"] = file_path
        if Path(file_path).suffix.lower() in _PROXY_EXTENSIONS:
            result["status"] = "skipped"
            result["warnings"].append("DJI proxy sidecar skipped; use the original MP4/MOV recording.")
            return result
        with open(file_path, "rb") as file:
            size = os.fstat(file.fileno()).st_size
            if size < 8:
                raise _ParseError("File is too small to contain an ISO-BMFF box.")
            if not _walk(_Reader(file, size), 0, size, result["evidence"]):
                raise _ParseError("No moov movie box found; not a supported original MP4/MOV.")
    except (OSError, TypeError, ValueError, OverflowError) as exc:
        result["status"] = "error"
        result["warnings"].append(f"Metadata probe failed: {exc}")
        return result

    gamma_values = [item["value"] for item in result["evidence"] if item["key"] in _GAMMA_KEYS]
    normalized = {value.casefold() for value in gamma_values}
    if not gamma_values:
        result["warnings"].append("DJI ColorGammaSxS metadata is missing; standard colr tags cannot identify DJI log recordings.")
    elif len(normalized) != 1:
        result["warnings"].append("Conflicting DJI ColorGammaSxS values; automatic conversion is disabled.")
    else:
        gamma = next(iter(normalized))
        result["color_profile"] = _PROFILE_NAMES.get(gamma, "unknown")
        if result["color_profile"] == "unknown":
            result["warnings"].append(f"Unsupported DJI color profile: {gamma_values[0]!r}; automatic conversion is disabled.")
        else:
            result["status"] = "identified"

    models = {item["value"] for item in result["evidence"] if item["key"] in _CAMERA_KEYS | {"©mdl"} and item["value"]}
    if len(models) == 1:
        result["camera_model"] = next(iter(models))
    elif len(models) > 1:
        result["warnings"].append("Conflicting camera model metadata; camera_model is unknown.")
    else:
        result["warnings"].append("Camera model metadata is missing.")
    return result
