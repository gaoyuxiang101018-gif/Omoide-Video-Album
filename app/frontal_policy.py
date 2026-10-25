"""Frontal identity anchors and reversible review of automatically formed profile groups."""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import math
import threading
import uuid
import weakref

from fastapi import HTTPException
from sqlalchemy import text

import app.database as db
from app.config import settings

_lock = threading.Lock()
_ready = weakref.WeakSet()


def thresholds():
    face = settings.face_recognition
    return max(.65, float(face.person_frontal_anchor_min_frontality), float(face.cluster_seed_min_frontality)), max(.55, float(face.cluster_seed_min_det_score))


def is_frontal_anchor(face):
    pose, confidence = face.frontality, face.det_score
    minimum_pose, minimum_confidence = thresholds()
    return (pose is not None and confidence is not None and math.isfinite(pose) and math.isfinite(confidence)
            and minimum_pose <= pose <= 1 and minimum_confidence <= confidence <= 1)


def frontal_face_ids(session, identifiers):
    from app.tasks.clustering_queries import build_in_clause_params, iter_chunks
    pose, confidence = thresholds()
    result = set()
    for chunk in iter_chunks(list(identifiers), 500):
        placeholders, params = build_in_clause_params(chunk, prefix='anchor')
        result.update(row[0] for row in session.execute(text(f'''SELECT id FROM face WHERE id IN ({placeholders})
            AND frontality BETWEEN :pose AND 1 AND det_score BETWEEN :confidence AND 1'''),
            {**params, 'pose': pose, 'confidence': confidence}))
    return result


def anchored_person_ids(session):
    pose, confidence = thresholds()
    return {row[0] for row in session.execute(text('''SELECT DISTINCT person_id FROM face
        WHERE person_id IS NOT NULL AND frontality BETWEEN :pose AND 1 AND det_score BETWEEN :confidence AND 1'''),
        {'pose': pose, 'confidence': confidence})}


def ensure_schema():
    from app.person_review import ensure_schema as review_schema
    review_schema()
    with _lock:
        if db.engine in _ready:
            return
        with db.engine.begin() as connection:
            # Older upstream libraries did not migrate the Face.person_id index.
            connection.exec_driver_sql('CREATE INDEX IF NOT EXISTS ix_face_person_id ON face(person_id)')
            connection.exec_driver_sql('''CREATE TABLE IF NOT EXISTS frontal_review_history (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,
                people_count INTEGER NOT NULL,face_count INTEGER NOT NULL,matched INTEGER NOT NULL,
                pending INTEGER NOT NULL,payload TEXT NOT NULL,undone_at TEXT)''')
            connection.exec_driver_sql('CREATE TABLE IF NOT EXISTS frontal_archived_person (person_id INTEGER PRIMARY KEY,event_id TEXT NOT NULL)')
        _ready.add(db.engine)


def visible_person_sql(alias='p'):
    return f'''(NOT EXISTS (SELECT 1 FROM frontal_archived_person archived WHERE archived.person_id={alias}.id)
        OR EXISTS (SELECT 1 FROM face active_face WHERE active_face.person_id={alias}.id))'''


def _candidates(session):
    pose, confidence = thresholds()
    return [dict(row) for row in session.execute(text('''WITH candidates AS (
        SELECT person_id,COUNT(*) face_count,MAX(frontality) max_frontality
        FROM face WHERE person_id IS NOT NULL GROUP BY person_id
        HAVING SUM(CASE WHEN frontality IS NULL OR det_score IS NULL THEN 1 ELSE 0 END)=0
          AND MAX(frontality)<:pose
          AND SUM(CASE WHEN frontality BETWEEN :pose AND 1 AND det_score BETWEEN :confidence AND 1 THEN 1 ELSE 0 END)=0
        ), protected AS (
          SELECT manual.person_id FROM face_manual_assignment pin JOIN face manual ON manual.id=pin.face_id
          UNION SELECT person_id FROM personmedialink
          UNION SELECT person_id FROM persontaglink
          UNION SELECT target_id FROM person_merge_history WHERE undone_at IS NULL
        )
        SELECT p.id,p.profile_face_id,c.face_count,c.max_frontality
        FROM candidates c JOIN person p ON p.id=c.person_id
        WHERE TRIM(COALESCE(p.name,''))='' AND COALESCE(p.is_favorite,0)=0
          AND NOT EXISTS (SELECT 1 FROM protected WHERE protected.person_id=p.id)
        ORDER BY p.id'''), {'pose': pose, 'confidence': confidence}).mappings()]


def _preview(session):
    from app.person_views import state
    candidates = _candidates(session)
    identifiers = {item['id'] for item in candidates}
    faces = []
    from app.tasks.clustering_queries import build_in_clause_params, iter_chunks
    for chunk in iter_chunks(sorted(identifiers), 500):
        placeholders, params = build_in_clause_params(chunk, prefix='review_person')
        faces.extend(dict(row) for row in session.execute(text(f'''SELECT id,person_id,media_id,timestamp,thumbnail_path,bbox,frontality,det_score
            FROM face WHERE person_id IN ({placeholders}) ORDER BY id'''), params).mappings())
    faces.sort(key=lambda face: face['id'])
    stamp = state(session)
    digest = hashlib.sha256(json.dumps({'candidates': candidates, 'faces': faces}, sort_keys=True).encode()).hexdigest()
    return {**stamp, 'fingerprint': digest, 'items': candidates, 'people_count': len(candidates),
            'face_count': len(faces), 'minimum_frontality': thresholds()[0]}, faces


def preview(session):
    ensure_schema()
    result, _ = _preview(session)
    return result


def history(session):
    ensure_schema()
    return {'items': [dict(row) for row in session.execute(text('''SELECT id,created_at,people_count,face_count,matched,pending,undone_at
        FROM frontal_review_history ORDER BY seq DESC LIMIT 100''')).mappings()]}


def _refresh(session, identifiers):
    from app.persons import rebuild_person_embedding, recalculate_person_appearance_counts, auto_select_profile_face
    session.flush()
    for identifier in set(identifiers):
        rebuild_person_embedding(session, identifier, keep_empty=True)
        auto_select_profile_face(session, identifier)
    recalculate_person_appearance_counts(session, identifiers)


def reconcile(session, profile_key, fingerprint):
    from app.person_review import assert_idle
    from app.presentation import ensure_writable
    from app.concurrency import heavy_writer
    from app.tasks.face_matching import _match_unassigned_to_existing
    from app.vectors import vector_from_stored
    import numpy as np
    ensure_writable()
    ensure_schema()
    assert_idle(session)
    session.rollback()
    with heavy_writer(name='review-profile-only-people') as acquired:
        if not acquired:
            raise HTTPException(409, '后台正在处理，请稍后整理')
        session.connection().exec_driver_sql('BEGIN IMMEDIATE')
        assert_idle(session)
        current, faces = _preview(session)
        if current['profile_key'] != profile_key or current['fingerprint'] != fingerprint:
            session.rollback()
            raise HTTPException(409, '人物或资料库已变化，请重新检查')
        if not faces:
            session.rollback()
            return {'people_count': 0, 'face_count': 0, 'matched': 0, 'pending': 0}
        identifier = uuid.uuid4().hex
        originals = {face['id']: face['person_id'] for face in faces}
        vectors, face_ids = [], []
        for face in faces:
            session.execute(text('UPDATE face SET person_id=NULL WHERE id=:id'), {'id': face['id']})
            session.execute(text('UPDATE face_embeddings SET person_id=-1 WHERE face_id=:id'), {'id': face['id']})
            embedding = session.execute(text('SELECT embedding FROM face_embeddings WHERE face_id=:id'), {'id': face['id']}).first()
            vector = vector_from_stored(embedding[0]) if embedding else None
            if vector is not None and vector.size and np.isfinite(vector).all() and np.any(vector):
                face_ids.append(face['id'])
                vectors.append(vector)
        if face_ids:
            _match_unassigned_to_existing(session, face_ids, np.asarray(vectors, dtype=np.float32), None,
                                          commit=False, origin_by_face=originals)
        session.expire_all()
        after = {face['id']: session.execute(text('SELECT person_id FROM face WHERE id=:id'), {'id': face['id']}).scalar() for face in faces}
        matched = sum(owner is not None for owner in after.values())
        for person in current['items']:
            session.execute(text('INSERT OR REPLACE INTO frontal_archived_person VALUES(:id,:event)'), {'id': person['id'], 'event': identifier})
        _refresh(session, set(originals.values()) | {p for p in after.values() if p is not None})
        payload = {'people': current['items'], 'faces': faces, 'after': after}
        session.execute(text('''INSERT INTO frontal_review_history(id,created_at,people_count,face_count,matched,pending,payload)
            VALUES(:id,:at,:people,:faces,:matched,:pending,:payload)'''),
            {'id': identifier, 'at': datetime.now(timezone.utc).isoformat(), 'people': current['people_count'],
             'faces': len(faces), 'matched': matched, 'pending': len(faces)-matched, 'payload': json.dumps(payload)})
        session.commit()
        return {'id': identifier, 'people_count': current['people_count'], 'face_count': len(faces), 'matched': matched, 'pending': len(faces)-matched}


def undo(session, identifier):
    from app.person_review import assert_idle
    from app.presentation import ensure_writable
    from app.concurrency import heavy_writer
    ensure_writable()
    ensure_schema()
    assert_idle(session)
    session.rollback()
    with heavy_writer(name='undo-profile-review'):
        session.connection().exec_driver_sql('BEGIN IMMEDIATE')
        assert_idle(session)
        event = session.execute(text('SELECT * FROM frontal_review_history WHERE id=:id'), {'id': identifier}).mappings().first()
        if not event or event['undone_at']:
            raise HTTPException(409, '记录不存在或已撤销')
        payload = json.loads(event['payload'])
        affected = set()
        for face in payload['faces']:
            current = session.execute(text('''SELECT f.person_id,pin.face_id FROM face f LEFT JOIN face_manual_assignment pin ON pin.face_id=f.id
                WHERE f.id=:id'''), {'id': face['id']}).first()
            if not current or current[1] is not None or current[0] != payload['after'][str(face['id'])]:
                raise HTTPException(409, '这些人脸已有后续修改，未覆盖，请使用整段纠错核对')
            if not session.execute(text('SELECT id FROM person WHERE id=:id'), {'id': face['person_id']}).first():
                raise HTTPException(409, '原人物已合并或删除，未覆盖后续结果')
            affected.add(face['person_id'])
            if current[0] is not None:
                affected.add(current[0])
        for face in payload['faces']:
            session.execute(text('UPDATE face SET person_id=:p WHERE id=:id'), {'p': face['person_id'], 'id': face['id']})
            session.execute(text('UPDATE face_embeddings SET person_id=:p WHERE face_id=:id'), {'p': face['person_id'], 'id': face['id']})
        session.execute(text('DELETE FROM frontal_archived_person WHERE event_id=:id'), {'id': identifier})
        _refresh(session, affected)
        session.execute(text('UPDATE frontal_review_history SET undone_at=:at WHERE id=:id'), {'id': identifier, 'at': datetime.now(timezone.utc).isoformat()})
        session.commit()
        return {'restored_faces': len(payload['faces'])}
