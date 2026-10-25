import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from pocket_restore.engine import RestoreError, choose_output, filter_chain, filter_hlg_to_sdr, inspect, validate_request


class EngineSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.request = {
            "schema_version": 1,
            "files": [{"path": str(self.directory / "input.mp4"), "profile": "auto"}],
            "output_dir": str(self.directory / "output"), "output_mode": "sdr",
        }

    def tearDown(self):
        self.temp.cleanup()

    def test_duplicate_sources_collapse(self):
        self.request["files"] *= 2
        self.assertEqual(len(validate_request(self.request)["files"]), 1)

    def test_original_and_existing_output_are_preserved(self):
        source = self.directory / "input.mp4"
        source.write_bytes(b"original")
        first = choose_output(source, self.directory, "sdr")
        first.write_bytes(b"existing")
        second = choose_output(source, self.directory, "sdr")
        self.assertNotEqual(first, second)
        self.assertNotEqual(source, second)
        self.assertEqual(source.read_bytes(), b"original")
        self.assertEqual(first.read_bytes(), b"existing")

    def test_invalid_or_overwrite_requests_are_rejected(self):
        cases = [
            {"overwrite": True}, {"files": []}, {"schema_version": 9},
            {"output_dir": "relative/output"}, {"output_mode": "hdr10"},
            {"trim_duration": 0}, {"trim_duration": float("nan")},
            {"trim_start": -1}, {"trim_start": True}, {"encoder": "shell"},
            {"cancel_file": "relative.cancel"}, {"look": "unknown"},
            {"files": [{"path": "relative.mp4"}]},
            {"files": [{"path": str(self.directory / "input.mp4"), "profile": "dlogm"}]},
            {"files": [{"path": str(self.directory / "input.mp4"), "profile": {}}]},
            {"output_mode": []}, {"encoder": {}},
        ]
        for changes in cases:
            with self.subTest(changes=changes), self.assertRaises(RestoreError):
                validate_request({**self.request, **changes})

    def test_hdr_does_not_apply_rec709_gamma_after_lut(self):
        graph = filter_chain({"color_space": "bt709", "color_range": "tv"}, "hlg", True, True)
        after_lut = graph.split("lut3d=file=transform.cube:interp=tetrahedral,", 1)[1]
        self.assertIn("transferin=arib-std-b67:transfer=arib-std-b67", after_lut)
        self.assertIn("primariesin=2020:primaries=2020", after_lut)
        self.assertIn("matrix=2020_ncl", after_lut)
        self.assertNotIn("transfer=709", after_lut)
        self.assertIn("format=p010le", graph)

    def test_source_full_range_does_not_become_limited_input(self):
        graph = filter_chain({"color_space": "bt709", "color_range": "pc"}, "sdr", True, False)
        self.assertIn("rangein=full:range=full", graph)
        self.assertIn("rangein=full:range=limited", graph)

    def test_hlg_to_sdr_rejects_log_and_ambiguous_tags(self):
        for tags in ({}, {"color_transfer": "bt709", "color_primaries": "bt2020"},
                     {"color_transfer": "arib-std-b67", "color_primaries": "bt2020", "color_space": "bt709"}):
            with self.subTest(tags=tags), self.assertRaises(RestoreError):
                filter_hlg_to_sdr(tags, False)

    def test_hlg_tone_mapping_uses_linear_units_and_preserves_full_input_range(self):
        graph = filter_hlg_to_sdr({"color_transfer": "arib-std-b67", "color_primaries": "bt2020",
                                   "color_space": "bt2020nc", "color_range": "pc"}, True)
        self.assertIn("rangein=full:matrix=gbr", graph)
        self.assertIn("npl=100:agamma=0", graph)
        self.assertIn("color_trc=linear", graph)
        self.assertIn("tonemap=tonemap=mobius:param=0.3:desat=2:peak=10", graph)
        self.assertIn("format=p010le", graph)

    def test_container_parse_error_is_not_erased_by_hdr_tags(self):
        metadata = {"color_profile": "unknown", "status": "error", "evidence": [],
                    "warnings": ["damaged container"]}
        video = {"color_transfer": "arib-std-b67", "color_primaries": "bt2020"}
        with patch("pocket_restore.engine.probe_dji_metadata", return_value=metadata), \
             patch("pocket_restore.engine.probe_video", return_value=video):
            result = inspect(self.directory / "bad.mp4")
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["color_profile"], "unknown")


if __name__ == "__main__":
    unittest.main()
