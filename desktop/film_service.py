"""PocketFilm bridge. Reads Omoide's index; never starts or edits face tasks."""
from __future__ import annotations
import copy
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import threading
import time
import urllib.request
from types import SimpleNamespace
from media_paths import canonical_path_key, media_path_aliases

VENDOR = Path(__file__).resolve().parent / 'pocketfilm'
sys.path.insert(0, str(VENDOR))
import scanner
import export_adapter
from job_store import JobStore


def read_config():
    with urllib.request.urlopen('http://127.0.0.1:8123/api/config/', timeout=10) as response:
        return json.load(response)


@contextmanager
def readonly(path):
    connection = sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True, timeout=5)
    connection.row_factory = sqlite3.Row
    try: yield connection
    finally: connection.close()


class FilmService:
    def __init__(self, cache, config_reader=read_config, probe=None, exporter=None):
        self.cache = Path(cache)
        self.config_reader = config_reader
        self.probe = probe or scanner.probe_video
        self.exporter = exporter or export_adapter.run_export
        self.lock = threading.RLock()
        self.states = {}
        self.active = None
        self.analysis = None
        self.cancel = threading.Event()
        self.progress = {}
        self.worker = None
        self.caps = None
        self.resources = {}

    def context(self):
        configuration = self.config_reader()
        root = Path(configuration['general']['data_dir']).resolve()
        database = root / 'database/omoide.db'
        key = hashlib.sha256(str(root).lower().encode()).hexdigest()[:20]
        with self.lock:
            if key not in self.states:
                folder = self.cache / key
                folder.mkdir(parents=True, exist_ok=True)
                store = JobStore(folder / 'film.sqlite3')
                store.recover_interrupted()
                metadata_path = folder / 'metadata.json'
                try: metadata = json.loads(metadata_path.read_text('utf8'))
                except (OSError, ValueError): metadata = {}
                self.states[key] = {'store': store, 'metadata': metadata, 'file': metadata_path, 'key': key, 'root': str(root)}
            state = self.states[key]
            state['media_dirs'] = configuration['general'].get('media_dirs', [])
        return database, state

    @staticmethod
    def media(database, identifiers):
        if not isinstance(identifiers, list) or not identifiers or len(identifiers) > 10000 or any(type(value) is not int or value < 1 for value in identifiers):
            raise ValueError('请选择有效的视频，单次最多 10000 个。')
        identifiers = list(dict.fromkeys(identifiers))
        records = {}
        with readonly(database) as connection:
            for offset in range(0, len(identifiers), 500):
                batch = identifiers[offset:offset+500]
                for row in connection.execute('SELECT id,path FROM media WHERE duration IS NOT NULL AND id IN (' + ','.join('?' for _ in batch) + ')', batch):
                    records[row['id']] = dict(row)
        if len(records) != len(identifiers): raise ValueError('部分视频已不在当前资料库中，请刷新。')
        return [records[value] for value in identifiers]

    @staticmethod
    def save_metadata(state):
        temporary = state['file'].with_suffix('.tmp')
        temporary.write_text(json.dumps(state['metadata'], ensure_ascii=False), 'utf8')
        temporary.replace(state['file'])

    def capabilities(self):
        with self.lock:
            if self.caps is None: self.caps = export_adapter.capabilities()
            return dict(self.caps)

    def catalog(self, ids):
        database, state = self.context()
        records = self.media(database, ids)
        with self.lock:
            result = {str(row['id']): copy.deepcopy(state['metadata'].get(os.path.normcase(row['path']))) for row in records}
        return {'items': result, 'profile': state['key']}

    def analyze(self, ids):
        database, state = self.context()
        records = self.media(database, ids)
        with self.lock:
            if self.analysis and self.analysis['running']: raise ValueError('视频类型读取正在进行，请稍候。')
            self.analysis = {'running': True, 'processed': 0, 'total': len(records), 'current': '', 'error': '', 'profile': state['key']}
            thread = threading.Thread(target=self._analyze, args=(state, records), daemon=True)
            thread.start()
        return self.status()

    def _analyze(self, state, records):
        tool = VENDOR/'restore/tools/ffprobe.exe'
        try:
            for record in records:
                with self.lock: self.analysis['current'] = Path(record['path']).name
                data = self.probe(record['path'], str(tool))
                with self.lock:
                    # A previous manual choice applies only to the identical source version.
                    old = state['metadata'].get(os.path.normcase(record['path']), {})
                    if (old.get('size'), old.get('mtime_ns')) == (data.get('size'), data.get('mtime_ns')) and old.get('manual_profile'):
                        data['manual_profile'] = old['manual_profile']
                    state['metadata'][os.path.normcase(record['path'])] = data
                    self.save_metadata(state)
                    self.analysis['processed'] += 1
        except Exception as error:
            with self.lock: self.analysis['error'] = str(error)
        finally:
            with self.lock: self.analysis['running'] = False

    def override(self, identifier, profile):
        if profile not in export_adapter.MANUAL_PROFILES | {None}: raise ValueError('颜色模式无效。')
        database, state = self.context()
        row = self.media(database, [identifier])[0]
        with self.lock:
            data = state['metadata'].get(os.path.normcase(row['path']))
            if not data: raise ValueError('请先读取此视频的类型。')
            current = Path(row['path']).stat()
            if (current.st_size, current.st_mtime_ns) != (data['size'], data['mtime_ns']): raise ValueError('原片已改变，请重新读取类型。')
            data['manual_profile'] = profile
            self.save_metadata(state)
        return {'saved': True}

    def enqueue(self, ids, output_dir, mode, skip_completed=True):
        database, state = self.context()
        rows = self.media(database, ids)
        if mode not in ('sdr', 'hlg'): raise ValueError('请选择普通 SDR 或 HDR HLG。')
        if not isinstance(output_dir, str) or not output_dir.strip() or not Path(output_dir).is_absolute(): raise ValueError('请选择完整的导出文件夹路径。')
        if Path(output_dir).exists() and not Path(output_dir).is_dir(): raise ValueError('导出位置不是文件夹。')
        with self.lock:
            if self.active and self.active[0] != state['key']: raise ValueError('另一个资料库有还原任务，请先暂停。')
            if self.progress.get('stopping'): raise ValueError('正在暂停，请等待当前视频清理完毕。')
            files = [copy.deepcopy(state['metadata'].get(os.path.normcase(row['path']))) for row in rows]
        if any(not item or item.get('status') == 'error' for item in files): raise ValueError('请先读取所选视频的类型，处理读取失败项。')
        prepared = export_adapter._prepare_files(files)
        caps = self.capabilities()
        if not caps.get('available'): raise ValueError(caps.get('unavailable_reason') or '还原组件不可用。')
        supported = caps.get('hdr_profiles' if mode == 'hlg' else 'sdr_profiles', [])
        if mode not in caps.get('supported_output_modes', []) or any(item['profile'] not in supported for item in prepared): raise ValueError('所选视频的颜色模式不支持此导出方式。')
        skipped = 0
        if skip_completed:
            filtered = []
            for item in files:
                if state['store'].duplicate_outputs(item, mode, output_dir): skipped += 1
                else: filtered.append(item)
            files = filtered
        if not files: return {'skipped': skipped, 'added': 0}
        job = state['store'].enqueue(files, output_dir, mode)
        self._start(state)
        return {'job_id': job['id'], 'added': job['added_count'], 'skipped': skipped}

    def _start(self, state):
        with self.lock:
            if self.active:
                if self.active[0] != state['key']: raise ValueError('另一个资料库正在还原。')
                return
            self.cancel.clear()
            self.active = (state['key'], '')
            self.worker = threading.Thread(target=self._work, args=(state,), daemon=True)
            self.worker.start()

    def _work(self, state):
        store = state['store']
        try:
            while not self.cancel.is_set():
                job = store.pending_job()
                if not job: break
                files = store.runnable_files(job['id'])
                indices = [index for index, _ in files]
                store.mark_job_running(job['id'])
                with self.lock:
                    self.active = (state['key'], job['id'])
                    self.progress = {'job_id': job['id'], 'fraction': 0, 'current': '', 'eta_seconds': None, 'stopping': False}
                started = time.monotonic()
                def on_event(event):
                    index, kind = event.get('index'), event.get('type')
                    if type(index) is int and 0 <= index < len(indices):
                        if kind in ('input_preparing', 'source_snapshot', 'item_started'):
                            store.mark_item(job['id'], indices[index], 'running', source_snapshot=event if kind == 'source_snapshot' else None)
                        elif kind == 'item_done' and event.get('output'):
                            store.mark_item(job['id'], indices[index], 'succeeded', output=event['output'], source_snapshot=event.get('source_snapshot'))
                        elif kind == 'item_error': store.mark_item(job['id'], indices[index], 'failed', error=event.get('error', '还原失败'))
                        with self.lock:
                            self.progress['current'] = Path(files[index][1]['path']).name
                            fraction = min(1., max(0., float(event.get('fraction') or (1 if kind in ('item_done','item_error') else 0))))
                            overall = (index + fraction) / len(indices)
                            self.progress['fraction'] = overall
                            elapsed = time.monotonic() - started
                            self.progress['eta_seconds'] = elapsed*(1-overall)/overall if elapsed >= 3 and overall > 0 else None
                            self.progress['stage'] = kind
                try:
                    result = self.exporter([item for _, item in files], job['output_dir'], job['mode'], on_event, self.cancel)
                    store.finish_job(job['id'], cancelled=result.get('cancelled', False), error=result.get('error') or '')
                except Exception as error: store.finish_job(job['id'], error=str(error))
        finally:
            with self.lock:
                self.active = None
                self.progress = {}
                # A request may enqueue work while the previous queue drains.
                if not self.cancel.is_set() and store.pending_job(): self._start(state)

    def control(self, action, job_id=None):
        _, state = self.context()
        with self.lock:
            if action == 'pause':
                if self.active and self.active[0] != state['key']: raise ValueError('当前任务属于另一个资料库。')
                self.cancel.set()
                if self.active: self.progress['stopping'] = True
                return {'paused': True}
            if self.active and self.active[0] != state['key']: raise ValueError('另一个资料库正在还原。')
            if self.progress.get('stopping'): raise ValueError('正在暂停，请稍候。')
            if action == 'resume': state['store'].resume(job_id)
            elif action == 'retry': state['store'].retry_failed(job_id)
            else: raise ValueError('不支持此操作。')
            self._start(state)
        return {'started': True}

    def status(self):
        _, state = self.context()
        jobs = state['store'].jobs()
        with self.lock:
            return {'profile': state['key'], 'jobs': jobs, 'progress': dict(self.progress) if self.active and self.active[0] == state['key'] else {}, 'analysis': dict(self.analysis) if self.analysis and self.analysis['profile'] == state['key'] else None,
                    'busy_other_profile': bool(self.active and self.active[0] != state['key']), 'resources':dict(self.resources), 'face_processing_started': False, 'gray_cleanup_enabled': False, 'gray_hiding_enabled': True}

    def visibility(self):
        """Only hide unchanged originals backed by a verified successful output."""
        _, state = self.context()
        aliases = media_path_aliases([SimpleNamespace(path=item['path']) for item in state['media_dirs']])
        hidden, checked = {}, {}
        for item in state['store'].restored_gray_items():
            source = json.loads(item['video_json'])['path']
            key = canonical_path_key(source, aliases)
            if key == canonical_path_key(item['output'], aliases):
                continue
            if key not in checked:
                try:
                    stat = Path(source).stat()
                    checked[key] = (stat.st_size, stat.st_mtime_ns)
                except (OSError, ValueError):
                    checked[key] = None
            if checked[key] == (item['source_size'], item['source_mtime_ns']):
                hidden[key] = source
        return {'profile': state['key'], 'data_dir': state['root'], 'hidden_sources': sorted(hidden.values()), 'face_processing_started': False}

    def output_file(self, job_id, index):
        _, state = self.context()
        job = state['store'].get_job(job_id)
        item = next((item for item in job['items'] if item['index'] == index), None)
        if not item or item['status'] != 'succeeded' or not item['output_exists']: raise ValueError('成片已移动、更改或无法访问。')
        return Path(item['output'])

    def close(self):
        self.cancel.set()
        if self.worker: self.worker.join(timeout=55)
