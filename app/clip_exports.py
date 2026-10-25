"""Single local FFmpeg export queue, visible to the existing task monitor."""
import json
import shutil
import subprocess
import threading
import time
import uuid
import weakref
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlmodel import Session

import app.database as db
from app.config import settings
from app.models import ProcessingTask
from app.person_workbench import segments, playback_bounds
from app.presentation import ensure_writable
from app.tasks.state import set_task_progress, clear_task_progress, record_task_failure

_lock = threading.Lock()
_ready = weakref.WeakSet()


class ExportRequest(BaseModel):
    person_id: int = Field(gt=0)
    with_person_id: int | None = Field(default=None, gt=0)
    gap: float = Field(default=4, ge=0, le=10)
    profile_key: str
    revision: str
    clip_keys: list[str] = Field(min_length=1, max_length=2000)
    before: float = Field(default=1, ge=0, le=10)
    after: float = Field(default=1, ge=0, le=10)
    output_dir: str = ''
    resolution: str = '1080p'


def ensure_schema():
    with _lock:
        if db.engine in _ready:
            return
        with db.engine.begin() as connection:
            connection.exec_driver_sql('''CREATE TABLE IF NOT EXISTS person_clip_export (
                id TEXT PRIMARY KEY, task_id TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL,
                person_id INTEGER NOT NULL, with_person_id INTEGER, status TEXT NOT NULL,
                total INTEGER NOT NULL, processed INTEGER NOT NULL DEFAULT 0,
                output_dir TEXT NOT NULL, result_path TEXT, error TEXT, manifest TEXT NOT NULL)''')
        _ready.add(db.engine)


def _rows(session):
    items = [dict(r) for r in session.execute(text('''SELECT e.id,e.task_id,e.created_at,e.person_id,e.with_person_id,e.status,
        e.total,e.processed,e.output_dir,e.result_path,e.error,t.status task_status
        FROM person_clip_export e LEFT JOIN processingtask t ON t.id=e.task_id ORDER BY e.created_at DESC LIMIT 30''')).mappings()]
    for item in items:
        task_status = item.pop('task_status')
        if item['status'] in ('pending', 'running') and task_status not in ('pending', 'running'):
            item['status'] = 'failed'
            item['error'] = item['error'] or '程序已重启或任务已结束，可重新导出'
    return items


def exports(session):
    ensure_schema()
    return {'items': _rows(session), 'default_output_dir': str(Path(settings.general.data_dir).parent / '人物片段')}


def _output_root(request):
    root = Path(request.output_dir or (Path(settings.general.data_dir).parent / '人物片段')).expanduser()
    if not root.is_absolute():
        raise HTTPException(400, '导出位置必须是绝对路径')
    root = root.resolve()
    protected = [Path(settings.general.data_dir).resolve(), Path(settings.general.omoide_dir).resolve()]
    protected += [Path(base).resolve() for base, _ in settings.general.resolved_media_dirs()]
    if any(root == p or root.is_relative_to(p) for p in protected):
        raise HTTPException(400, '请将片段导出到资料库和原视频文件夹之外，避免重复扫描')
    return root


def start_export(session, background, request):
    ensure_writable()
    ensure_schema()
    from app.tasks.common import create_and_run_task
    from app.ffmpeg import ensure_ffmpeg_available
    with _lock:
        if session.execute(text("SELECT id FROM processingtask WHERE task_type='export_person_clips' AND status IN ('pending','running') LIMIT 1")).first():
            raise HTTPException(409, '已有片段导出正在进行，请完成或取消后再导出')
        plan = segments(session, request.person_id, request.with_person_id, request.gap)
        if (plan['profile_key'], plan['revision']) != (request.profile_key, request.revision):
            raise HTTPException(409, '人物数据已更新，请刷新片段后重新选择')
        keys = set(request.clip_keys)
        clips = [c for c in plan['clips'] if c['key'] in keys]
        if len(clips) != len(keys):
            raise HTTPException(409, '部分片段已变化，请刷新后重试')
        if request.resolution not in ('1080p', '4k'):
            raise HTTPException(400, '请选择1080p或4K')
        ffmpeg = ensure_ffmpeg_available()
        if not ffmpeg or not Path(ffmpeg).with_name('ffprobe.exe' if Path(ffmpeg).suffix == '.exe' else 'ffprobe').is_file():
            raise HTTPException(400, '未找到可用的FFmpeg和FFprobe')
        root = _output_root(request)
        root.mkdir(parents=True, exist_ok=True)
        if shutil.disk_usage(root).free < 512 * 1024 * 1024:
            raise HTTPException(400, '导出盘可用空间不足512MB')
        job_id = uuid.uuid4().hex
        destination = root / ('人物片段-' + datetime.now().strftime('%Y%m%d-%H%M%S') + '-' + job_id[:8])
        destination.mkdir(exist_ok=False)
        manifest = {**request.model_dump(), 'clips': clips, 'ffmpeg': str(ffmpeg)}
        engine = db.engine
        task = create_and_run_task(session, background, 'export_person_clips', lambda task_id: run_export(engine, job_id, task_id), reuse_running=False)
        task.status = 'running'
        task.started_at = datetime.now(timezone.utc)
        task.total = len(clips) + 1
        session.execute(text('''INSERT INTO person_clip_export
            (id,task_id,created_at,person_id,with_person_id,status,total,output_dir,manifest)
            VALUES(:id,:task,:at,:person,:other,'running',:total,:folder,:manifest)'''), {
            'id': job_id, 'task': task.id, 'at': datetime.now(timezone.utc).isoformat(),
            'person': request.person_id, 'other': request.with_person_id, 'total': len(clips) + 1,
            'folder': str(destination), 'manifest': json.dumps(manifest, ensure_ascii=False),
        })
        session.add(task)
        session.commit()
    return next(r for r in _rows(session) if r['id'] == job_id)


class ExportCancelled(Exception):
    pass


def _cancelled(engine, job_id, task_id):
    with Session(engine) as session:
        row = session.execute(text('SELECT status FROM person_clip_export WHERE id=:id'), {'id': job_id}).first()
        task = session.get(ProcessingTask, task_id)
        return not row or row[0] == 'cancelled' or not task or task.status == 'cancelled'


def _command(args, engine, job_id, task_id, log, timeout):
    # Pipe-free stderr avoids deadlocks on malformed files and stays in the job folder.
    with log.open('wb') as errors:
        process = subprocess.Popen([str(a) for a in args], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=errors,
                                   creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        deadline = time.monotonic() + timeout
        try:
            while process.poll() is None:
                if _cancelled(engine, job_id, task_id):
                    raise ExportCancelled()
                if time.monotonic() > deadline:
                    raise RuntimeError('导出超时，请检查网络视频是否可读取')
                time.sleep(0.2)
            if process.returncode:
                raise RuntimeError('FFmpeg导出失败：' + log.read_text('utf8', errors='replace')[-1200:])
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)


def _progress(engine, job_id, task_id, count, name):
    if _cancelled(engine, job_id, task_id):
        raise ExportCancelled()
    with Session(engine) as session:
        session.execute(text('UPDATE person_clip_export SET processed=:n WHERE id=:id'), {'n': count, 'id': job_id})
        task = session.get(ProcessingTask, task_id)
        task.processed = count
        session.add(task)
        session.commit()
    set_task_progress(task_id, current_item=name, current_step='export_person_clips')


def run_export(engine, job_id, task_id):
    with Session(engine) as session:
        job = dict(session.execute(text('SELECT * FROM person_clip_export WHERE id=:id'), {'id': job_id}).mappings().one())
    manifest = json.loads(job['manifest'])
    folder, ffmpeg = Path(job['output_dir']), Path(manifest['ffmpeg'])
    ffprobe = ffmpeg.with_name('ffprobe.exe' if ffmpeg.suffix == '.exe' else 'ffprobe')
    width, height = (3840, 2160) if manifest['resolution'] == '4k' else (1920, 1080)
    partial = None
    status, error, result = 'failed', None, None
    try:
        saved = []
        for index, clip in enumerate(manifest['clips']):
            _progress(engine, job_id, task_id, index, clip['media']['filename'])
            path = Path(clip['media']['path'])
            if not path.is_file():
                raise RuntimeError('原视频不可读取：' + path.name)
            probe = subprocess.run([str(ffprobe), '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=index', '-of', 'csv=p=0', str(path)],
                                   capture_output=True, timeout=30, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            if probe.returncode:
                raise RuntimeError('无法读取视频信息：' + path.name)
            start, end = playback_bounds(clip, manifest['before'], manifest['after'])
            output = folder / f'clip-{index+1:04d}.mp4'
            partial = folder / f'clip-{index+1:04d}.part.mp4'
            args = [ffmpeg, '-hide_banner', '-nostdin', '-loglevel', 'error', '-n', '-threads', '2', '-ss', f'{start:.3f}', '-i', path]
            if not probe.stdout.strip():
                args += ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000']
            args += ['-map', '0:v:0', '-map', '0:a:0' if probe.stdout.strip() else '1:a:0', '-sn', '-dn',
                     '-vf', f'scale={width}:{height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p',
                     '-c:v', 'libx264', '-threads', '4', '-preset', 'fast', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
                     '-af', 'aresample=48000:async=1:first_pts=0', '-t', f'{end-start:.3f}', '-movflags', '+faststart', partial]
            _command(args, engine, job_id, task_id, folder / 'ffmpeg.log', max(300, (end-start)*30))
            partial.rename(output)
            partial = None
            saved.append({'file': output.name, 'source': str(path), 'detected_start': clip['start'], 'detected_end': clip['end'], 'start': start, 'end': end})
            _progress(engine, job_id, task_id, index+1, '片段已导出')
        (folder / 'segments.json').write_text(json.dumps({'person_id': manifest['person_id'], 'with_person_id': manifest['with_person_id'], 'clips': saved}, ensure_ascii=False, indent=2), 'utf8')
        concat = folder / 'concat.txt'
        concat.write_text(''.join(f"file '{entry['file']}'\n" for entry in saved), 'utf8')
        partial = folder / 'montage.part.mp4'
        _command([ffmpeg, '-hide_banner', '-nostdin', '-loglevel', 'error', '-n', '-f', 'concat', '-safe', '1', '-i', concat, '-c', 'copy', '-movflags', '+faststart', partial], engine, job_id, task_id, folder / 'ffmpeg.log', 300)
        _progress(engine, job_id, task_id, len(saved)+1, '合辑已导出')
        result = str(folder / '人物片段合辑.mp4')
        partial.rename(result)
        partial = None
        status = 'completed'
    except ExportCancelled:
        status = 'cancelled'
    except Exception as exc:
        error = str(exc)
        record_task_failure(task_id, str(folder), error)
    finally:
        if partial:
            partial.unlink(missing_ok=True)
        with Session(engine) as session:
            # A cancellation arriving after the final write is still honored in task state.
            session.execute(text('UPDATE person_clip_export SET status=:status,error=:error,result_path=:path WHERE id=:id'), {'status': status, 'error': error, 'path': result, 'id': job_id})
            task = session.get(ProcessingTask, task_id)
            task.status = status
            task.finished_at = datetime.now(timezone.utc)
            session.add(task)
            session.commit()
        clear_task_progress(task_id)


def cancel(session, job_id):
    ensure_writable()
    ensure_schema()
    job = session.execute(text('SELECT task_id,status FROM person_clip_export WHERE id=:id'), {'id': job_id}).first()
    if not job:
        raise HTTPException(404, '导出记录不存在')
    if job[1] not in ('pending', 'running'):
        return {'status': job[1]}
    # The running task remains active until its FFmpeg process has actually stopped.
    session.execute(text("UPDATE person_clip_export SET status='cancelled' WHERE id=:id"), {'id': job_id})
    session.commit()
    return {'status': 'cancelled'}


def result_file(session, job_id):
    ensure_schema()
    row = session.execute(text("SELECT result_path,status FROM person_clip_export WHERE id=:id"), {'id': job_id}).first()
    if not row or row[1] != 'completed' or not row[0] or not Path(row[0]).is_file():
        raise HTTPException(404, '合辑尚未完成或文件已被移动')
    return Path(row[0])
