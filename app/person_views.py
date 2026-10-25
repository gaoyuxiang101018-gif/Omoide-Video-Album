"""Small, revisioned person views. Cached JSON stays beside the P-drive library."""
import hashlib
import json
from pathlib import Path
import threading
import uuid
import weakref

from fastapi import HTTPException
from sqlalchemy import text
from sqlmodel import Session

import app.database as db
from app.config import settings
from app.logger import logger

_schema_lock = threading.Lock()
_cache_lock = threading.RLock()
_initialized = weakref.WeakSet()


def ensure_schema():
    from app.frontal_policy import ensure_schema as frontal_schema
    frontal_schema()
    engine = db.engine
    with _schema_lock:
        if engine in _initialized:
            return
        with engine.begin() as connection:
            connection.exec_driver_sql('CREATE TABLE IF NOT EXISTS person_view_revision (id INTEGER PRIMARY KEY CHECK(id=1), epoch TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0)')
            connection.execute(text('INSERT OR IGNORE INTO person_view_revision(id,epoch,revision) VALUES(1,:epoch,0)'), {'epoch': uuid.uuid4().hex})
            for table in ('face', 'person', 'personmedialink', 'media'):
                for event in ('INSERT', 'UPDATE', 'DELETE'):
                    connection.exec_driver_sql(f'CREATE TRIGGER IF NOT EXISTS person_view_{table}_{event.lower()} AFTER {event} ON {table} BEGIN UPDATE person_view_revision SET revision=revision+1 WHERE id=1; END')
        _initialized.add(engine)


def state(session: Session):
    ensure_schema()
    epoch, revision = session.execute(text('SELECT epoch,revision FROM person_view_revision WHERE id=1')).one()
    profile = str(Path(settings.general.data_dir).resolve()).casefold()
    key = hashlib.sha256((profile + ':' + epoch).encode()).hexdigest()[:24]
    return {'profile_key': key, 'revision': str(revision)}


def _cached(session, name, build):
    stamp = state(session)
    root = settings.general.omoide_dir / 'view-cache'
    path = root / (name + '.json')
    with _cache_lock:
        try:
            if path.stat().st_size <= 32 * 1024 * 1024:
                saved = json.loads(path.read_text('utf8'))
                if isinstance(saved,dict) and all(saved.get(key) == value for key, value in stamp.items()):
                    return {**saved, 'cache_hit': True}
        except (OSError, ValueError):
            pass
        result = {**stamp, **build(), 'cache_hit': False}
        if state(session) == stamp:
            temporary = path.with_suffix('.' + uuid.uuid4().hex + '.tmp')
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                temporary.write_text(json.dumps(result, ensure_ascii=False), 'utf8')
                temporary.replace(path)
            except OSError:
                logger.debug('Person view cache could not be saved',exc_info=True)
            finally:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass
            if name.startswith('evidence/'):
                try:
                    files = sorted(path.parent.glob('*.json'), key=lambda item: item.stat().st_mtime)
                    for obsolete in files[:-100]:
                        obsolete.unlink(missing_ok=True)
                except OSError:
                    logger.debug('Person view cache could not be pruned',exc_info=True)
        return result


def overview(session: Session):
    def build():
        from app.frontal_policy import visible_person_sql
        rows = session.execute(text(f'''
            WITH counts AS (SELECT person_id,COUNT(*) face_count FROM face WHERE person_id IS NOT NULL GROUP BY person_id),
            appearances AS (SELECT person_id,media_id FROM face WHERE person_id IS NOT NULL UNION SELECT person_id,media_id FROM personmedialink),
            videos AS (SELECT a.person_id,COUNT(*) video_count,MAX(m.created_at) latest_video FROM appearances a JOIN media m ON m.id=a.media_id WHERE m.duration IS NOT NULL GROUP BY a.person_id)
            SELECT p.id,p.name,p.is_favorite,p.appearance_count,f.id profile_id,f.media_id profile_media_id,f.thumbnail_path,f.timestamp,
                   COALESCE(c.face_count,0) face_count,COALESCE(v.video_count,0) video_count,v.latest_video
            FROM person p LEFT JOIN face f ON f.id=p.profile_face_id LEFT JOIN counts c ON c.person_id=p.id LEFT JOIN videos v ON v.person_id=p.id
            WHERE {visible_person_sql()} ORDER BY p.id DESC
        ''')).mappings()
        items = []
        for row in rows:
            items.append({'id': row['id'], 'name': row['name'], 'is_favorite': bool(row['is_favorite']), 'appearance_count': row['appearance_count'],
                'profile_face': {'id': row['profile_id'], 'media_id': row['profile_media_id'], 'thumbnail_path': row['thumbnail_path'], 'timestamp': row['timestamp']} if row['profile_id'] else None,
                'faceCount': row['face_count'], 'videoCount': row['video_count'], 'latestVideo': row['latest_video']})
        return {'items': items}
    return _cached(session, 'overview', build)


def evidence(session: Session, person_id: int):
    def build():
        if not session.execute(text('SELECT id FROM person WHERE id=:id'), {'id': person_id}).first():
            raise HTTPException(404, 'Person not found')
        faces = [dict(row) for row in session.execute(text('SELECT id,media_id,thumbnail_path,timestamp FROM face WHERE person_id=:id ORDER BY id'), {'id': person_id}).mappings()]
        media = [dict(row) for row in session.execute(text('''SELECT m.id,m.path,m.filename,m.thumbnail_path,m.duration,m.width,m.height,m.created_at,m.inserted_at
            FROM media m JOIN (SELECT media_id FROM face WHERE person_id=:id UNION SELECT media_id FROM personmedialink WHERE person_id=:id) a ON a.media_id=m.id ORDER BY m.created_at DESC,m.id DESC'''), {'id': person_id}).mappings()]
        return {'faces': faces, 'media': media}
    return _cached(session, f'evidence/{person_id}', build)


def first_seen_people(session: Session):
    """One person per earliest observed video capture day, never import day."""
    def build():
        from app.frontal_policy import visible_person_sql
        rows = session.execute(text(f'''
            WITH observed AS (
                SELECT f.person_id,m.id media_id,m.filename,m.created_at,
                    CASE WHEN date(substr(m.created_at,1,10),'+0 days')=substr(m.created_at,1,10)
                         THEN substr(m.created_at,1,10) END first_date,
                    MIN(CASE WHEN f.timestamp>=0 AND f.timestamp<=m.duration THEN f.timestamp END) first_timestamp
                FROM face f JOIN media m ON m.id=f.media_id
                WHERE f.person_id IS NOT NULL AND m.duration IS NOT NULL
                GROUP BY f.person_id,m.id
            ), ranked AS (
                SELECT *,ROW_NUMBER() OVER (
                    PARTITION BY person_id ORDER BY first_date IS NULL,first_date,created_at,media_id
                ) position FROM observed
            )
            SELECT p.id,p.name,p.is_favorite,p.appearance_count,
                pf.id profile_id,pf.media_id profile_media_id,pf.thumbnail_path,pf.timestamp,
                r.first_date,r.media_id first_media_id,r.filename first_filename,r.first_timestamp
            FROM person p LEFT JOIN ranked r ON r.person_id=p.id AND r.position=1
                LEFT JOIN face pf ON pf.id=p.profile_face_id
            WHERE {visible_person_sql()}
            ORDER BY r.first_date IS NULL,r.first_date DESC,p.id
        ''')).mappings()
        return {'items': [
            {'id': row['id'], 'name': row['name'], 'is_favorite': bool(row['is_favorite']),
             'appearance_count': row['appearance_count'],
             'profile_face': {'id': row['profile_id'], 'media_id': row['profile_media_id'],
                 'thumbnail_path': row['thumbnail_path'], 'timestamp': row['timestamp']} if row['profile_id'] else None,
             'first_date': row['first_date'], 'first_media_id': row['first_media_id'],
             'first_filename': row['first_filename'], 'first_timestamp': row['first_timestamp']}
            for row in rows
        ]}
    return _cached(session, 'first-seen', build)


def first_appearances(session: Session, media_id: int, gap: float = 4):
    gap = max(0, min(10, gap))
    def build():
        media = session.execute(text('SELECT id,duration FROM media WHERE id=:id'), {'id': media_id}).mappings().first()
        if not media:
            raise HTTPException(404, 'Media not found')
        if media['duration'] is None:
            return {'items': []}
        rows = session.execute(text('''SELECT f.person_id,f.timestamp,p.name,pf.thumbnail_path FROM face f JOIN person p ON p.id=f.person_id LEFT JOIN face pf ON pf.id=p.profile_face_id
            WHERE f.media_id=:id AND f.timestamp>=0 AND f.timestamp<=:duration ORDER BY f.person_id,f.timestamp,f.id'''), {'id': media_id, 'duration': media['duration']}).mappings()
        groups = {}
        for row in rows:
            key = row['person_id']; stamp = row['timestamp']
            if key not in groups:
                groups[key] = {'person_id': key, 'name': row['name'], 'thumbnail_path': row['thumbnail_path'], 'start': stamp, 'end': stamp, 'detections': 1, '_closed': False}
            elif not groups[key]['_closed']:
                if stamp - groups[key]['end'] <= gap:
                    groups[key]['end'] = stamp; groups[key]['detections'] += 1
                else:
                    groups[key]['_closed'] = True
        return {'items': sorted(({key: value for key, value in item.items() if key != '_closed'} for item in groups.values()), key=lambda item: (item['start'], item['person_id']))}
    return _cached(session, f'first/{media_id}-{gap:g}', build)
