"""Reversible range corrections and stable, transitive do-not-merge rules."""
import hashlib
import json
import threading
import uuid
import weakref
from datetime import datetime, timezone

from fastapi import HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import text

import app.database as db
from app.merge_history import ensure_schema as identity_schema, rows
from app.person_views import state
from app.presentation import ensure_writable

_lock = threading.Lock()
_ready = weakref.WeakSet()


def ensure_schema():
    identity_schema()
    with _lock:
        if db.engine in _ready:
            return
        with db.engine.begin() as c:
            c.exec_driver_sql('CREATE TABLE IF NOT EXISTS person_review_member (token TEXT PRIMARY KEY,person_id INTEGER NOT NULL)')
            c.exec_driver_sql('CREATE INDEX IF NOT EXISTS review_member_owner ON person_review_member(person_id)')
            c.exec_driver_sql('INSERT OR IGNORE INTO person_review_member SELECT token,person_id FROM person_merge_identity')
            c.exec_driver_sql('CREATE TRIGGER IF NOT EXISTS review_member_delete AFTER DELETE ON person BEGIN DELETE FROM person_review_member WHERE person_id=old.id; END')
            c.exec_driver_sql('''CREATE TABLE IF NOT EXISTS person_separation (
                id TEXT UNIQUE NOT NULL,token_a TEXT NOT NULL,token_b TEXT NOT NULL,created_at TEXT NOT NULL,
                PRIMARY KEY(token_a,token_b))''')
            c.exec_driver_sql('''CREATE TABLE IF NOT EXISTS face_manual_assignment (
                face_id INTEGER PRIMARY KEY,person_token TEXT,action TEXT NOT NULL,event_id TEXT NOT NULL)''')
            c.exec_driver_sql('CREATE TRIGGER IF NOT EXISTS review_face_delete AFTER DELETE ON face BEGIN DELETE FROM face_manual_assignment WHERE face_id=old.id; END')
            c.exec_driver_sql('''CREATE TABLE IF NOT EXISTS face_correction_history (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,created_at TEXT NOT NULL,
                media_id INTEGER NOT NULL,start REAL NOT NULL,end REAL NOT NULL,mode TEXT NOT NULL,
                source_label TEXT NOT NULL,target_label TEXT NOT NULL,face_count INTEGER NOT NULL,
                payload TEXT NOT NULL,undone_at TEXT)''')
        _ready.add(db.engine)


def _token(session, person_id):
    result = rows(session, 'SELECT token FROM person_merge_identity WHERE person_id=:id', {'id': person_id})
    if not result:
        raise HTTPException(404, '人物不存在，请刷新')
    return result[0]['token']


def members(session, person_id):
    ensure_schema()
    token = _token(session, person_id)
    result = [r['token'] for r in rows(session, 'SELECT token FROM person_review_member WHERE person_id=:id', {'id': person_id})]
    return list(set(result + [token]))


def can_merge(session, source_id, target_id):
    ensure_schema()
    source, target = set(members(session, source_id)), set(members(session, target_id))
    return not any((r['token_a'] in source and r['token_b'] in target) or (r['token_b'] in source and r['token_a'] in target)
                   for r in rows(session, 'SELECT token_a,token_b FROM person_separation', {}))


def transfer_members(session, source_id, target_id):
    for token in members(session, source_id):
        session.execute(text('INSERT OR REPLACE INTO person_review_member VALUES(:token,:id)'), {'token': token, 'id': target_id})
    for token in members(session, target_id):
        session.execute(text('INSERT OR IGNORE INTO person_review_member VALUES(:token,:id)'), {'token': token, 'id': target_id})


def restore_members(session, snapshot, source_id, target_id):
    original = snapshot.get('source_id')
    if original is None:
        original = next((p['id'] for p in snapshot['people'] if p['id'] != target_id), source_id)
    tokens = snapshot.get('review_members', {}).get(str(original)) or [snapshot.get('identities', {}).get(str(original))]
    for token in (t for t in tokens if t):
        session.execute(text('INSERT OR REPLACE INTO person_review_member VALUES(:token,:id)'), {'token': token, 'id': source_id})


def assert_idle(session):
    active = rows(session, "SELECT id FROM processingtask WHERE status IN ('running','pending') AND task_type!='export_person_clips' LIMIT 1", {})
    if active:
        raise HTTPException(409, '后台分析正在进行，请等任务结束后再纠错或补查；当前可查看时间轴和参数')


def _label(session, person_id):
    if person_id is None:
        return '待确认人脸'
    result = rows(session, 'SELECT name FROM person WHERE id=:id', {'id': person_id})
    return (result[0]['name'] if result else None) or f'未命名人物 #{person_id}'


class Range(BaseModel):
    media_id: int = Field(gt=0)
    start: float = Field(ge=0, allow_inf_nan=False)
    end: float = Field(ge=0, allow_inf_nan=False)
    source_person_id: int | None = Field(default=None, gt=0)


class Correction(Range):
    profile_key: str
    fingerprint: str
    mode: str
    target_person_id: int | None = Field(default=None, gt=0)


def _range(session, request):
    ensure_schema()
    media = rows(session, 'SELECT id,filename,duration FROM media WHERE id=:id', {'id': request.media_id})
    if not media or not media[0]['duration']:
        raise HTTPException(404, '未找到可用视频')
    if request.end < request.start or request.end > media[0]['duration'] + 0.001:
        raise HTTPException(400, '时间范围超出视频或结束早于开始')
    if request.source_person_id is not None:
        _token(session, request.source_person_id)
    result = rows(session, '''SELECT f.id,f.person_id,f.timestamp,f.thumbnail_path,f.bbox,
        pin.person_token,pin.action,pin.event_id
        FROM face f LEFT JOIN face_manual_assignment pin ON pin.face_id=f.id
        WHERE f.media_id=:media AND f.person_id IS :person AND f.timestamp>=:start AND f.timestamp<=:end
        ORDER BY f.timestamp,f.id''', {'media': request.media_id, 'person': request.source_person_id, 'start': request.start, 'end': request.end})
    if len(result) > 20000:
        raise HTTPException(400, '单次最多纠正两万张人脸，请缩小范围')
    fingerprint = hashlib.sha256(json.dumps(result, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    return media[0], result, fingerprint


def preview(session, request):
    media, faces, fingerprint = _range(session, request)
    return {**state(session), 'media': media, 'face_count': len(faces), 'fingerprint': fingerprint,
            'source_label': _label(session, request.source_person_id),
            'faces': [{k: f[k] for k in ('id', 'timestamp', 'thumbnail_path')} for f in faces[:16]]}


def _refresh(session, people):
    from app.persons import rebuild_person_embedding, recalculate_person_appearance_counts
    session.flush()
    session.expire_all()
    for person_id in set(p for p in people if p is not None):
        rebuild_person_embedding(session, person_id, keep_empty=True)
    recalculate_person_appearance_counts(session, [p for p in set(people) if p is not None])


def correct(session, request):
    ensure_writable()
    ensure_schema()
    if request.mode not in ('assign', 'new', 'exclude'):
        raise HTTPException(400, '请选择移给人物、拆出新人或排除自动归类')
    session.connection().exec_driver_sql('BEGIN IMMEDIATE')
    assert_idle(session)
    if state(session)['profile_key'] != request.profile_key:
        raise HTTPException(409, '资料库已切换，请重新打开')
    media, faces, fingerprint = _range(session, request)
    if not faces or fingerprint != request.fingerprint:
        raise HTTPException(409, '该范围的人脸已变化或为空，请重新预览')
    from app.models import Person
    target = request.target_person_id
    if request.mode == 'new':
        person = Person(name=None, appearance_count=0)
        session.add(person); session.flush(); target = person.id
    elif request.mode == 'exclude':
        target = None
    elif target is None:
        raise HTTPException(400, '请选择目标人物')
    if target is not None and target == request.source_person_id:
        raise HTTPException(400, '目标与来源人物相同')
    token = _token(session, target) if target is not None else None
    event_id = uuid.uuid4().hex
    source_label, target_label = _label(session, request.source_person_id), ('排除自动归类' if target is None else _label(session, target))
    payload = {'faces': faces, 'source_id': request.source_person_id,
               'source_token': _token(session, request.source_person_id) if request.source_person_id is not None else None,
               'target_id': target, 'target_token': token}
    for face in faces:
        session.execute(text('UPDATE face SET person_id=:p WHERE id=:id'), {'p': target, 'id': face['id']})
        session.execute(text('UPDATE face_embeddings SET person_id=:p WHERE face_id=:id'), {'p': target if target is not None else -1, 'id': face['id']})
        session.execute(text('INSERT OR REPLACE INTO face_manual_assignment VALUES(:id,:token,:action,:event)'),
                        {'id': face['id'], 'token': token, 'action': request.mode, 'event': event_id})
    _refresh(session, [request.source_person_id, target])
    session.execute(text('''INSERT INTO face_correction_history
        (id,created_at,media_id,start,end,mode,source_label,target_label,face_count,payload)
        VALUES(:id,:at,:media,:start,:end,:mode,:source,:target,:count,:payload)'''), {
        'id': event_id, 'at': datetime.now(timezone.utc).isoformat(), 'media': request.media_id, 'start': request.start, 'end': request.end,
        'mode': request.mode, 'source': source_label, 'target': target_label, 'count': len(faces), 'payload': json.dumps(payload, ensure_ascii=False)})
    session.commit()
    return {'id': event_id, 'face_count': len(faces), 'target_person_id': target}


def undo_correction(session, event_id):
    ensure_writable(); ensure_schema()
    session.connection().exec_driver_sql('BEGIN IMMEDIATE')
    assert_idle(session)
    saved = rows(session, 'SELECT * FROM face_correction_history WHERE id=:id', {'id': event_id})
    if not saved or saved[0]['undone_at']:
        raise HTTPException(409, '记录不存在或已经撤销')
    payload = json.loads(saved[0]['payload'])
    for field in ('source', 'target'):
        person_id, token = payload[field + '_id'], payload[field + '_token']
        if person_id is not None and _token(session, person_id) != token:
            raise HTTPException(409, '相关人物后来被合并或删除，请先处理后续修改')
    for face in payload['faces']:
        current = rows(session, '''SELECT f.person_id,p.event_id FROM face f LEFT JOIN face_manual_assignment p ON p.face_id=f.id WHERE f.id=:id''', {'id': face['id']})
        if not current or current[0]['person_id'] != payload['target_id'] or current[0]['event_id'] != event_id:
            raise HTTPException(409, '部分人脸后来被修改，已保护后续结果，请先撤销较新的纠错')
    for face in payload['faces']:
        session.execute(text('UPDATE face SET person_id=:p WHERE id=:id'), {'p': face['person_id'], 'id': face['id']})
        session.execute(text('UPDATE face_embeddings SET person_id=:p WHERE face_id=:id'), {'p': face['person_id'] if face['person_id'] is not None else -1, 'id': face['id']})
        if face['event_id'] is None:
            session.execute(text('DELETE FROM face_manual_assignment WHERE face_id=:id'), {'id': face['id']})
        else:
            session.execute(text('INSERT OR REPLACE INTO face_manual_assignment VALUES(:id,:token,:action,:event)'), {'id': face['id'], 'token': face['person_token'], 'action': face['action'], 'event': face['event_id']})
    _refresh(session, [payload['source_id'], payload['target_id']])
    session.execute(text('UPDATE face_correction_history SET undone_at=:at WHERE id=:id'), {'at': datetime.now(timezone.utc).isoformat(), 'id': event_id})
    session.commit()
    return {'face_count': len(payload['faces'])}


def add_separation(session, first, second):
    ensure_writable(); ensure_schema()
    session.connection().exec_driver_sql('BEGIN IMMEDIATE'); assert_idle(session)
    if first == second:
        raise HTTPException(400, '请选择两个不同的人物')
    a, b = sorted((_token(session, first), _token(session, second)))
    identifier = uuid.uuid4().hex
    session.execute(text('INSERT OR IGNORE INTO person_separation VALUES(:id,:a,:b,:at)'), {'id': identifier, 'a': a, 'b': b, 'at': datetime.now(timezone.utc).isoformat()})
    # Ensure both identities are discoverable even if they were just created.
    for person in (first, second):
        for token in members(session, person):
            session.execute(text('INSERT OR IGNORE INTO person_review_member VALUES(:token,:id)'), {'token': token, 'id': person})
    session.commit()
    return {'status': 'protected'}


def remove_separation(session, rule_id):
    ensure_writable(); ensure_schema()
    session.connection().exec_driver_sql('BEGIN IMMEDIATE'); assert_idle(session)
    session.execute(text('DELETE FROM person_separation WHERE id=:id'), {'id': rule_id}); session.commit()
    return {'status': 'removed'}


def history(session):
    ensure_schema()
    corrections = rows(session, '''SELECT id,created_at,media_id,start,end,mode,source_label,target_label,face_count,undone_at
        FROM face_correction_history ORDER BY seq DESC LIMIT 100''', {})
    rules = rows(session, '''SELECT s.id,s.created_at,COALESCE(a.person_id,ia.person_id) person_a_id,
        COALESCE(b.person_id,ib.person_id) person_b_id FROM person_separation s
        LEFT JOIN person_review_member a ON a.token=s.token_a LEFT JOIN person_review_member b ON b.token=s.token_b
        LEFT JOIN person_merge_identity ia ON ia.token=s.token_a LEFT JOIN person_merge_identity ib ON ib.token=s.token_b
        ORDER BY s.created_at DESC''', {})
    rules = [{**r, 'person_a_name': _label(session, r['person_a_id']), 'person_b_name': _label(session, r['person_b_id'])}
             for r in rules if r['person_a_id'] is not None and r['person_b_id'] is not None]
    return {'corrections': corrections, 'separations': rules}


def timeline(session, media_id, gap=4):
    media = rows(session, 'SELECT id,filename,path,duration FROM media WHERE id=:id AND duration>0', {'id': media_id})
    if not media:
        raise HTTPException(404, '视频不存在')
    faces = rows(session, '''SELECT f.id,f.person_id,f.timestamp,f.thumbnail_path,p.name FROM face f
        LEFT JOIN person p ON p.id=f.person_id WHERE media_id=:id AND timestamp>=0 AND timestamp<=:duration
        ORDER BY timestamp,f.id''', {'id': media_id, 'duration': media[0]['duration']})
    people = {}
    for face in faces:
        person = people.setdefault(face['person_id'], {'id': face['person_id'], 'name': face['name'], 'thumbnail_path': face['thumbnail_path'], 'segments': [], 'face_count': 0})
        segments = person['segments']; person['face_count'] += 1
        if segments and face['timestamp'] - segments[-1]['end'] <= gap:
            segments[-1]['end'] = face['timestamp']; segments[-1]['detections'] += 1
        else:
            segments.append({'start': face['timestamp'], 'end': face['timestamp'], 'detections': 1, 'thumbnail_path': face['thumbnail_path']})
    return {**state(session), 'media': media[0], 'items': sorted(people.values(), key=lambda p: (-p['face_count'], p['id'] or 0))}
