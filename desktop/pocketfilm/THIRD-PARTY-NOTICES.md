# Third-party components

PocketFilm uses dynamically linked PySide6 / Qt 6 under the LGPLv3-compatible open-source distribution. Corresponding upstream source and license information: https://code.qt.io/ and https://doc.qt.io/qtforpython-6/licenses.html . The application source is supplied separately for modification and rebuilding; the Qt libraries remain separate in `_internal`.

Python: https://www.python.org/psf/license/ . PyInstaller bootloader exception: https://pyinstaller.org/en/stable/license.html .

FFmpeg and FFprobe: reused from the user's existing Gyan FFmpeg 7.0.2 essentials build. The original distribution LICENSE and README accompany the tools. Source and build information: https://www.gyan.dev/ffmpeg/builds/ and https://ffmpeg.org/ .

The DJI Keys metadata field research is based on dji-clip-color (Apache-2.0): https://github.com/erik-sutton95/dji-clip-color . The optional djmd field research is based on dlog_color_classifier (MIT): https://github.com/TzRay/dlog_color_classifier . PocketFilm implements its own bounded parser; these reverse-engineered metadata rules are not an official schema guarantee.

The restore component includes separate notices, DJI official LUT attribution, and any verified HDR transform source information in its `restore` directory.
