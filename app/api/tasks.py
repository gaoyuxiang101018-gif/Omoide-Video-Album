from __future__ import annotations

import time
from datetime import UTC, datetime

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.exc import OperationalError
from sqlmodel import Session, select

from app.config import settings
from app.database import get_session, safe_commit
from app.logger import logger
from app.models import ProcessingTask, ProcessingTaskRead
from app.tasks import (
    clean_missing_files,
    compute_blur_scores,
    create_and_run_task,
    run_backfill_face_quality,
    run_backfill_face_timestamps,
    run_build_events,
    run_duplicate_detection,
    run_geocode_places,
    run_media_processing,
    run_person_clustering,
    run_processors_for_media,
    run_scan,
    run_single_processor,
)
from app.tasks import (
    state as task_state,
)
from app.tasks import progress_journal as journal
from app.tasks.recognition_activity import assert_available, collect_activity, submission_lock
from app.model_memory import release_idle_models, status as model_memory_status

router = APIRouter()

@router.get('/model-memory')
def model_memory(session: Session = Depends(get_session)):
    return model_memory_status(session)

@router.post('/release-models')
def release_models(session: Session = Depends(get_session)):
    return release_idle_models(session)

@router.get('/recognition-activity')
def recognition_activity(session: Session = Depends(get_session)):
    return collect_activity(session)

def task_details(task):
    base = task.model_dump()
    base.update(journal.read(task.id))
    base.update(task_state.get_task_progress().get(task.id, {}))
    counts = journal.item_counts(task.id)
    base['item_counts'] = counts
    base['failure_count'] = max(base.get('failure_count',0) or 0, task_state.get_failure_count(task.id),counts.get('failed',0))
    if str(task.status) == 'failed' and not base.get('fatal_error'):
        base['fatal_error'] = journal.historical_failure(task.id)
        if base['fatal_error']: journal.update(task.id,force=True,fatal_error=base['fatal_error'])
    for key in ('started_at','finished_at'):
        value = base.get(key)
        if value and value.tzinfo is None: base[key] = value.replace(tzinfo=UTC)
    return base

@router.get('/history')
def task_history(limit: int = 50, session: Session = Depends(get_session)):
    tasks = session.exec(select(ProcessingTask).order_by(ProcessingTask.created_at.desc()).limit(max(1,min(200,limit)))).all()
    return {'items':[task_details(task) for task in tasks]}

@router.get('/{task_id}/items')
def task_items_endpoint(task_id: str, limit: int = 200, offset: int = 0, session: Session = Depends(get_session)):
    if not session.get(ProcessingTask,task_id): raise HTTPException(status_code=404,detail='Task not found')
    return journal.task_items(task_id,max(1,min(500,limit)),max(0,offset))


@router.post(
    "/process_media",
    response_model=ProcessingTask,
    summary="Detect faces and compute embeddings for all unprocessed media",
)
async def start_media_processing(
    background_tasks: BackgroundTasks,
    session: Session = Depends(get_session),
):
    logger.info("Starting processing!")
    with submission_lock:
        assert_available(session)
        task = create_and_run_task(session=session, background_tasks=background_tasks,
            task_type="process_media", callable_task=run_media_processing)
        journal.update(task.id, force=True, processor_names=['faces'])
        return task


@router.post(
    "/cluster_persons",
    response_model=ProcessingTask,
    summary="Cluster face embeddings into Person identities",
)
def start_person_clustering(
    background_tasks: BackgroundTasks,
    session: Session = Depends(get_session),
):
    task = create_and_run_task(
        session,
        background_tasks,
        "cluster_persons",
        callable_task=run_person_clustering,
    )
    return task


@router.post(
    "/scan", response_model=ProcessingTask, summary="Enqueue a media-scan task"
)
def start_scan(
    background_tasks: BackgroundTasks,
    session: Session = Depends(get_session),
):
    if not settings.general.media_dirs:
        raise HTTPException(
            status_code=400, detail="No media directories configured."
        )
    task = create_and_run_task(
        session=session,
        background_tasks=background_tasks,
        task_type="scan",
        callable_task=run_scan,
    )
    return task


@router.post(
    "/find_duplicates",
    response_model=ProcessingTask,
    summary="Find and group duplicate images",
)
def start_duplicate_detection(
    background_tasks: BackgroundTasks,
    session: Session = Depends(get_session),
    threshold: int = 2,
):
    task = create_and_run_task(
        session=session,
        background_tasks=background_tasks,
        task_type="find_duplicates",
        callable_task=lambda task_id: run_duplicate_detection(
            task_id, threshold
        ),
    )
    return task


@router.post(
    "/clean_missing_files",
    summary="Scan for and delete records of files that no longer exist",
    response_model=ProcessingTask,
)
async def start_missing_files_cleanup(
    background_tasks: BackgroundTasks,
    session: Session = Depends(get_session),
):
    return create_and_run_task(
        session=session,
        background_tasks=background_tasks,
        task_type="clean_missing_files",
        callable_task=clean_missing_files,
    )


@router.post(
    "/compute_blur_scores",
    summary="Compute Laplacian blur scores for all unscored media",
    response_model=ProcessingTask,
)
async def start_blur_scoring(
    background_tasks: BackgroundTasks,
    session: Session = Depends(get_session),
):
    return create_and_run_task(
        session=session,
        background_tasks=background_tasks,
        task_type="compute_blur_scores",
        callable_task=compute_blur_scores,
    )


@router.post(
    "/build_events",
    response_model=ProcessingTask,
    summary="Cluster the library into time-based events",
)
async def start_build_events(
    background_tasks: BackgroundTasks,
    session: Session = Depends(get_session),
):
    return create_and_run_task(
        session=session,
        background_tasks=background_tasks,
        task_type="build_events",
        callable_task=run_build_events,
    )


@router.post(
    "/geocode_places",
    response_model=ProcessingTask,
    summary="Reverse-geocode media GPS data into places (offline)",
)
async def start_geocode_places(
    background_tasks: BackgroundTasks,
    session: Session = Depends(get_session),
):
    return create_and_run_task(
        session=session,
        background_tasks=background_tasks,
        task_type="geocode_places",
        callable_task=run_geocode_places,
    )


@router.post(
    "/run_processor/{processor_name}",
    response_model=ProcessingTask,
    summary="Run a single processor over all media",
)
async def start_single_processor(
    processor_name: str,
    background_tasks: BackgroundTasks,
    session: Session = Depends(get_session),
    force: bool = False,
):
    """Run one processor by name.

    force=false (default) – only processes media not yet handled by this processor.
    force=true – resets existing results and reprocesses all media.
    """
    with submission_lock:
        if processor_name == 'faces': assert_available(session)
        task = create_and_run_task(session=session, background_tasks=background_tasks,
            task_type="run_processor", callable_task=lambda task_id: run_single_processor(task_id, processor_name, force=force), reuse_running=False)
        journal.update(task.id, force=True, processor_names=[processor_name])
        return task


class RunProcessorsForMediaRequest(BaseModel):
    media_ids: list[int]
    processor_names: list[str]


@router.post(
    "/run_processors_for_media",
    response_model=ProcessingTask,
    summary="Run selected processors on a specific set of media items",
)
async def start_processors_for_media(
    body: RunProcessorsForMediaRequest,
    background_tasks: BackgroundTasks,
    session: Session = Depends(get_session),
):
    """Run one or more processors over a specific list of media IDs.

    Always resets and reprocesses the given items regardless of their current state.
    """
    identifiers = list(dict.fromkeys(body.media_ids))
    names = list(dict.fromkeys(body.processor_names))
    if not identifiers or not names or any(identifier <= 0 for identifier in identifiers):
        raise HTTPException(422, '请选择至少一个有效视频和分析模块。')
    with submission_lock:
        if 'faces' in names: assert_available(session, identifiers)
        task = create_and_run_task(session=session, background_tasks=background_tasks,
            task_type="run_processor_for_media", callable_task=lambda task_id: run_processors_for_media(task_id, names, identifiers), reuse_running=False)
        journal.update(task.id, force=True, selected_media_ids=identifiers, processor_names=names)
        return task


@router.post(
    "/backfill_face_timestamps",
    response_model=ProcessingTask,
    summary="Backfill missing face timestamps for existing video faces",
)
async def start_backfill_face_timestamps(
    background_tasks: BackgroundTasks,
    session: Session = Depends(get_session),
):
    return create_and_run_task(
        session=session,
        background_tasks=background_tasks,
        task_type="backfill_face_timestamps",
        callable_task=run_backfill_face_timestamps,
    )


@router.post(
    "/backfill_face_quality",
    response_model=ProcessingTask,
    summary="Rate existing faces (det_score/frontality) by re-detecting on their thumbnails",
)
async def start_backfill_face_quality(
    background_tasks: BackgroundTasks,
    session: Session = Depends(get_session),
):
    return create_and_run_task(
        session=session,
        background_tasks=background_tasks,
        task_type="backfill_face_quality",
        callable_task=run_backfill_face_quality,
    )


@router.post("/{task_id}/cancel", summary="Cancel a running task")
def cancel_task(
    task_id: str,
    session: Session = Depends(get_session),
):
    task = session.get(ProcessingTask, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if task.status not in ("pending", "running"):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot cancel task in status {task.status}",
        )
    task.status = "cancelled"
    task.finished_at = datetime.now(UTC)
    session.add(task)
    safe_commit(session)
    return task


@router.get(
    "/active",
    response_model=list[ProcessingTaskRead],
    summary="List all active tasks with transient details",
)
def list_active_tasks(session: Session = Depends(get_session)):
    try:
        active = session.exec(
            select(ProcessingTask).where(ProcessingTask.status.in_(["running", "pending"]))
        ).all()
        progress_map = task_state.get_task_progress()
        result: list[ProcessingTaskRead] = []
        for task in active:
            base = task_details(task)
            result.append(ProcessingTaskRead(**base))
        return result
    except OperationalError:
        # database might be contended; retry briefly
        time.sleep(0.5)
        return list_active_tasks(session)


@router.get(
    "/{task_id}/failures",
    response_model=list[task_state.TaskFailure],
    summary="List captured errors for a task",
)
def get_task_failures_endpoint(
    task_id: str, session: Session = Depends(get_session)
):
    task = session.get(ProcessingTask, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return task_state.get_task_failures(task_id)


@router.get(
    "/{task_id}",
    response_model=ProcessingTaskRead,
    summary="Get task status",
)
def get_task(task_id: str, session: Session = Depends(get_session)):
    task = session.get(ProcessingTask, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    base = task_details(task)
    return ProcessingTaskRead(**base)
