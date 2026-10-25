"""Per-video transactions: an unavailable network file cannot abort a batch."""
from datetime import datetime, timezone
from pathlib import Path
from sqlmodel import Session
import app.database as db
from app.models import Media, ProcessingTask, Status
from app.database import safe_commit
from app.concurrency import heavy_writer
from app.processor_registry import load_processors, processors
from .state import set_task_progress, clear_task_progress, record_task_failure
from . import progress_journal as journal

def run(task_id, processor_names, media_ids):
    from .media_processing import _is_task_cancelled, _needs_scene_extraction, _load_scenes, _media_snapshot
    if not processors: load_processors()
    targets = [target for target in processors if target.name in processor_names]
    if not targets: raise ValueError('没有找到所选处理模块。')
    media_ids = list(dict.fromkeys(media_ids))
    journal.update(task_id, force=True, selected_media_ids=media_ids, processor_names=processor_names)
    with Session(db.engine) as session:
        task = session.get(ProcessingTask, task_id)
        if not task: return
        task.status = Status.RUNNING; task.started_at = datetime.now(timezone.utc)
        task.total = len(media_ids)*len(targets); task.processed = 0
        session.add(task); safe_commit(session)
        with heavy_writer(name='run_processors_for_media',cancelled=lambda:_is_task_cancelled(task_id)) as acquired:
            if acquired:
                for target in targets:
                    if _is_task_cancelled(task_id): break
                    set_task_progress(task_id,current_step='loading_model')
                    try:
                        target.load_model(); target.active = True
                        for media_id in media_ids:
                            if _is_task_cancelled(task_id): break
                            media = session.get(Media,media_id)
                            path = str(media.path) if media and media.path else ''
                            try:
                                journal.item(task_id,media_id,target.name,path,'running')
                                set_task_progress(task_id,current_item=path,current_step='checking_source')
                                if not path: raise FileNotFoundError('该视频记录或路径已不存在。')
                                # stat() can raise WinError 433/53/64 on a temporarily unavailable NAS.
                                Path(path).stat()
                                set_task_progress(task_id,current_item=path,current_step='extracting_scenes')
                                if _needs_scene_extraction(media):
                                    scenes = _load_scenes(_media_snapshot(media))
                                    if not scenes and not target.handles_empty_scenes: raise OSError('未能读取视频画面，可在网络盘恢复后重试。')
                                    media.extracted_scenes = True
                                    for scene in scenes:
                                        if isinstance(scene,tuple) and hasattr(scene[0],'id'): session.add(scene[0])
                                else: scenes = media.scenes
                                if not scenes and not target.handles_empty_scenes: raise OSError('没有可读取的视频画面，请检查原片及缓存。')
                                # Preserve existing results until we can actually open the source.
                                target.reset_for_media(media,session)
                                set_task_progress(task_id,current_item=path,current_step=target.name)
                                if target.process(media,session,scenes=scenes) is False:
                                    raise RuntimeError(media.processing_error or '处理模块未能完成此视频。')
                                session.add(media)
                                task.processed += 1; session.add(task); safe_commit(session)
                                journal.item(task_id,media_id,target.name,path,'completed')
                            except Exception as error:
                                session.rollback()
                                task = session.get(ProcessingTask,task_id)
                                reason = f'{type(error).__name__}: {error}'
                                if isinstance(error,OSError): reason = '视频或网络盘暂时不可访问；已跳过，可恢复后重试。 '+reason
                                record_task_failure(task_id,path,reason)
                                journal.item(task_id,media_id,target.name,path,'failed',reason)
                                task.processed += 1; session.add(task); safe_commit(session)
                            set_task_progress(task_id,current_item=path,current_step='idle')
                    finally:
                        try: target.unload()
                        except Exception: pass
            task.status = Status.CANCELLED if not acquired or _is_task_cancelled(task_id) else Status.COMPLETED
            task.finished_at = datetime.now(timezone.utc)
            session.add(task); safe_commit(session)
            journal.update(task_id,force=True,current_step='finished',final_status=str(task.status))
            clear_task_progress(task_id)
