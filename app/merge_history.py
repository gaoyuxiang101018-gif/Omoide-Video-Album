"""Transactional journals for user initiated merges. No recognition is performed."""
import json
import threading
import uuid
import weakref
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import text

import app.database as db
from app.presentation import ensure_writable

_lock = threading.Lock()
_ready = weakref.WeakSet()


def ensure_schema():
    with _lock:
        if db.engine in _ready:
            return
        with db.engine.begin() as connection:
            connection.exec_driver_sql('CREATE TABLE IF NOT EXISTS person_merge_identity (person_id INTEGER PRIMARY KEY, token TEXT NOT NULL UNIQUE)')
            connection.exec_driver_sql('INSERT OR IGNORE INTO person_merge_identity SELECT id,lower(hex(randomblob(16))) FROM person')
            connection.exec_driver_sql('CREATE TRIGGER IF NOT EXISTS person_merge_identity_insert AFTER INSERT ON person BEGIN INSERT OR REPLACE INTO person_merge_identity VALUES(new.id,lower(hex(randomblob(16)))); END')
            connection.exec_driver_sql('CREATE TRIGGER IF NOT EXISTS person_merge_identity_delete AFTER DELETE ON person BEGIN DELETE FROM person_merge_identity WHERE person_id=old.id; END')
            connection.exec_driver_sql('''CREATE TABLE IF NOT EXISTS person_merge_history (
                seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL, source_id INTEGER NOT NULL, target_id INTEGER NOT NULL,
                source_name TEXT, target_name TEXT, payload TEXT NOT NULL,
                undone_at TEXT, restored_id INTEGER)''')
        _ready.add(db.engine)


def rows(session, sql, params):
    return [dict(row) for row in session.execute(text(sql), params).mappings()]


def snapshot(session, source_id, target_id):
    from app.person_review import members
    params = {'s': source_id, 't': target_id}
    people = rows(session, 'SELECT * FROM person WHERE id IN (:s,:t)', params)
    return {
        'source_id': source_id,
        'review_members': {str(p['id']): members(session, p['id']) for p in people},
        'identities': {str(r['person_id']): r['token'] for r in rows(session, 'SELECT * FROM person_merge_identity WHERE person_id IN (:s,:t)', params)},
        'people': people,
        'faces': [r['id'] for r in rows(session, 'SELECT id FROM face WHERE person_id=:s', params)],
        'links': rows(session, 'SELECT * FROM personmedialink WHERE person_id IN (:s,:t)', params),
        'tags': rows(session, 'SELECT * FROM persontaglink WHERE person_id IN (:s,:t)', params),
        'events': rows(session, 'SELECT id FROM timelineevent WHERE person_id=:s', params),
        'relations': rows(session, 'SELECT * FROM person_relationship WHERE person_a_id IN (:s,:t) OR person_b_id IN (:s,:t)', params),
    }


def record(session, before, source_id, target_id):
    session.flush()
    after = snapshot(session, source_id, target_id)
    people = {p['id']: p for p in before['people']}
    session.execute(text('''INSERT INTO person_merge_history
        (id,created_at,source_id,target_id,source_name,target_name,payload)
        VALUES(:id,:at,:s,:t,:sn,:tn,:payload)'''), {
        'id': uuid.uuid4().hex, 'at': datetime.now(timezone.utc).isoformat(),
        's': source_id, 't': target_id, 'sn': people[source_id]['name'], 'tn': people[target_id]['name'],
        'payload': json.dumps({'before': before, 'after': after}, ensure_ascii=False),
    })


def _blocked(session, item, payload):
    if item['undone_at']:
        return '这条合并已经撤销'
    target = item['target_id']
    identity = rows(session, 'SELECT token FROM person_merge_identity WHERE person_id=:id', {'id': target})
    if not identity or identity[0]['token'] != payload['after']['identities'].get(str(target)):
        return '目标人物已被删除或编号已被新人物使用，已保护新人物，暂不能撤销'
    if not rows(session, 'SELECT id FROM person WHERE id=:id', {'id': target}):
        return '目标人物已被删除或合并，请先撤销后续合并'
    later = rows(session, '''SELECT id FROM person_merge_history WHERE seq>:seq AND undone_at IS NULL
        AND (source_id=:id OR target_id=:id) LIMIT 1''', {'seq': item['seq'], 'id': target})
    if later:
        return '请先撤销涉及该人物的后续合并'
    face_ids = payload['before']['faces']
    for offset in range(0, len(face_ids), 400):
        chunk = face_ids[offset:offset+400]
        ids = ','.join(str(int(i)) for i in chunk)
        found = rows(session, f'SELECT id,person_id FROM face WHERE id IN ({ids})', {})
        if len(found) != len(chunk) or any(r['person_id'] != target for r in found):
            return '部分原人脸后来被移动或删除，已保护这些修改，暂不能撤销'
    # Relationship recalculation is not reversible by subtracting arbitrary counts.
    # Reject changed affected pairs rather than overwrite later analysis results.
    before_pairs = {(r['person_a_id'], r['person_b_id']) for r in payload['before']['relations'] if item['source_id'] in (r['person_a_id'], r['person_b_id'])}
    pairs = {tuple(sorted(target if p == item['source_id'] else p for p in pair)) for pair in before_pairs}
    expected = {(r['person_a_id'], r['person_b_id']): r for r in payload['after']['relations']}
    for a, b in pairs:
        if a == b:
            continue
        current = rows(session, 'SELECT * FROM person_relationship WHERE person_a_id=:a AND person_b_id=:b', {'a': a, 'b': b})
        if (current[0] if current else None) != expected.get((a, b)):
            return '相关同框关系后来已更新，已保护新结果，暂不能撤销'
    return None


def history(session, limit=100):
    ensure_schema()
    items = rows(session, 'SELECT * FROM person_merge_history ORDER BY seq DESC LIMIT :limit', {'limit': limit})
    result = []
    for item in items:
        payload = json.loads(item.pop('payload'))
        reason = _blocked(session, item, payload)
        result.append({**item, 'face_count': len(payload['before']['faces']), 'can_undo': reason is None, 'reason': reason})
    return {'items': result, 'scope': '安装后的手动合并；同一目标的多次合并请从最新一条开始撤销'}


def undo(session, journal_id):
    ensure_writable()
    ensure_schema()
    session.connection().exec_driver_sql('BEGIN IMMEDIATE')
    found = rows(session, 'SELECT * FROM person_merge_history WHERE id=:id', {'id': journal_id})
    if not found:
        raise HTTPException(404, '合并记录不存在')
    item = found[0]
    payload = json.loads(item['payload'])
    reason = _blocked(session, item, payload)
    if reason:
        raise HTTPException(409, reason)
    before, after = payload['before'], payload['after']
    source, target = item['source_id'], item['target_id']
    old_people = {p['id']: p for p in before['people']}
    restored = dict(old_people[source])
    # SQLite may reuse a deleted integer id. Never replace an unrelated new person.
    if rows(session, 'SELECT id FROM person WHERE id=:id', {'id': source}):
        restored.pop('id')
    columns = ','.join(restored)
    cursor = session.execute(text(f'INSERT INTO person ({columns}) VALUES ({",".join(":"+c for c in restored)})'), restored)
    restored_id = restored.get('id', cursor.lastrowid)
    session.execute(text('UPDATE person_merge_identity SET token=:token WHERE person_id=:id'), {'token': before['identities'][str(source)], 'id': restored_id})
    for offset in range(0, len(before['faces']), 400):
        ids = ','.join(str(int(i)) for i in before['faces'][offset:offset+400])
        session.execute(text(f'UPDATE face SET person_id=:id WHERE id IN ({ids})'), {'id': restored_id})
        session.execute(text(f'UPDATE face_embeddings SET person_id=:id WHERE face_id IN ({ids})'), {'id': restored_id})
    for table, key, field in (('personmedialink', 'links', 'media_id'), ('persontaglink', 'tags', 'tag_id')):
        previous = {r[field] for r in before[key] if r['person_id'] == target}
        after_rows = {r[field]: r for r in after[key] if r['person_id'] == target}
        for row in before[key]:
            if row['person_id'] != source:
                continue
            values = {**row, 'person_id': restored_id}
            session.execute(text(f'INSERT OR IGNORE INTO {table} ({",".join(values)}) VALUES ({",".join(":"+c for c in values)})'), values)
            if row[field] not in previous:
                current = rows(session, f'SELECT * FROM {table} WHERE person_id=:p AND {field}=:v', {'p': target, 'v': row[field]})
                if current and current[0] == after_rows.get(row[field]):
                    session.execute(text(f'DELETE FROM {table} WHERE person_id=:p AND {field}=:v'), {'p': target, 'v': row[field]})
    for event in before['events']:
        session.execute(text('UPDATE timelineevent SET person_id=:p WHERE id=:id AND person_id=:target'), {'p': restored_id, 'id': event['id'], 'target': target})
    for relation in before['relations']:
        if source not in (relation['person_a_id'], relation['person_b_id']):
            continue
        pair = sorted(target if p == source else p for p in (relation['person_a_id'], relation['person_b_id']))
        if pair[0] != pair[1]:
            session.execute(text('DELETE FROM person_relationship WHERE person_a_id=:a AND person_b_id=:b'), {'a': pair[0], 'b': pair[1]})
            prior = next((r for r in before['relations'] if (r['person_a_id'], r['person_b_id']) == tuple(pair)), None)
            if prior:
                session.execute(text('INSERT INTO person_relationship VALUES (:person_a_id,:person_b_id,:coappearance_count,:last_media_id,:updated_at)'), prior)
        values = dict(relation)
        values['person_a_id'], values['person_b_id'] = sorted(restored_id if p == source else p for p in (relation['person_a_id'], relation['person_b_id']))
        session.execute(text('INSERT INTO person_relationship VALUES (:person_a_id,:person_b_id,:coappearance_count,:last_media_id,:updated_at)'), values)
    after_target = next(p for p in after['people'] if p['id'] == target)
    for field in ('name', 'age', 'gender', 'is_favorite', 'profile_face_id'):
        if old_people[target][field] != after_target[field]:
            session.execute(text(f'UPDATE person SET {field}=:old WHERE id=:id AND {field} IS :new'), {'old': old_people[target][field], 'new': after_target[field], 'id': target})
    from app.persons import recalculate_person_appearance_counts, rebuild_person_embedding, auto_select_profile_face
    session.expire_all()
    from app.models import Person
    for person_id in (restored_id, target):
        person = session.get(Person, person_id)
        if person.profile_face_id and not rows(session, 'SELECT id FROM face WHERE id=:id AND person_id=:p', {'id': person.profile_face_id, 'p': person_id}):
            person.profile_face_id = None
        session.flush()
        if not person.profile_face_id:
            auto_select_profile_face(session, person_id)
        rebuild_person_embedding(session, person_id, keep_empty=True)
    recalculate_person_appearance_counts(session, [restored_id, target])
    from app.person_review import restore_members
    restore_members(session, before, restored_id, target)
    session.execute(text('UPDATE person_merge_history SET undone_at=:at,restored_id=:p WHERE id=:id'), {'at': datetime.now(timezone.utc).isoformat(), 'p': restored_id, 'id': journal_id})
    session.commit()
    return {'restored_id': restored_id, 'target_id': target, 'face_count': len(before['faces'])}
