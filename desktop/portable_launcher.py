"""Windows portable entry point; no installed Python or pre-existing drive required."""
from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import socket
import subprocess
import sys

from storage_paths import configure_storage, install_dir, write_json

TITLE = 'Omoide 视频人物相册'


def notify(message: str, error: bool = False):
    ctypes.windll.user32.MessageBoxW(None, message, TITLE, 16 if error else 64)


def choose_storage() -> Path | None:
    class BrowseInfo(ctypes.Structure):
        _fields_ = [('hwndOwner', wintypes.HWND), ('pidlRoot', ctypes.c_void_p),
                    ('pszDisplayName', wintypes.LPWSTR), ('lpszTitle', wintypes.LPCWSTR),
                    ('ulFlags', wintypes.UINT), ('lpfn', ctypes.c_void_p),
                    ('lParam', wintypes.LPARAM), ('iImage', ctypes.c_int)]
    shell = ctypes.windll.shell32
    shell.SHBrowseForFolderW.argtypes = [ctypes.POINTER(BrowseInfo)]
    shell.SHBrowseForFolderW.restype = ctypes.c_void_p
    shell.SHGetPathFromIDListW.argtypes = [ctypes.c_void_p, wintypes.LPWSTR]
    ctypes.windll.ole32.CoInitialize(None)
    try:
        buffer = ctypes.create_unicode_buffer(32768)
        info = BrowseInfo(None, None, buffer, '选择保存资料库和缓存的位置（会新建 Omoide-Data 文件夹）',
                          0x41, None, 0, 0)
        item = shell.SHBrowseForFolderW(ctypes.byref(info))
        if not item:
            return None
        try:
            if not shell.SHGetPathFromIDListW(item, buffer):
                raise ValueError('请选择本机磁盘或已映射的文件夹。')
            return Path(buffer.value) / 'Omoide-Data'
        finally:
            ctypes.windll.ole32.CoTaskMemFree.argtypes = [ctypes.c_void_p]
            ctypes.windll.ole32.CoTaskMemFree(item)
    finally:
        ctypes.windll.ole32.CoUninitialize()


def port_in_use(port: int) -> bool:
    with socket.socket() as probe:
        probe.settimeout(.3)
        return probe.connect_ex(('127.0.0.1', port)) == 0


def selftest(destination: Path):
    import hashlib
    import scanner
    import export_adapter
    from resource_control import MODES
    from film_service import FilmService
    from restored_library_worker import pending_outputs
    from auto_group_worker import pending_jobs
    application = install_dir()
    assert not (destination / 'config/bootstrap.yaml').exists(), 'Use a fresh test directory'
    configured = configure_storage(destination, application)
    config = destination / 'library/config.yaml'
    config.write_text(config.read_text('utf8') + '\n', 'utf8')
    before = hashlib.sha256(config.read_bytes()).hexdigest()
    configure_storage(destination, application)
    assert hashlib.sha256(config.read_bytes()).hexdigest() == before
    assert Path(os.environ['OMOIDE_CACHE_DIR']).is_relative_to(destination.resolve())
    assert pending_outputs(destination / 'library') == []
    assert pending_jobs([], []) == []
    assert MODES['balanced'] == 50
    assert callable(scanner.probe_video) and callable(FilmService.context)
    command = export_adapter._resolve_backend()
    assert command and Path(command[0][0]).is_file(), 'Restore component not found'
    result = {'success': True, 'checks': 8, 'storage': configured,
              'restore_cli_found': True, 'existing_config_preserved': True,
              'services_started': False, 'models_loaded': False}
    write_json(destination / 'launcher-selftest.json', result)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--role', choices=['grouping', 'film', 'importer'])
    parser.add_argument('--storage-root', type=Path)
    parser.add_argument('--selftest', type=Path)
    args = parser.parse_args()
    if args.selftest:
        selftest(args.selftest.resolve())
        return
    if args.role:
        if not os.environ.get('OMOIDE_INSTALL_DIR') or not os.environ.get('OMOIDE_CACHE_DIR'):
            raise ValueError('请从相册启动器打开。')
        if args.role == 'grouping':
            from auto_group_worker import main as run
        elif args.role == 'film':
            from film_server import main as run
        else:
            from restored_library_worker import main as run
        run()
        return
    application = install_dir()
    # Do not connect new helper services to an unrelated running installation.
    if any(port_in_use(port) for port in (8123, 18124, 18125, 18126)):
        notify('相册或还原服务已在运行。请继续使用已打开的相册；如要运行此版本，请先正常关闭另一版本。')
        return
    storage_file = application / 'storage.json'
    if args.storage_root:
        storage = args.storage_root
    elif storage_file.exists():
        storage = Path(json.loads(storage_file.read_text('utf8'))['root'])
    else:
        storage = choose_storage()
        if storage is None:
            return
    configured = configure_storage(storage, application)
    write_json(storage_file, {'root': configured['root']})
    write_json(application / 'omoide-0.7.5-cpu/_internal/dist/cache-location.json',
               {'root': configured['OMOIDE_CACHE_DIR']})
    flags = subprocess.CREATE_NO_WINDOW
    executable = application / 'omoide-0.7.5-cpu/omoide-0.7.5-cpu.exe'
    if not executable.is_file():
        raise FileNotFoundError('主程序缺失，请完整解压下载的便携包。')
    subprocess.Popen([str(executable)], cwd=executable.parent, creationflags=flags)
    command = [sys.executable] if getattr(sys, 'frozen', False) else [sys.executable, str(Path(__file__))]
    for role in ('grouping', 'film', 'importer'):
        subprocess.Popen([*command, '--role', role], cwd=application, creationflags=flags)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        if '--selftest' in sys.argv:
            index = sys.argv.index('--selftest') + 1
            write_json(Path(sys.argv[index]) / 'launcher-selftest.json', {'success': False, 'error': str(error)})
            sys.exit(1)
        notify(str(error), error=True)
        sys.exit(1)
