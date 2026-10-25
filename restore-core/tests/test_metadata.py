"""Synthetic ISO-BMFF cases for explicit DJI metadata and damaged inputs."""

import hashlib
import struct
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pocket_restore.metadata import probe_dji_metadata


def box(kind, payload=b"", extended=False, to_end=False):
    if isinstance(kind, str):
        kind = kind.encode("latin-1")
    if extended:
        return struct.pack(">I4sQ", 1, kind, len(payload) + 16) + payload
    return struct.pack(">I4s", 0 if to_end else len(payload) + 8, kind) + payload


def metadata(entries, reverse=False, fullbox=True):
    key_records = b""
    items = b""
    for index, (key, value, encoding) in enumerate(entries, 1):
        key_bytes = key.encode("utf-8")
        key_records += struct.pack(">I4s", len(key_bytes) + 8, b"mdta") + key_bytes
        type_id = 1 if encoding == "utf-8" else 2
        raw = value if isinstance(value, bytes) else value.encode(encoding)
        data = box("data", struct.pack(">II", type_id, 0) + raw)
        items += box(struct.pack(">I", index), data)
    keys = box("keys", b"\x00" * 4 + struct.pack(">I", len(entries)) + key_records)
    ilst = box("ilst", items)
    children = ilst + keys if reverse else keys + ilst
    return box("meta", (b"\x00" * 4 if fullbox else b"") + children)


def movie(profile=None, model=None, extra=b"", reverse=False, fullbox=True):
    entries = []
    if profile is not None:
        entries.append(("com.dji.camera.ColorGammaSxS", profile, "utf-8"))
    if model is not None:
        entries.append(("com.dji.camera.CameraModel", model, "utf-8"))
    # Standard Rec.709 tags deliberately coexist with actual DJI log metadata.
    colr = box("colr", b"nclx" + struct.pack(">HHHB", 1, 1, 1, 0))
    return box("ftyp", b"isom\x00\x00\x00\x00isom") + box("moov", box("udta", metadata(entries, reverse, fullbox) + extra) + colr)


class MetadataTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

    def probe(self, data, name="DJI_0001.MP4"):
        path = Path(self.temp.name) / name
        path.write_bytes(data)
        before = hashlib.sha256(path.read_bytes()).digest()
        result = probe_dji_metadata(path)
        self.assertEqual(hashlib.sha256(path.read_bytes()).digest(), before)
        return result

    def test_dlog_overrides_ordinary_rec709_colr(self):
        result = self.probe(movie("D-Log", "Osmo Pocket 4P"))
        self.assertEqual(result["status"], "identified")
        self.assertEqual(result["color_profile"], "dlog")
        self.assertEqual(result["camera_model"], "Osmo Pocket 4P")
        self.assertEqual(result["warnings"], [])
        self.assertEqual(result["evidence"][0]["key"], "com.dji.camera.ColorGammaSxS")
        self.assertIsInstance(result["evidence"][0]["offset"], int)

    def test_all_supported_profiles(self):
        for raw, expected in (("D-Log2", "dlog2"), ("Rec.2100 HLG", "hlg"), ("Rec.709", "rec709"), (" d-LoG2 ", "dlog2")):
            with self.subTest(profile=raw):
                self.assertEqual(self.probe(movie(raw))["color_profile"], expected)

    def test_missing_gamma_not_inferred_from_colr_or_filename(self):
        result = self.probe(movie(model="Osmo Pocket 4P"), "DLOG2_HDR.mp4")
        self.assertEqual(result["status"], "unknown")
        self.assertEqual(result["color_profile"], "unknown")
        self.assertEqual(result["camera_model"], "Osmo Pocket 4P")

    def test_dlog_m_is_not_dlog(self):
        result = self.probe(movie("D-Log M"))
        self.assertEqual(result["color_profile"], "unknown")
        self.assertTrue(any("Unsupported" in warning for warning in result["warnings"]))

    def test_future_profile_is_unknown(self):
        self.assertEqual(self.probe(movie("D-Log3"))["status"], "unknown")

    def test_proxy_skipped_even_if_profile_present(self):
        for extension in ("LRF", "XRF", "LRV"):
            with self.subTest(extension=extension):
                result = self.probe(movie("D-Log2"), "DJI_0001." + extension)
                self.assertEqual(result["status"], "skipped")
                self.assertEqual(result["color_profile"], "unknown")
                self.assertEqual(result["evidence"], [])

    def test_mdat_content_cannot_spoof_metadata(self):
        fake = box("mdat", metadata([("com.dji.camera.ColorGammaSxS", "D-Log2", "utf-8")]))
        self.assertEqual(self.probe(movie() + fake)["color_profile"], "unknown")

    def test_keys_and_ilst_order_independent(self):
        self.assertEqual(self.probe(movie("D-Log2", reverse=True))["color_profile"], "dlog2")

    def test_legacy_quicktime_meta_without_fullbox(self):
        self.assertEqual(self.probe(movie("D-Log2", fullbox=False))["color_profile"], "dlog2")

    def test_utf16_and_legacy_gamma_key(self):
        meta = metadata([("DjiCameraColorGammaSxS", "D-Log2", "utf-16-be"), ("com.apple.quicktime.model", "大疆 Osmo Pocket 4P", "utf-8")])
        result = self.probe(box("moov", meta))
        self.assertEqual(result["color_profile"], "dlog2")
        self.assertEqual(result["camera_model"], "大疆 Osmo Pocket 4P")

    def test_camera_userdata_plain_and_length_prefixed(self):
        raw = b"Osmo Pocket 4P"
        for value in (raw, struct.pack(">HH", len(raw), 0) + raw):
            with self.subTest(payload=value):
                result = self.probe(movie("D-Log2", extra=box(b"\xa9mdl", value)))
                self.assertEqual(result["camera_model"], "Osmo Pocket 4P")

    def test_terminal_nul_accepted_embedded_nul_rejected(self):
        self.assertEqual(self.probe(movie(b"D-Log2\x00"))["color_profile"], "dlog2")
        result = self.probe(movie(b"D-Log\x002"))
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["color_profile"], "unknown")

    def test_conflicting_modes_do_not_auto_convert(self):
        second = metadata([("com.dji.camera.ColorGammaSxS", "Rec.709", "utf-8")])
        result = self.probe(movie("D-Log2", extra=second))
        self.assertEqual(result["status"], "unknown")
        self.assertTrue(any("Conflicting DJI" in warning for warning in result["warnings"]))

    def test_conflicting_camera_models_not_arbitrarily_chosen(self):
        result = self.probe(movie("D-Log2", "Osmo Pocket 4P", box(b"\xa9mdl", b"Osmo Pocket 3")))
        self.assertEqual(result["color_profile"], "dlog2")
        self.assertIsNone(result["camera_model"])

    def test_corrupt_size_after_valid_metadata_is_error(self):
        result = self.probe(movie("D-Log2") + struct.pack(">I4s", 1000, b"free"))
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["color_profile"], "unknown")

    def test_truncated_or_underflow_boxes_are_error(self):
        for data in (b"", b"\x00" * 7, struct.pack(">I4s", 4, b"moov"), struct.pack(">I4s", 1, b"moov"), movie("D-Log2")[:-1]):
            with self.subTest(data=data[:16]):
                self.assertEqual(self.probe(data)["status"], "error")

    def test_bad_keys_count_is_error(self):
        keys = box("keys", b"\x00" * 4 + struct.pack(">I", 99))
        self.assertEqual(self.probe(box("moov", box("meta", b"\x00" * 4 + keys)))["status"], "error")

    def test_extended_and_size_zero_containers(self):
        meta = metadata([("com.dji.camera.ColorGammaSxS", "D-Log2", "utf-8")])
        for data in (box("moov", meta, extended=True), box("moov", meta, to_end=True)):
            with self.subTest(header=data[:16]):
                self.assertEqual(self.probe(data)["color_profile"], "dlog2")

    def test_metadata_not_limited_to_last_two_megabytes(self):
        data = movie("D-Log2") + box("mdat", b"\x00" * (2 * 1024 * 1024 + 32))
        self.assertEqual(self.probe(data)["color_profile"], "dlog2")

    def test_invalid_utf8_is_error(self):
        self.assertEqual(self.probe(movie(b"D-Log2\xff"))["status"], "error")

    def test_not_a_movie_and_path_errors(self):
        self.assertEqual(self.probe(box("mdat", b"data"))["status"], "error")
        self.assertEqual(probe_dji_metadata(Path(self.temp.name) / "missing.mp4")["status"], "error")
        self.assertEqual(probe_dji_metadata("bad\x00path.mp4")["status"], "error")


if __name__ == "__main__":
    unittest.main()
