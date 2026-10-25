from fastapi import APIRouter, BackgroundTasks, Depends, Query
from fastapi.responses import FileResponse
from sqlmodel import Session
from app.database import get_session
from app import person_workbench, merge_history, clip_exports

router = APIRouter(prefix='/tools')


@router.get('/segments')
def segments(person_id: int = Query(gt=0), with_person_id: int | None = Query(default=None, gt=0), gap: float = Query(default=4, ge=0, le=10), session: Session = Depends(get_session)):
    return person_workbench.segments(session, person_id, with_person_id, gap)


@router.get('/merge-history')
def history(session: Session = Depends(get_session)):
    return merge_history.history(session)


@router.post('/merge-history/{journal_id}/undo')
def undo(journal_id: str, session: Session = Depends(get_session)):
    return merge_history.undo(session, journal_id)


@router.get('/exports')
def exports(session: Session = Depends(get_session)):
    return clip_exports.exports(session)


@router.post('/exports')
def start_export(request: clip_exports.ExportRequest, background: BackgroundTasks, session: Session = Depends(get_session)):
    return clip_exports.start_export(session, background, request)


@router.post('/exports/{job_id}/cancel')
def cancel_export(job_id: str, session: Session = Depends(get_session)):
    return clip_exports.cancel(session, job_id)


@router.get('/exports/{job_id}/file')
def export_file(job_id: str, session: Session = Depends(get_session)):
    path = clip_exports.result_file(session, job_id)
    return FileResponse(path, media_type='video/mp4', filename=path.name)
