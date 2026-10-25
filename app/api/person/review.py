from fastapi import APIRouter, BackgroundTasks, Depends, Query
from pydantic import BaseModel, Field
from sqlmodel import Session
from app.database import get_session
from app import person_review, local_refinement, recognition_parameters

router = APIRouter(prefix='/review')


class FrontalReview(BaseModel):
    profile_key: str
    fingerprint: str


@router.get('/frontal/preview')
def frontal_preview(session: Session = Depends(get_session)):
    from app.frontal_policy import preview
    return preview(session)


@router.get('/frontal/history')
def frontal_history(session: Session = Depends(get_session)):
    from app.frontal_policy import history
    return history(session)


@router.post('/frontal/reconcile')
def frontal_reconcile(body: FrontalReview, session: Session = Depends(get_session)):
    from app.frontal_policy import reconcile
    return reconcile(session, body.profile_key, body.fingerprint)


@router.post('/frontal/{identifier}/undo')
def frontal_undo(identifier: str, session: Session = Depends(get_session)):
    from app.frontal_policy import undo
    return undo(session, identifier)


@router.get('/parameters')
def parameters(session: Session = Depends(get_session)):
    return recognition_parameters.overview(session)


@router.get('/timeline/{media_id}')
def timeline(media_id: int, gap: float = Query(4, ge=0, le=10), session: Session = Depends(get_session)):
    return person_review.timeline(session, media_id, gap)


@router.post('/preview')
def preview(body: person_review.Range, session: Session = Depends(get_session)):
    return person_review.preview(session, body)


@router.post('/correct')
def correct(body: person_review.Correction, session: Session = Depends(get_session)):
    return person_review.correct(session, body)


@router.get('/history')
def history(session: Session = Depends(get_session)):
    return person_review.history(session)


@router.post('/history/{event_id}/undo')
def undo(event_id: str, session: Session = Depends(get_session)):
    return person_review.undo_correction(session, event_id)


class Separation(BaseModel):
    first: int = Field(gt=0)
    second: int = Field(gt=0)


@router.post('/separations')
def separate(body: Separation, session: Session = Depends(get_session)):
    return person_review.add_separation(session, body.first, body.second)


@router.delete('/separations/{rule_id}')
def remove_separation(rule_id: str, session: Session = Depends(get_session)):
    return person_review.remove_separation(session, rule_id)


@router.get('/refinements')
def refinements(session: Session = Depends(get_session)):
    return local_refinement.jobs(session)


@router.post('/refinements')
def refine(body: local_refinement.Request, background: BackgroundTasks, session: Session = Depends(get_session)):
    return local_refinement.start(session, background, body)


@router.post('/refinements/{identifier}/cancel')
def cancel(identifier: str, session: Session = Depends(get_session)):
    return local_refinement.cancel(session, identifier)
