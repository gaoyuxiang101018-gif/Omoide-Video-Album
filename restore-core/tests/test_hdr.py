"""HDR checks against the packaged DJI source and independent standard anchors."""

import hashlib
import json
import math
import re
import tempfile
import unittest
from pathlib import Path

import numpy as np

from pocket_restore import hdr


SOURCES = Path(hdr.__file__).parent / "data" / "hdr_reference_sources"


def _dlog2_oracle(x: float, constants: dict[str, float]) -> float:
    # Scalar oracle takes constants from the downloaded manufacturer CTL.
    c = constants
    if x >= c["in_limit_rev_1"]:
        return c["H"] / (2 ** c["a"] - 1) * (2 ** (c["a"] * x) - 1)
    if x >= c["in_limit_rev_2"]:
        return 2 ** ((x - c["b1"]) / c["k1"] + math.log2(c["in_limit1"]))
    return (x - c["b2"]) / c["k2"] + c["in_limit2"]


def tetrahedral_interpolate(samples: np.ndarray, table: np.ndarray) -> np.ndarray:
    """Independent red/green/blue corner implementation for exported LUT QA."""
    size = table.shape[0]
    scaled = np.clip(samples, 0, 1) * (size - 1)
    origin = np.minimum(scaled.astype(int), size - 2)
    fractions = scaled - origin
    order = np.argsort(-fractions, axis=1)
    descending = np.take_along_axis(fractions, order, axis=1)
    rows = np.arange(len(samples))
    offset = np.zeros_like(origin)
    first = table[origin[:, 2], origin[:, 1], origin[:, 0]]
    offset[rows, order[:, 0]] = 1
    corner = origin + offset
    second = table[corner[:, 2], corner[:, 1], corner[:, 0]]
    offset[rows, order[:, 1]] = 1
    corner = origin + offset
    third = table[corner[:, 2], corner[:, 1], corner[:, 0]]
    corner = origin + 1
    fourth = table[corner[:, 2], corner[:, 1], corner[:, 0]]
    return (first * (1 - descending[:, 0, None]) + second * (descending[:, 0, None] - descending[:, 1, None]) + third * (descending[:, 1, None] - descending[:, 2, None]) + fourth * descending[:, 2, None])


def read_cube_data(path: Path) -> np.ndarray:
    lines = path.read_text().splitlines()
    return np.array([[float(n) for n in line.split()] for line in lines if line and line[0].isdigit()])


class HDRTests(unittest.TestCase):
    def test_reference_source_integrity(self):
        manifest = json.loads((SOURCES / "manifest.json").read_text(encoding="utf-8"))
        for entry in manifest["files"]:
            self.assertEqual(hashlib.sha256((SOURCES / entry["file"]).read_bytes()).hexdigest(), entry["sha256"])

    def test_dlog2_manufacturer_scalar_oracle(self):
        text = (SOURCES / "Dlog2_DGamut2_to_ACES_AP0_cat02.ctl").read_text()
        constants = {key: float(value) for key, value in re.findall(r"float\s+(\w+)\s*=\s*([0-9.]+);", text)}
        x = np.r_[np.linspace(0, 1, 700), [constants["b1"], constants["b2"]]]
        oracle = np.array([_dlog2_oracle(float(v), constants) for v in x])
        np.testing.assert_allclose(hdr.decode_dlog2(x), oracle, rtol=2e-14, atol=2e-14)
        self.assertAlmostEqual(float(hdr.decode_dlog2(constants["b1"])), 0.18, places=12)
        self.assertAlmostEqual(float(hdr.decode_dlog2(1.0)), 475.0, places=10)

    def test_dlog_manufacturer_scalar_oracle(self):
        text = (SOURCES / "Dlog_DGamut_to_ACES_AP0_cat02_v1.ctl").read_text()
        self.assertIn("(x - 0.0929) / 6.025", text)
        self.assertIn("pow(10, (3.89616 * x - 2.27752))", text)
        x = np.linspace(0, 1, 700)
        oracle = np.array([(v - 0.0929) / 6.025 if v <= 0.14 else (10 ** (3.89616 * v - 2.27752) - 0.0108) / 0.9892 for v in x])
        np.testing.assert_allclose(hdr.decode_dlog(x), oracle, rtol=3e-14, atol=1e-14)
        self.assertEqual(float(hdr.decode_dlog(0.0929)), 0.0)

    def test_published_primaries_and_dctl_approximation(self):
        for profile, filename, ctl_name in (("dlog", "DLog_DGamut_to_ACES_AP0_cat02_v1.dctl", "Dlog_DGamut_to_ACES_AP0_cat02_v1.ctl"), ("dlog2", "DLog2_DGamut2_to_ACES_AP0_cat02.dctl", "Dlog2_DGamut2_to_ACES_AP0_cat02.ctl")):
            ctl = (SOURCES / ctl_name).read_text()
            primary_block = re.search(r"const Chromaticities \w+\s*=\s*\{(.*?)\};", ctl, re.S).group(1)
            xy = np.array([[float(x), float(y)] for x, y in re.findall(r"\{\s*(-?[0-9.]+),\s*(-?[0-9.]+)\s*\}", primary_block)])
            xyz_unscaled = np.array([[x / y, 1, (1 - x - y) / y] for x, y in xy[:3]]).T
            wx, wy = xy[3]
            white_xyz = np.array([wx / wy, 1, (1 - wx - wy) / wy])
            ctl_matrix = xyz_unscaled @ np.diag(np.linalg.inv(xyz_unscaled) @ white_xyz)
            derived = hdr.BT2020_TO_XYZ @ hdr.source_to_bt2020(profile)
            np.testing.assert_allclose(derived, ctl_matrix, rtol=0, atol=5e-15)
            text = (SOURCES / filename).read_text()
            matrix_line = next(line for line in text.splitlines() if line.startswith("#define dgamut") and "to_xyz" in line)
            rounded = np.array([float(value) for value in re.findall(r"(-?[0-9]+\.[0-9]+)f", matrix_line)]).reshape(3, 3)
            # The manufacturer's DCTL also approximates the white XYZ: the
            # DLog matrix sums to [.9504, 1, 1.0888], not the CTL's exact D65.
            # This implementation follows the explicit CTL primaries above.
            np.testing.assert_allclose(derived, rounded, rtol=0, atol=2e-4)
            np.testing.assert_allclose(derived.sum(axis=1), white_xyz, atol=5e-15)

    def test_bt2020_standard_matrix_and_white(self):
        standard_rounded = np.array([[0.6370, 0.1446, 0.1689], [0.2627, 0.6780, 0.0593], [0.0, 0.0281, 1.0610]])
        np.testing.assert_allclose(hdr.BT2020_TO_XYZ, standard_rounded, rtol=0, atol=5.1e-5)
        for profile in ("dlog", "dlog2"):
            np.testing.assert_allclose(hdr.source_to_bt2020(profile) @ np.ones(3), np.ones(3), atol=1e-14)

    def test_hlg_standard_anchors_and_roundtrip(self):
        anchors = np.array([0.0, 1 / 12, 1.0])
        np.testing.assert_allclose(hdr.hlg_oetf(anchors), [0.0, 0.5, 1.0], atol=1e-9)
        values = np.linspace(0, 1, 10000)
        np.testing.assert_allclose(hdr.hlg_inverse_oetf(hdr.hlg_oetf(values)), values, atol=3e-15)

    def test_diffuse_white_is_203_nits(self):
        # Decode formula solved independently for source scene-linear white=1.
        codes = {
            "dlog": (math.log10(0.9892 + 0.0108) + 2.27752) / 3.89616,
            "dlog2": math.log2(1 + (2 ** 16.285770761945304 - 1) / 475) / 16.285770761945304,
        }
        for profile, code in codes.items():
            output = hdr.transform_hlg(np.array([[code] * 3]), profile)
            scene = hdr.hlg_inverse_oetf(output)[0]
            nits = 1000 * float(scene @ hdr.BT2020_LUMA) ** 1.2
            self.assertAlmostEqual(nits, 203.0, places=9)

    def test_grey_axis_monotonic_with_black_and_peak(self):
        x = np.linspace(0, 1, 10000)
        for profile in ("dlog", "dlog2"):
            out = hdr.transform_hlg(np.repeat(x[:, None], 3, axis=1), profile)
            self.assertTrue(np.isfinite(out).all())
            self.assertGreaterEqual(float(out.min()), 0.0)
            self.assertLessEqual(float(out.max()), 1.0 + 1e-12)
            self.assertTrue((np.diff(out[:, 0]) >= -1e-13).all())
            np.testing.assert_allclose(out[:, 0], out[:, 1], atol=1e-13)
            np.testing.assert_allclose(out[:, 0], out[:, 2], atol=1e-13)
            np.testing.assert_allclose(out[0], 0.0, atol=0)
            self.assertGreater(float(out[-1, 0]), 0.9999)

    def test_gamut_compression_preserves_luminance_and_hue_direction(self):
        # Deliberately includes out-of-gamut primaries and bright saturated RGB.
        samples = np.array([[0.8, 0.1, 0.1], [0.1, 0.8, 0.1], [0.1, 0.1, 0.8], [0.45, 0.50, 0.40]])
        for profile, decoder in (("dlog", hdr.decode_dlog), ("dlog2", hdr.decode_dlog2)):
            source = decoder(samples) @ hdr.source_to_bt2020(profile).T
            source_y = source @ hdr.BT2020_LUMA
            output = hdr.hlg_inverse_oetf(hdr.transform_hlg(samples, profile)) / hdr.WHITE_SCENE_SIGNAL
            output_y = output @ hdr.BT2020_LUMA
            width = hdr.SCENE_PEAK - 1
            positive_y = np.maximum(source_y, 0)
            expected_y = np.where(positive_y <= 1, positive_y, 1 + width * (1 - np.exp(-(positive_y - 1) / width)))
            np.testing.assert_allclose(output_y, expected_y, rtol=2e-14, atol=1e-14)
            in_chroma = source - source_y[:, None]
            out_chroma = output - output_y[:, None]
            np.testing.assert_allclose(np.cross(in_chroma, out_chroma), np.zeros_like(source), atol=1e-11)
            self.assertGreaterEqual(float(output.min()), 0.0)
            self.assertLessEqual(float(output.max()), hdr.SCENE_PEAK + 1e-12)

    def test_random_full_domain_is_finite_and_bounded(self):
        samples = np.random.default_rng(503).random((25000, 3))
        for profile in ("dlog", "dlog2"):
            result = hdr.transform_hlg(samples, profile)
            self.assertTrue(np.isfinite(result).all())
            self.assertGreaterEqual(float(result.min()), 0.0)
            self.assertLessEqual(float(result.max()), 1.0 + 1e-12)

    def test_cube_channel_order_matches_direct_transform(self):
        with tempfile.TemporaryDirectory() as directory:
            path = hdr.generate_hlg_lut("dlog2", Path(directory) / "test.cube", size=5)
            lines = path.read_text().splitlines()
            self.assertIn("LUT_3D_SIZE 5", lines)
            data = np.array([[float(n) for n in line.split()] for line in lines if line and line[0].isdigit()])
            self.assertEqual(data.shape, (5 ** 3, 3))
            # Red increases first, then green, then blue.
            indices = [1, 5, 25]
            expected = hdr.transform_hlg(np.diag([0.25] * 3), "dlog2")
            np.testing.assert_allclose(data[indices], expected, atol=5.1e-10)

    def test_unknown_profile_refused_and_exposure_validation(self):
        for profile in ("auto", "rec709", "dlogm", "hlg"):
            with self.assertRaises(ValueError):
                hdr.transform_hlg(np.ones((1, 3)), profile)
        for ev in (float("nan"), float("inf"), 11):
            with self.assertRaises(ValueError):
                hdr.transform_hlg(np.ones((1, 3)), "dlog2", exposure_ev=ev)

    def test_shaper_retains_negative_channels_and_exact_black_grid_point(self):
        linear = np.array([-0.02, -0.001, 0.0, 0.001, 0.18, 1.0, 475.0])
        shaped = hdr._linear_to_shaper(linear)
        self.assertEqual(float(shaped[2]), 0.125)
        self.assertTrue((shaped[:2] < 0.125).all())
        self.assertGreaterEqual(float(shaped.min()), 0.0)
        self.assertLessEqual(float(shaped.max()), 1.0)
        np.testing.assert_allclose(hdr._shaper_to_linear(shaped), linear, rtol=2e-14, atol=1e-14)

    def test_shaped_export_grey_matches_oracle_within_one_10bit_code(self):
        with tempfile.TemporaryDirectory() as directory:
            x = np.linspace(0, 1, 20001)
            grey = np.repeat(x[:, None], 3, axis=1)
            for profile in ("dlog", "dlog2"):
                pair = hdr.generate_hlg_lut_pair(profile, directory)
                shaper = read_cube_data(pair["shaper"])
                cube = read_cube_data(pair["lut3d"]).reshape(65, 65, 65, 3)
                shaped = np.interp(grey, np.linspace(0, 1, len(shaper)), shaper[:, 0])
                actual = tetrahedral_interpolate(shaped, cube)
                direct = hdr.transform_hlg(grey, profile)
                self.assertLess(float(np.max(np.abs(actual - direct))) * 1023, 1.0)
                self.assertTrue(np.isfinite(actual).all())
                self.assertTrue((np.diff(actual[:, 0]) >= -1e-13).all())


if __name__ == "__main__":
    unittest.main()
