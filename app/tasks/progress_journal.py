"""Durable task display data; no face vectors or source files are changed here."""
from contextlib import contextmanager
from contextvars import ContextVar
import json
from pathlib import Path
import sqlite3
import threading
import time

active_task = ContextVar('album_active_task', default=None)
_last_write = {}
_lock = threading.RLock()

def journal_path():
    from app.config import settings
    return settings.general.database_dir / 'task-progress.sqlite'

@contextmanager
def connection():
    path = journal_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=3)
    db.row_factory = sqlite3.Row
    try:
        db.executescript('''CREATE TABLE IF NOT EXISTS progress(task_id TEXT PRIMARY KEY,payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS items(task_id TEXT,media_id INTEGER,processor TEXT,path TEXT,status TEXT,reason TEXT,updated_at REAL,
                PRIMARY KEY(task_id,media_id,processor));''')
        with db: yield db
    finally: db.close()

def read(task_id):
    if not journal_path().exists(): return {}
    with connection() as db:
        row = db.execute('SELECT payload FROM progress WHERE task_id=?',(task_id,)).fetchone()
        return json.loads(row[0]) if row else {}

def update(task_id, force=False, **changes):
    with _lock:
        now = time.time()
        if not force and now - _last_write.get(task_id,0) < 1: return
        try:
            with connection() as db:
                row = db.execute('SELECT payload FROM progress WHERE task_id=?',(task_id,)).fetchone()
                current = json.loads(row[0]) if row else {}
                if changes.get('current_item') != current.get('current_item') and changes.get('current_item'):
                    for key in ('frame_current','frame_total','video_second','video_duration'): current.pop(key,None)
                current.update(changes); current['updated_at_epoch'] = now
                db.execute('INSERT OR REPLACE INTO progress VALUES(?,?)',(task_id,json.dumps(current,ensure_ascii=False,default=str)))
            _last_write[task_id] = now
        except (OSError,sqlite3.Error):
            from app.logger import logger
            logger.warning('Could not save progress journal for %s',task_id,exc_info=True)

def item(task_id, media_id, processor, path, status, reason=''):
    with _lock, connection() as db:
        db.execute('INSERT OR REPLACE INTO items VALUES(?,?,?,?,?,?,?)',(task_id,media_id,processor,str(path),status,str(reason),time.time()))

def task_items(task_id, limit=200, offset=0):
    if not journal_path().exists(): return {'items':[],'total':0}
    with connection() as db:
        total = db.execute('SELECT count(*) FROM items WHERE task_id=?',(task_id,)).fetchone()[0]
        rows = db.execute('SELECT * FROM items WHERE task_id=? ORDER BY updated_at DESC LIMIT ? OFFSET ?',(task_id,limit,offset)).fetchall()
        return {'items':[dict(row) for row in rows],'total':total}

def item_counts(task_id):
    if not journal_path().exists(): return {}
    with connection() as db:
        return dict(db.execute('SELECT status,count(*) FROM items WHERE task_id=? GROUP BY status',(task_id,)))

def media_item_states(task_id, processor):
    path = journal_path()
    if not path.exists(): return {}
    try:
        with sqlite3.connect(path.resolve().as_uri()+'?mode=ro', uri=True, timeout=3) as db:
            return dict(db.execute('SELECT media_id,status FROM items WHERE task_id=? AND processor=?',(task_id,processor)))
    except sqlite3.OperationalError:
        return {}

def historical_failure(task_id):
    """Recover the reason for old failures that predate the journal."""
    from app.config import settings
    logfile = settings.general.data_dir / 'logs/omoide.log'
    try:
        with logfile.open('rb') as stream:
            stream.seek(max(0,logfile.stat().st_size-4*1024*1024))
            lines = stream.read().decode('utf8','replace').splitlines()
        for index,line in enumerate(lines):
            if f'Background task {task_id} crashed' in line:
                trace = []
                for next_line in lines[index+1:index+35]:
                    if next_line[:4].isdigit(): break
                    trace.append(next_line)
                return next((line for line in reversed(trace) if line and not line.startswith(' ')), '任务异常中断，请查看日志。')[:1500]
    except OSError: pass
    return ''
