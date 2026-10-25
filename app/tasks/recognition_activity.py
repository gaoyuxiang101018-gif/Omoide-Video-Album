"""Reservations for face jobs: display progress and reject duplicate submissions."""
import threading

from fastapi import HTTPException
from sqlmodel import select

from app.config import settings
from app.media_paths import canonical_path_key, media_path_aliases
from app.models import Media, ProcessingTask
from app.tasks import progress_journal as journal
from app.tasks import state as task_state

submission_lock = threading.RLock()


def collect_activity(session):
    aliases = media_path_aliases(settings.general.media_dirs)
    tasks = session.exec(select(ProcessingTask).where(ProcessingTask.status.in_(['pending', 'running']))).all()
    progress = task_state.get_task_progress()
    items, global_tasks = [], []
    for task in tasks:
        if task.task_type not in ('process_media', 'run_processor', 'run_processor_for_media', 'refine_face_range'):
            continue
        payload = {**journal.read(task.id), **progress.get(task.id, {})}
        names = payload.get('processor_names')
        if names and 'faces' not in names:
            continue
        if task.task_type in ('process_media', 'run_processor'):
            global_tasks.append(task.id)
            continue
        identifiers = list(dict.fromkeys(payload.get('selected_media_ids', [])))
        if not identifiers:
            continue
        records = session.exec(select(Media).where(Media.id.in_(identifiers))).all()
        saved = journal.media_item_states(task.id, 'faces')
        current = canonical_path_key(payload.get('current_item', ''), aliases)
        for media in records:
            status = saved.get(media.id)
            state = {'completed': 'completed', 'failed': 'failed', 'running': 'running'}.get(status, 'queued')
            if status not in ('completed', 'failed') and str(task.status) == 'running' and canonical_path_key(media.path, aliases) == current:
                state = 'running'
            items.append({'media_id': media.id, 'path': media.path, 'task_id': task.id, 'state': state})
    return {'data_dir': str(settings.general.data_dir), 'items': items, 'global_tasks': global_tasks}


def assert_available(session, media_ids=None):
    activity = collect_activity(session)
    if activity['global_tasks']:
        raise HTTPException(409, '全库识别正在进行，请等待当前任务结束，避免重复识别。')
    if not activity['items']:
        return
    if media_ids is None:
        raise HTTPException(409, '已有视频正在识别或排队，请等待当前任务结束后再运行全库识别。')
    aliases = media_path_aliases(settings.general.media_dirs)
    reserved = {canonical_path_key(item['path'], aliases) for item in activity['items']}
    requested = session.exec(select(Media).where(Media.id.in_(media_ids))).all()
    overlap = {canonical_path_key(media.path, aliases) for media in requested} & reserved
    if overlap:
        raise HTTPException(409, f'其中 {len(overlap)} 个视频已在识别或排队，请刷新后重新选择。')
