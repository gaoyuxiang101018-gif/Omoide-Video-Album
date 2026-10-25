# Components and color references

Python: https://www.python.org/psf/license/ . PyInstaller bootloader exception: https://pyinstaller.org/en/stable/license.html .

FFmpeg and FFprobe are the user's existing Gyan 7.0.2 essentials GPL build. Original LICENSE and README are in tools. Source/build information: https://www.gyan.dev/ffmpeg/builds/ and https://ffmpeg.org/ .

SDR conversion assets are DJI Pocket 4P official D-Log / D-Log 2 Rec.709 LUTs. Attribution, original file names and SHA-256 hashes are in _internal/pocket_restore/assets/lut_sources.json. DJI download guidance: https://repair.dji.com/help/content?customId=01700007105&lang=zh-CN&paperDocType=ARTICLE&re=CN&spaceId=17 .

The generated HDR LUTs use the inverse transfer functions and gamut coordinates published in DJI's official ACES workflow references. Reference files and hashes are in color_references. Our tone rendering preset and gamut compression are independently implemented; DJI Mimo appearance matching is not verified.

DJI ACES references: https://www.dji.com/downloads/softwares/aces-workflow-dlog-2 . HLG standard: https://www.itu.int/rec/R-REC-BT.2100 .
