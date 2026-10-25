"""Storage routing shared by the portable launcher and companion services."""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys


def install_dir() -> Path:
    configured = os.environ.get('OMOIDE_INSTALL_DIR')
    if configured:
        return Path(configured).resolve()
    if getattr(sys, 'frozen', False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


def cache_dir() -> Path:
    return Path(os.environ.get('OMOIDE_CACHE_DIR', str(install_dir() / 'Data/cache'))).resolve()


def write_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + f'.{os.getpid()}.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', 'utf8')
    temporary.replace(path)


def configure_storage(root: Path, application: Path | None = None) -> dict:
    application = application or install_dir()
    root = root.expanduser().resolve()
    config, cache, library = root / 'config', root / 'cache', root / 'library'
    for folder in (config, cache, library):
        folder.mkdir(parents=True, exist_ok=True)
    bootstrap = config / 'bootstrap.yaml'
    if not bootstrap.exists():
        write_json(bootstrap, {'active_profile': str(library),
                              'profiles': [{'name': '我的资料库', 'path': str(library)}]})
    settings = library / 'config.yaml'
    if not settings.exists():
        write_json(settings, {
            'general': {'port': 8123, 'enable_people': True, 'media_dirs': [],
                        'update_check_repo': None,
                        'ffmpeg_path': str(application / 'pocketfilm/restore/tools/ffmpeg.exe')},
            'scan': {'auto_scan': False, 'auto_clean_on_scan': False,
                     'auto_cleanup_without_review': False, 'auto_cluster_on_scan': True},
            'tagging': {'auto_tagging': False},
            'processors': {'prefer_gpu': True, 'image_embedding_processor_active': False},
            'video': {'auto_scene_detection': False, 'max_frames_per_video': 1800},
            'face_recognition': {'face_detection_model': 'buffalo_l',
                                 'face_detection_max_video_frames': 0},
        })
    environment = {'OMOIDE_INSTALL_DIR': str(application), 'OMOIDE_CONFIG_DIR': str(config),
                   'OMOIDE_CACHE_DIR': str(cache)}
    os.environ.update(environment)
    tools = application / 'pocketfilm/restore/tools'
    os.environ['PATH'] = str(tools) + os.pathsep + os.environ.get('PATH', '')
    return {'root': str(root), 'library': str(library), **environment}
