"""DJI scene-referred log to Rec.2100 HLG, without an SDR intermediate.

Input curves and primaries are transcribed from DJI's official ACES CTLs.
HLG is ITU-R BT.2100-3 Table 5. The exposure, luminance shoulder and gamut
compression are this tool's rendering choices, not DJI Mimo's private look.
See data/hdr_reference_sources/manifest.json for URLs and original hashes.
"""

from __future__ import annotations

import math
import os
import tempfile
from pathlib import Path

import numpy as np

REFERENCE_WHITE_NITS = 203.0
NOMINAL_PEAK_NITS = 1000.0
SYSTEM_GAMMA = 1.2
HLG_A = 0.17883277
HLG_B = 1.0 - 4.0 * HLG_A
HLG_C = 0.5 - HLG_A * math.log(4.0 * HLG_A)
WHITE_SCENE_SIGNAL = (REFERENCE_WHITE_NITS / NOMINAL_PEAK_NITS) ** (1.0 / SYSTEM_GAMMA)
SCENE_PEAK = 1.0 / WHITE_SCENE_SIGNAL
SHAPER_BLACK = 0.125
SHAPER_Q = 0.25
SHAPER_MAX_LINEAR = 475.0
_SHAPER_SCALE = math.asinh(math.sqrt(SHAPER_MAX_LINEAR) / SHAPER_Q)

# Official DJI CTL primaries; CTL precision is higher than the rounded DCTL.
_PRIMARIES = {
    "dlog": ((0.71, 0.31), (0.21, 0.88), (0.09, -0.08)),
    "dlog2": ((0.7347, 0.2653), (0.1600, 0.8400), (0.0900, -0.0800)),
    "bt2020": ((0.708, 0.292), (0.170, 0.797), (0.131, 0.046)),
}
_D65 = (0.3127, 0.3290)


def _rgb_to_xyz(primaries: tuple[tuple[float, float], ...]) -> np.ndarray:
    xy = np.asarray(primaries, dtype=np.float64)
    columns = np.stack((xy[:, 0] / xy[:, 1], np.ones(3), (1.0 - xy.sum(axis=1)) / xy[:, 1]))
    xw, yw = _D65
    white_xyz = np.array((xw / yw, 1.0, (1.0 - xw - yw) / yw))
    return columns * np.linalg.solve(columns, white_xyz)


BT2020_TO_XYZ = _rgb_to_xyz(_PRIMARIES["bt2020"])
BT2020_LUMA = BT2020_TO_XYZ[1]
_SOURCE_TO_XYZ = {key: _rgb_to_xyz(value) for key, value in _PRIMARIES.items() if key != "bt2020"}
_SOURCE_TO_BT2020 = {key: np.linalg.solve(BT2020_TO_XYZ, value) for key, value in _SOURCE_TO_XYZ.items()}


def normalize_profile(profile: str) -> str:
    key = profile.lower().replace("-", "").replace(" ", "")
    if key not in _SOURCE_TO_BT2020:
        raise ValueError("HDR log conversion requires an explicitly identified dlog or dlog2 source.")
    return key


def decode_dlog(encoded: np.ndarray | float) -> np.ndarray:
    """Official DJI D-Log inverse curve, preserving scene-linear values > 1."""
    x = np.asarray(encoded, dtype=np.float64)
    return np.where(x <= 0.14, (x - 0.0929) / 6.025, (np.power(10.0, 3.89616 * x - 2.27752) - 0.0108) / 0.9892)


def decode_dlog2(encoded: np.ndarray | float) -> np.ndarray:
    """Official DJI three-segment D-Log2 inverse curve."""
    x = np.asarray(encoded, dtype=np.float64)
    h, a = 475.0, 16.285770761945304
    k1, b1 = 0.059439938321493, 0.304985337243402
    k2, b2 = 2.960935245492250, 0.148314799066323
    toe = (x - b2) / k2 + 0.028961695254132
    middle = np.exp2((x - b1) / k1 + math.log2(0.18))
    high = h / (math.exp2(a) - 1.0) * np.expm1(math.log(2.0) * a * x)
    return np.where(x >= b1, high, np.where(x >= b2, middle, toe))


def source_to_bt2020(profile: str) -> np.ndarray:
    """Column-vector RGB matrix; source and target both have D65 white."""
    return _SOURCE_TO_BT2020[normalize_profile(profile)].copy()


def hlg_oetf(scene_signal: np.ndarray | float) -> np.ndarray:
    """BT.2100-3 HLG reference OETF, applied only after rendering to [0, 1]."""
    x = np.clip(np.asarray(scene_signal, dtype=np.float64), 0.0, 1.0)
    high = HLG_A * np.log(np.maximum(12.0 * x - HLG_B, np.finfo(float).tiny)) + HLG_C
    return np.where(x <= 1.0 / 12.0, np.sqrt(3.0 * x), high)


def hlg_inverse_oetf(encoded: np.ndarray | float) -> np.ndarray:
    x = np.clip(np.asarray(encoded, dtype=np.float64), 0.0, 1.0)
    return np.where(x <= 0.5, x * x / 3.0, (np.exp((x - HLG_C) / HLG_A) + HLG_B) / 12.0)


def _render_scene(rgb: np.ndarray) -> np.ndarray:
    # Preserve diffuse white and all darker luminances. Roll highlights into
    # the available range with one luminance multiplier, preserving RGB ratios.
    luminance = rgb @ BT2020_LUMA
    positive_y = np.maximum(luminance, 0.0)
    width = SCENE_PEAK - 1.0
    mapped_y = np.where(positive_y <= 1.0, positive_y, 1.0 - width * np.expm1(-np.maximum(positive_y - 1.0, 0.0) / width))
    scale = np.divide(mapped_y, positive_y, out=np.zeros_like(mapped_y), where=positive_y > 0.0)
    rendered = rgb * scale[..., None]

    # All three channels use the same saturation factor toward the grey axis.
    # This keeps luminance and hue direction, unlike independent RGB clipping.
    chroma = rendered - mapped_y[..., None]
    upper = np.divide(SCENE_PEAK - mapped_y[..., None], chroma, out=np.full_like(chroma, np.inf), where=chroma > 0.0)
    lower = np.divide(-mapped_y[..., None], chroma, out=np.full_like(chroma, np.inf), where=chroma < 0.0)
    amount = np.minimum(1.0, np.minimum(upper.min(axis=-1), lower.min(axis=-1)))
    bounded = mapped_y[..., None] + chroma * amount[..., None]
    return np.clip(bounded * WHITE_SCENE_SIGNAL, 0.0, 1.0)


def transform_hlg(encoded_rgb: np.ndarray, profile: str, *, exposure_ev: float = 0.0) -> np.ndarray:
    """Convert full-range log RGB to full-range BT.2020 / HLG RGB.

    The caller must normalize input video range correctly, then encode output
    as 10-bit HEVC with BT.2020 primaries, arib-std-b67 transfer and bt2020nc
    matrix tags. Do not apply another gamma or a Rec.709 LUT after this step.
    """
    profile = normalize_profile(profile)
    rgb = np.asarray(encoded_rgb, dtype=np.float64)
    if rgb.ndim == 0 or rgb.shape[-1] != 3 or not np.isfinite(rgb).all():
        raise ValueError("Input must contain finite RGB triplets.")
    if not math.isfinite(exposure_ev) or not -10.0 <= exposure_ev <= 10.0:
        raise ValueError("Exposure must be finite and between -10 and 10 stops.")
    decoder = decode_dlog2 if profile == "dlog2" else decode_dlog
    return _linear_to_hlg(decoder(rgb), profile, exposure_ev)


def _linear_to_hlg(linear: np.ndarray, profile: str, exposure_ev: float) -> np.ndarray:
    linear = linear * math.exp2(exposure_ev)
    bt2020 = linear @ _SOURCE_TO_BT2020[profile].T
    return hlg_oetf(_render_scene(bt2020))


def _linear_to_shaper(linear: np.ndarray) -> np.ndarray:
    """Signed perceptual shaper: retain source channels below the black point."""
    signed_root = np.sign(linear) * np.sqrt(np.abs(linear))
    return SHAPER_BLACK + (1.0 - SHAPER_BLACK) * np.arcsinh(signed_root / SHAPER_Q) / _SHAPER_SCALE


def _shaper_to_linear(shaped: np.ndarray) -> np.ndarray:
    signed_root = SHAPER_Q * np.sinh((shaped - SHAPER_BLACK) / (1.0 - SHAPER_BLACK) * _SHAPER_SCALE)
    return np.sign(signed_root) * np.square(signed_root)


def _write_cube(path: Path, output: np.ndarray, header: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary: str | None = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="ascii", dir=path.parent, prefix=path.name + ".", suffix=".tmp", delete=False) as stream:
            temporary = stream.name
            stream.write(header + "\n")
            np.savetxt(stream, output, fmt="%.9f")
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)
    return path


def generate_hlg_lut_pair(profile: str, output_directory: str | Path, *, size: int = 65, shaper_size: int = 65536, exposure_ev: float = 0.0) -> dict[str, Path]:
    """Return {shaper, lut3d} paths; apply lut1d first, then lut3d.

    The high-resolution 1D camera decoder makes the 3D grid concentrate on
    perceptual differences. Scene-linear black is exactly at 0.125 (a grid
    point for the supported sizes), while negative source channels remain
    signed until after the gamut transform. This avoids a uniform camera-log
    cube's large HLG near-black interpolation error.
    """
    profile = normalize_profile(profile)
    if isinstance(size, bool) or not isinstance(size, int) or not 9 <= size <= 129 or (size - 1) % 8:
        raise ValueError("Shaped 3D LUT size must be 9..129 with size-1 divisible by 8 (normally 65).")
    if isinstance(shaper_size, bool) or not isinstance(shaper_size, int) or not 4096 <= shaper_size <= 65536:
        raise ValueError("Shaper size must be an integer from 4096 to 65536.")
    if not math.isfinite(exposure_ev) or not -10.0 <= exposure_ev <= 10.0:
        raise ValueError("Exposure must be finite and between -10 and 10 stops.")
    directory = Path(output_directory)
    decoder = decode_dlog2 if profile == "dlog2" else decode_dlog
    camera_values = np.linspace(0.0, 1.0, shaper_size)
    shaped = _linear_to_shaper(decoder(camera_values))
    shaper_header = "\n".join((
        f'TITLE "PocketRestore {profile} signed HDR input shaper"',
        "# First stage. Apply lut1d with linear interpolation before the matching HLG 3D LUT.",
        "# Official DJI decoder; signed asinh(sqrt(abs(linear))/0.25) shaper; black=0.125.",
        f"LUT_1D_SIZE {shaper_size}", "DOMAIN_MIN 0.0 0.0 0.0", "DOMAIN_MAX 1.0 1.0 1.0",
    ))
    shaper = _write_cube(directory / f"{profile}_hlg_shaper.cube", np.repeat(shaped[:, None], 3, axis=1), shaper_header)

    values = np.linspace(0.0, 1.0, size)
    blue, green, red = np.meshgrid(values, values, values, indexing="ij")
    shaped_rgb = np.stack((red, green, blue), axis=-1).reshape(-1, 3)
    output = _linear_to_hlg(_shaper_to_linear(shaped_rgb), profile, exposure_ev)
    cube_header = "\n".join((
        f'TITLE "PocketRestore {profile} shaped to BT2020 HLG"',
        f"# Second stage. Requires {profile}_hlg_shaper.cube first; use tetrahedral interpolation.",
        "# DJI CTL primaries; ITU-R BT.2100-3 HLG. Full normalized RGB input/output.",
        f"# Tool rendering: exposure={exposure_ev:g} EV; diffuse white=203 nits; nominal peak=1000 nits.",
        "# Luminance shoulder / hue-direction-preserving gamut compression are not Mimo's private look.",
        f"LUT_3D_SIZE {size}", "DOMAIN_MIN 0.0 0.0 0.0", "DOMAIN_MAX 1.0 1.0 1.0",
    ))
    cube = _write_cube(directory / f"{profile}_hlg.cube", output, cube_header)
    return {"shaper": shaper, "lut3d": cube}


def generate_hlg_lut(profile: str, output_path: str | Path, *, size: int = 65, exposure_ev: float = 0.0) -> Path:
    """Bake a red-fastest .cube for FFmpeg lut3d with tetrahedral interpolation.

    A 65-point cube is a practical preview/export approximation. A 129-point
    cube is available for better near-black accuracy, at a larger memory cost.
    Neither LUT grid makes this a spatial/adaptive match to Mimo's processing.
    """
    profile = normalize_profile(profile)
    if isinstance(size, bool) or not isinstance(size, int) or not 2 <= size <= 129:
        raise ValueError("LUT size must be an integer from 2 to 129.")
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    values = np.linspace(0.0, 1.0, size)
    blue, green, red = np.meshgrid(values, values, values, indexing="ij")
    rgb = np.stack((red, green, blue), axis=-1).reshape(-1, 3)
    output = transform_hlg(rgb, profile, exposure_ev=exposure_ev)
    header = "\n".join((
        f'TITLE "PocketRestore {profile} to BT2020 HLG"',
        f"# DJI official input CTL; ITU-R BT.2100-3 HLG OETF.",
        f"# Tool rendering: exposure={exposure_ev:g} EV; diffuse white=203 nits; nominal peak=1000 nits.",
        "# Luminance shoulder and grey-axis gamut compression are PocketRestore choices, not Mimo's look.",
        f"LUT_3D_SIZE {size}",
        "DOMAIN_MIN 0.0 0.0 0.0", "DOMAIN_MAX 1.0 1.0 1.0",
    ))
    return _write_cube(path, output, header)
