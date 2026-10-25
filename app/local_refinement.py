"""Add-only range inference. Decode/infer first, then commit new faces atomically."""
import json
import math
from pathlib import Path
import shutil
import subprocess
import threading
import time
import uuid
import weakref
from datetime import datetime, timezone

import cv2
import numpy as np
from PIL import Image
from fastapi import HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlmodel import Session

import app.database as db
from app.config import settings
from app.models import Face, Media, ProcessingTask
from app.person_review import assert_idle, ensure_schema as review_schema, rows, _refresh
from app.presentation import ensure_writable
from app.tasks.state import set_task_progress, clear_task_progress, record_task_failure

_lock = threading.RLock()
_ready = weakref.WeakSet()
_cancel_events = {}


class Request(BaseModel):
    media_id: int = Field(gt=0)
    start: float = Field(ge=0, allow_inf_nan=False)
    end: float = Field(gt=0, allow_inf_nan=False)
    interval: float = Field(default=0.5, ge=0.25, le=2, allow_inf_nan=False)
    profile_key: str


def ensure_schema():
    review_schema()
    with _lock:
        if db.engine in _ready:
            return
        with db.engine.begin() as c:
            c.exec_driver_sql('''CREATE TABLE IF NOT EXISTS face_refinement_job (
                id TEXT PRIMARY KEY,task_id TEXT UNIQUE NOT NULL,created_at TEXT NOT NULL,
                media_id INTEGER NOT NULL,start REAL NOT NULL,end REAL NOT NULL,interval REAL NOT NULL,
                status TEXT NOT NULL,total INTEGER NOT NULL,processed INTEGER NOT NULL DEFAULT 0,
                added INTEGER NOT NULL DEFAULT 0,matched INTEGER NOT NULL DEFAULT 0,duplicates INTEGER NOT NULL DEFAULT 0,
                error TEXT,manifest TEXT NOT NULL)''')
        _ready.add(db.engine)


def _gray_source(path):
    # A successful restoration excludes the source even if its output is temporarily offline.
    from app.media_paths import media_path_aliases, canonical_path_key
    from app.restored_media import RESTORE_CACHE, profile_key
    import sqlite3
    queue = RESTORE_CACHE / profile_key() / 'film.sqlite3'
    if not queue.is_file():
        return False
    aliases = media_path_aliases(settings.general.media_dirs)
    key = canonical_path_key(path, aliases)
    with sqlite3.connect(queue.resolve().as_uri() + '?mode=ro', uri=True) as c:
        for (video_json,) in c.execute("SELECT video_json FROM export_items WHERE status='succeeded'"):
            try:
                if canonical_path_key(json.loads(video_json)['path'], aliases) == key:
                    return True
            except (ValueError, KeyError, TypeError):
                continue
    return False


def points(request, duration):
    if request.end <= request.start or request.end > duration + 0.001 or request.end - request.start > 600:
        raise HTTPException(400, '局部补查每次最多10分钟，且范围须在视频内')
    if request.interval not in (0.25, 0.5, 1, 2):
        raise HTTPException(400, '采样间隔请选择0.25、0.5、1或2秒')
    count = math.ceil((request.end - request.start) / request.interval)
    if count > 2400:
        raise HTTPException(400, '单次最多2400个采样点，请缩小范围')
    return [round(request.start + i * request.interval, 6) for i in range(count) if request.start + i * request.interval < min(request.end, duration)]


def jobs(session):
    ensure_schema()
    items = rows(session, '''SELECT j.id,j.task_id,j.created_at,j.media_id,m.filename,j.start,j.end,j.interval,j.status,
        j.total,j.processed,j.added,j.matched,j.duplicates,j.error,t.status task_status
        FROM face_refinement_job j LEFT JOIN processingtask t ON t.id=j.task_id LEFT JOIN media m ON m.id=j.media_id
        ORDER BY j.created_at DESC LIMIT 30''', {})
    for item in items:
        status = item.pop('task_status')
        if item['status'] == 'running' and status not in ('running', 'pending'):
            item['status'], item['error'] = 'failed', item['error'] or '程序已重启；已有识别数据保留，可重新补查'
    return {'items': items}


def start(session, background, request):
    ensure_writable(); ensure_schema()
    from app.person_views import state
    from app.tasks.recognition_activity import submission_lock
    from app.tasks.common import create_and_run_task
    from app.tasks import progress_journal as journal
    with submission_lock:
        assert_idle(session)
        if state(session)['profile_key'] != request.profile_key:
            raise HTTPException(409, '资料库已切换，请重新打开')
        media = session.get(Media, request.media_id)
        if not media or not media.duration:
            raise HTTPException(404, '视频不存在')
        timestamps = points(request, media.duration)
        if _gray_source(media.path):
            raise HTTPException(409, '这是已经还原过的原灰片，请对还原成片补查')
        stat = Path(media.path).stat()
        manifest = {**request.model_dump(), 'path': media.path, 'size': stat.st_size, 'mtime': stat.st_mtime_ns,
                    'thumb_root': str(settings.general.thumb_dir), 'profile': str(settings.general.data_dir)}
        identifier, engine = uuid.uuid4().hex, db.engine
        event = threading.Event()
        _cancel_events[identifier] = event
        task = create_and_run_task(session, background, 'refine_face_range', lambda tid: run(engine, identifier, tid), reuse_running=False)
        task.status = 'running'; task.total = len(timestamps); task.started_at = datetime.now(timezone.utc)
        session.add(task)
        session.execute(text('''INSERT INTO face_refinement_job
            (id,task_id,created_at,media_id,start,end,interval,status,total,manifest)
            VALUES(:id,:task,:at,:media,:start,:end,:interval,'running',:total,:manifest)'''),
            {'id': identifier, 'task': task.id, 'at': datetime.now(timezone.utc).isoformat(), 'media': media.id,
             'start': request.start, 'end': request.end, 'interval': request.interval, 'total': len(timestamps), 'manifest': json.dumps(manifest, ensure_ascii=False)})
        session.commit()
        journal.update(task.id, force=True, processor_names=['faces'], selected_media_ids=[media.id], local_range=[request.start, request.end])
    return next(item for item in jobs(session)['items'] if item['id'] == identifier)


class Cancelled(Exception):
    pass


def cancelled(engine, identifier, task_id):
    if _cancel_events.get(identifier, threading.Event()).is_set():
        return True
    with Session(engine) as s:
        status = s.execute(text('SELECT status FROM processingtask WHERE id=:id'), {'id': task_id}).scalar()
        return status not in ('pending', 'running')


def decode(path, timestamp, ffmpeg, should_cancel):
    from app.frames import PROCESSING_SCALE
    command = [str(ffmpeg), '-hide_banner', '-nostdin', '-v', 'error', '-threads', '2', '-ss', str(timestamp), '-i', str(path),
               '-an', '-sn', '-dn', '-vf', PROCESSING_SCALE, '-threads', '1', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-']
    process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    deadline = time.monotonic() + 45
    try:
        while True:
            if should_cancel():
                raise Cancelled()
            if time.monotonic() > deadline:
                raise RuntimeError('读取采样画面超时，请检查原片和网络盘')
            try:
                output, error = process.communicate(timeout=0.2)
                break
            except subprocess.TimeoutExpired:
                continue
        if process.returncode or not output:
            raise RuntimeError('无法读取采样画面：' + error.decode('utf8', errors='replace')[-300:])
        image = cv2.imdecode(np.frombuffer(output, np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            raise RuntimeError('采样画面无法解码')
        return cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
    finally:
        if process.poll() is None:
            process.terminate()
            try: process.wait(timeout=3)
            except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=3)


def _candidates(processor, image, timestamp, root, thumb_root):
    faces = processor._analyze(image)
    h, w = image.shape[:2]
    if processor._needs_padded_retry(faces, h, w):
        faces = processor._merge_faces(faces, processor._detect_with_padding_fallback(image, '局部补查'))
    result = []
    for face in faces:
        confidence = float(getattr(face, 'det_score', 0))
        if confidence < settings.face_recognition.face_recognition_min_confidence:
            continue
        x1, y1, x2, y2 = map(int, face.bbox)
        bbox = [x1, y1, x2-x1, y2-y1]
        crop = processor._crop_with_margin(image, bbox, 0.2)
        if crop.size == 0 or crop.shape[0]*crop.shape[1] < settings.face_recognition.face_recognition_min_face_pixels:
            continue
        if settings.face_recognition.face_sharpness_filter_enabled and cv2.Laplacian(cv2.cvtColor(crop, cv2.COLOR_RGB2GRAY), cv2.CV_64F).var() < settings.face_recognition.face_sharpness_min_variance:
            continue
        vector = np.asarray(face.embedding, dtype=np.float32).reshape(-1)
        norm = np.linalg.norm(vector)
        if vector.size != 512 or not np.isfinite(vector).all() or norm <= 0:
            continue
        file = root / (uuid.uuid4().hex + '.jpg')
        thumbnail = Image.fromarray(crop); thumbnail.thumbnail((320, 320)); thumbnail.save(file, 'JPEG', quality=85)
        result.append(({'bbox': bbox, 'timestamp': timestamp, 'thumbnail_path': file.relative_to(thumb_root).as_posix(),
                        'det_score': confidence, 'frontality': processor._estimate_frontality(getattr(face, 'kps', None))}, vector / norm))
    return result


def append_candidates(session, media_id, candidates, task_id):
    """Same frame AND overlapping box are required; other times are never deduplicated."""
    from app.processors.faces import FaceProcessor
    from app.tasks.face_matching import _match_unassigned_to_existing
    existing = {}
    for r in rows(session, 'SELECT timestamp,bbox FROM face WHERE media_id=:id AND timestamp IS NOT NULL', {'id': media_id}):
        box = json.loads(r['bbox']) if isinstance(r['bbox'], str) else r['bbox']
        existing.setdefault(round(r['timestamp'], 3), []).append(FaceProcessor._stored_bbox_to_xyxy(box))
    added, vectors, duplicates = [], [], 0
    for data, vector in candidates:
        boxes = existing.setdefault(round(data['timestamp'], 3), [])
        candidate_box = FaceProcessor._stored_bbox_to_xyxy(data['bbox'])
        if candidate_box is None:
            continue
        if any(box is not None and FaceProcessor._iou(box, candidate_box) > settings.face_recognition.rerun_face_iou_dedupe_threshold for box in boxes):
            duplicates += 1; continue
        face = Face(media_id=media_id, **data); session.add(face); session.flush()
        session.execute(text('INSERT INTO face_embeddings(face_id,person_id,embedding) VALUES(:id,-1,:vector)'), {'id': face.id, 'vector': vector.astype(np.float32).tobytes()})
        added.append(face.id); vectors.append(vector); boxes.append(candidate_box)
    unassigned = _match_unassigned_to_existing(session, added, np.asarray(vectors, dtype=np.float32), task_id, commit=False) if added else []
    if added:
        identifiers = ','.join(str(int(i)) for i in added)
        assigned = [r[0] for r in session.execute(text(f'SELECT DISTINCT person_id FROM face WHERE id IN ({identifiers}) AND person_id IS NOT NULL'))]
        _refresh(session, assigned)
    return {'added': len(added), 'matched': len(added)-len(unassigned), 'duplicates': duplicates,
            'retained_thumbnails': {data['thumbnail_path'] for data, _ in candidates if session.execute(text('SELECT id FROM face WHERE thumbnail_path=:p LIMIT 1'), {'p': data['thumbnail_path']}).first()}}


def run(engine, identifier, task_id):
    from app.concurrency import heavy_writer
    from app.ffmpeg import ensure_ffmpeg_available
    from app.processor_registry import processors, load_processors
    from app.processors.faces import FaceProcessor
    with Session(engine) as s:
        job = dict(s.execute(text('SELECT * FROM face_refinement_job WHERE id=:id'), {'id': identifier}).mappings().one())
    saved = json.loads(job['manifest']); request = Request(**{key: saved[key] for key in Request.model_fields})
    thumb_root = Path(saved['thumb_root']); root = thumb_root / 'faces' / 'refinement' / identifier
    root.mkdir(parents=True, exist_ok=False)
    processor, status, error = None, 'failed', None
    summary = {'added': 0, 'matched': 0, 'duplicates': 0, 'retained_thumbnails': set()}
    should_cancel = lambda: cancelled(engine, identifier, task_id)
    try:
        with heavy_writer(name='local-face-refinement', cancelled=should_cancel) as acquired:
            if not acquired or should_cancel(): raise Cancelled()
            if not processors: load_processors()
            processor = next((p for p in processors if p.name == 'faces'), None) or FaceProcessor()
            processor.load_model()
            ffmpeg = ensure_ffmpeg_available()
            if not ffmpeg: raise RuntimeError('未找到FFmpeg')
            timestamps = points(request, saved['end'])
            candidates = []
            for index, timestamp in enumerate(timestamps):
                if should_cancel(): raise Cancelled()
                set_task_progress(task_id, current_item=saved['path'], current_step='refine_face_range', frame_current=index+1,
                                  frame_total=len(timestamps), video_second=timestamp, video_duration=saved['end'])
                image = decode(saved['path'], timestamp, ffmpeg, should_cancel)
                candidates.extend(_candidates(processor, image, timestamp, root, thumb_root))
                with Session(engine) as s:
                    task = s.get(ProcessingTask, task_id); task.processed = index+1; s.add(task)
                    s.execute(text('UPDATE face_refinement_job SET processed=:n WHERE id=:id'), {'n': index+1, 'id': identifier}); s.commit()
            if should_cancel(): raise Cancelled()
            stat = Path(saved['path']).stat()
            if (stat.st_size, stat.st_mtime_ns) != (saved['size'], saved['mtime']):
                raise RuntimeError('原视频在补查期间发生变化，未写入新结果')
            with Session(engine) as s:
                s.connection().exec_driver_sql('BEGIN IMMEDIATE')
                media = s.get(Media, saved['media_id'])
                if not media or media.path != saved['path']: raise RuntimeError('视频记录已变化，未写入新结果')
                summary = append_candidates(s, media.id, candidates, task_id)
                if should_cancel(): raise Cancelled()
                s.commit()
            status = 'completed'
    except Cancelled:
        status = 'cancelled'; summary['retained_thumbnails'] = set()
    except Exception as exc:
        error = str(exc); summary['retained_thumbnails'] = set(); record_task_failure(task_id, saved['path'], error)
    finally:
        if processor is not None:
            try: processor.unload()
            except Exception: pass
        retained = summary.pop('retained_thumbnails', set()) if status == 'completed' else set()
        for file in root.glob('*.jpg'):
            if file.relative_to(thumb_root).as_posix() not in retained: file.unlink(missing_ok=True)
        if not retained:
            try: root.rmdir()
            except OSError: pass
        with Session(engine) as s:
            task = s.get(ProcessingTask, task_id); task.status = status; task.finished_at = datetime.now(timezone.utc); s.add(task)
            s.execute(text('UPDATE face_refinement_job SET status=:status,error=:error,added=:added,matched=:matched,duplicates=:duplicates WHERE id=:id'),
                      {'status': status, 'error': error, 'id': identifier, **{k: summary[k] if status == 'completed' else 0 for k in ('added','matched','duplicates')}})
            s.commit()
        _cancel_events.pop(identifier, None); clear_task_progress(task_id)


def cancel(session, identifier):
    ensure_writable(); ensure_schema()
    job = rows(session, 'SELECT status FROM face_refinement_job WHERE id=:id', {'id': identifier})
    if not job: raise HTTPException(404, '补查记录不存在')
    if job[0]['status'] == 'running':
        event = _cancel_events.get(identifier)
        if event: event.set()
        else: raise HTTPException(409, '运行状态正在恢复，请刷新进度')
    return {'status': 'cancelling' if job[0]['status'] == 'running' else job[0]['status']}
