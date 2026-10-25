"""Rebuild selected Python modules inside an existing compatible PyInstaller runtime.

Native libraries and the original bootloader are preserved. Requires Python 3.12
and PyInstaller, matching the base Windows runtime. Does not execute the app.
"""
import argparse
import hashlib
import json
import marshal
from pathlib import Path
import struct
import zlib
from PyInstaller.archive.readers import CArchiveReader
from PyInstaller.archive.writers import CArchiveWriter


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--base', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--modules', nargs='+', required=True)
    args = parser.parse_args()
    if args.base.resolve() == args.output.resolve():
        raise ValueError('Output must be separate from the base executable')
    reader = CArchiveReader(str(args.base))
    archive = reader.open_embedded_archive('PYZ.pyz')
    replacements = {}
    for module in args.modules:
        file = args.source / (module.replace('.', '/') + '.py')
        if not file.is_file():
            file = args.source / module.replace('.', '/') / '__init__.py'
        replacements[module] = compile(file.read_text('utf8'), str(file.relative_to(args.source)), 'exec')
    body = bytearray(reader.extract('PYZ.pyz')[:17])
    toc = []
    for name, (kind, offset, length) in archive.toc.items():
        if name in replacements:
            compressed = zlib.compress(marshal.dumps(replacements.pop(name)), 6)
        else:
            with args.base.open('rb') as stream:
                stream.seek(archive._start_offset + offset)
                compressed = stream.read(length)
        toc.append((name, (kind, len(body), len(compressed))))
        body.extend(compressed)
    for name, code in replacements.items():
        compressed = zlib.compress(marshal.dumps(code), 6)
        toc.append((name, (0, len(body), len(compressed))))
        body.extend(compressed)
    toc_offset = len(body)
    body.extend(marshal.dumps(toc))
    body[8:12] = struct.pack('!i', toc_offset)
    package, package_toc = bytearray(), []
    for option in reader.options:
        package_toc.append((0, 0, 0, 0, 'o', option))
    for name, (offset, length, size, compressed, kind) in reader.toc.items():
        if name == 'PYZ.pyz':
            raw = bytes(body)
            data = zlib.compress(raw, 9) if compressed else raw
            size = len(raw)
        else:
            with args.base.open('rb') as stream:
                stream.seek(reader._start_offset + offset)
                data = stream.read(length)
        package_toc.append((len(package), len(data), size, compressed, kind, name))
        package.extend(data)
    offset = len(package)
    serialized = CArchiveWriter._serialize_toc(package_toc)
    package.extend(serialized)
    with args.base.open('rb') as stream:
        stream.seek(reader._end_offset - reader._COOKIE_LENGTH)
        cookie = list(struct.unpack(reader._COOKIE_FORMAT, stream.read(reader._COOKIE_LENGTH)))
    cookie[1:4] = [len(package) + reader._COOKIE_LENGTH, offset, len(serialized)]
    package.extend(struct.pack(reader._COOKIE_FORMAT, *cookie))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(args.base.read_bytes()[:reader._start_offset] + package)
    check = CArchiveReader(str(args.output)).open_embedded_archive('PYZ.pyz')
    for name in args.modules:
        assert check.extract(name)
    print(json.dumps({'sha256': hashlib.sha256(args.output.read_bytes()).hexdigest(), 'modules': args.modules}))


if __name__ == '__main__':
    main()
