"""Local companion: finish face-processing jobs by running Omoide's own grouping task."""
from __future__ import annotations
import hashlib
import json
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
from storage_paths import cache_dir, install_dir
import socket
import sqlite3
import time
import urllib.request
import atexit
import threading
import os
import uuid
from resource_control import ResourceController
from resource_server import create_server

BASE = 'http://127.0.0.1:8123'
INSTALL = install_dir()
CACHE = cache_dir()
STATE_FILE = CACHE / 'auto-group-state.json'
STATUS_FILE = INSTALL / 'omoide-0.7.5-cpu/_internal/dist/auto-group-status.json'
RECOGNITION_TYPES = {'process_media', 'run_processor', 'run_processor_for_media', 'backfill_face_quality', 'backfill_face_timestamps'}
TERMINAL = {'completed', 'cancelled'}

def api(path, post=False):
    request = urllib.request.Request(BASE + path, data=b'' if post else None, method='POST' if post else 'GET')
    with urllib.request.urlopen(request, timeout=15) as response:
        data = response.read()
        return json.loads(data) if data else None

def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f'.{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp')
    try:
        temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), 'utf-8')
        for attempt in range(5):
            try:
                temporary.replace(path)
                break
            except PermissionError:
                if attempt == 4: raise
                time.sleep(.03)
    finally:
        try: temporary.unlink(missing_ok=True)
        except OSError: pass

def pending_jobs(rows, handled):
    return [row for row in rows if row['task_type'] in RECOGNITION_TYPES and row['status'] in TERMINAL and row['processed'] > 0 and row['id'] not in handled]

def snapshot(database):
    # Short read-only transactions; this service never edits the photo/person database.
    with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=5) as connection:
        connection.row_factory = sqlite3.Row
        tasks = [dict(row) for row in connection.execute('SELECT id, task_type, status, processed, total, created_at FROM processingtask ORDER BY created_at DESC LIMIT 200')]
        counts = dict(connection.execute('SELECT "faces", count(*) FROM face UNION ALL SELECT "unassigned", count(*) FROM face WHERE person_id IS NULL UNION ALL SELECT "people", count(*) FROM person'))
    return tasks, counts

def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(CACHE / 'auto-group.log', maxBytes=1_000_000, backupCount=2, encoding='utf-8')
    logging.basicConfig(handlers=[handler], level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    # One companion per computer, even if the desktop shortcut is clicked twice.
    try: control_server = create_server()
    except OSError: return
    controller = ResourceController(INSTALL, CACHE)
    control_server.controller = controller
    threading.Thread(target=control_server.serve_forever, daemon=True).start()
    atexit.register(control_server.server_close)
    atexit.register(controller.close)
    atexit.register(control_server.shutdown)
    try: state = json.loads(STATE_FILE.read_text('utf-8'))
    except (OSError, ValueError): state = {'profiles': {}}
    ever_connected = False
    last_connected = time.monotonic()
    logging.info('Automatic grouping companion started')
    while True:
        try:
            config = api('/api/config/')
            ever_connected = True
            last_connected = time.monotonic()
            database = (Path(config['general']['database_dir']) / 'omoide.db').resolve()
            key = hashlib.sha256(str(database).lower().encode()).hexdigest()[:20]
            rows, counts = snapshot(database)
            profiles = state.setdefault('profiles', {})
            if key not in profiles:
                # Existing historical jobs are already reviewed/handled at installation.
                profiles[key] = {'handled': [row['id'] for row in rows if row['task_type'] in RECOGNITION_TYPES and row['status'] in TERMINAL], 'pending_cluster': None}
                atomic_json(STATE_FILE, state)
            profile = profiles[key]
            enabled = config['general']['enable_people'] and config['scan']['auto_cluster_on_scan']
            status = {'enabled': enabled, 'phase': 'ready' if enabled else 'disabled', 'updated_at': time.time(), 'counts': counts, 'worker_pid': __import__('os').getpid(), 'resources': controller.apply()}
            waiting = profile.get('pending_cluster')
            if waiting:
                result = api('/api/tasks/' + waiting['id'])
                status['cluster_task'] = result['id']
                if result['status'] == 'completed':
                    profile['handled'] = list(dict.fromkeys(profile['handled'] + waiting['jobs']))[-512:]
                    profile['pending_cluster'] = None
                    profile['retry_after'] = 0
                    profile['failures'] = 0
                    atomic_json(STATE_FILE, state)
                    logging.info('Grouping completed: task=%s, processed=%s', result['id'], result['processed'])
                elif result['status'] in ('failed', 'cancelled'):
                    profile['pending_cluster'] = None
                    profile['retry_after'] = time.time() + 60
                    profile['failures'] = profile.get('failures', 0) + 1
                    atomic_json(STATE_FILE, state)
                    status['phase'] = 'error'
                    logging.warning('Grouping did not finish: %s', result['status'])
                else: status['phase'] = 'grouping'
            jobs = pending_jobs(rows, set(profile['handled']))
            active = [row for row in rows if row['status'] in ('running', 'pending') and (row['task_type'] in RECOGNITION_TYPES or row['task_type'] == 'cluster_persons')]
            if enabled and jobs and not profile.get('pending_cluster'):
                if active: status['phase'] = 'waiting'
                elif profile.get('failures', 0) >= 3 or profile.get('retry_after', 0) > time.time(): status['phase'] = 'error'
                elif counts['unassigned'] == 0:
                    profile['handled'] = list(dict.fromkeys(profile['handled'] + [job['id'] for job in jobs]))[-512:]
                    atomic_json(STATE_FILE, state)
                else:
                    task = api('/api/tasks/cluster_persons', post=True)
                    profile['pending_cluster'] = {'id': task['id'], 'jobs': [job['id'] for job in jobs]}
                    atomic_json(STATE_FILE, state)
                    status['phase'] = 'grouping'
                    status['cluster_task'] = task['id']
                    logging.info('Started automatic grouping for %d completed recognition jobs: %s', len(jobs), task['id'])
            atomic_json(STATUS_FILE, status)
        except Exception as error:
            if time.monotonic() - last_connected > (30 if ever_connected else 90):
                logging.info('Omoide unavailable; companion exits')
                return
            logging.warning('%s: %s', type(error).__name__, error)
        time.sleep(3)

if __name__ == '__main__':
    main()
