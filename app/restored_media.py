"""Register verified restoration outputs without moving media or face data."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import time

from sqlalchemy import inspect
from sqlmodel import Field, Session, SQLModel, select

import app.database as db
from app.config import settings
from app.concurrency import heavy_writer
from app.database import safe_commit
from app.media_files import process_file
from app.media_paths import canonical_path_key, media_path_aliases, path_key
from app.models import Media
from app.thumbnails import generate_thumbnail

RESTORE_CACHE = Path(os.environ.get('OMOIDE_CACHE_DIR', str(settings.general.models_dir.parent / 'cache'))) / 'film'


class RestoredOutputLink(SQLModel, table=True):
    media_id: int = Field(primary_key=True, foreign_key='media.id', ondelete='CASCADE')
    output_key: str = Field(unique=True, index=True)
    source_path: str
    source_media_id: int
    output_path: str
    output_size: int
    output_mtime_ns: int
    job_id: str
    item_index: int
    mode: str


def profile_key():
    return hashlib.sha256(str(Path(settings.general.data_dir).resolve()).lower().encode()).hexdigest()[:20]


def snapshot(path):
    stat = Path(path).stat()
    if not Path(path).is_file() or stat.st_size <= 0:
        raise ValueError('成片不是有效文件。')
    return stat.st_size, stat.st_mtime_ns


def queue_item(job_id, index):
    database = RESTORE_CACHE/profile_key()/'film.sqlite3'
    if not database.is_file():
        raise ValueError('当前资料库没有还原记录。')
    connection = sqlite3.connect(database.resolve().as_uri()+'?mode=ro',uri=True,timeout=5)
    connection.row_factory = sqlite3.Row
    try:
        row = connection.execute('''SELECT i.*,j.mode FROM export_items i
            JOIN export_jobs j ON j.id=i.job_id WHERE i.job_id=? AND i.item_index=?''',(job_id,index)).fetchone()
    finally:
        connection.close()
    if row is None or row['status'] != 'succeeded' or not row['output']:
        raise ValueError('该视频尚未成功还原。')
    item = dict(row)
    item['video'] = json.loads(item['video_json'])
    if snapshot(item['output']) != (item['output_size'],item['output_mtime_ns']):
        raise ValueError('成片已移动或改变，暂不入库。')
    return item


def list_links():
    if not inspect(db.engine).has_table(RestoredOutputLink.__tablename__):
        return {'data_dir':str(settings.general.data_dir),'items':[]}
    with Session(db.engine) as session:
        links = session.exec(select(RestoredOutputLink)).all()
        result = []
        for link in links:
            if session.get(Media,link.media_id) is None:
                continue
            try: valid = snapshot(link.output_path) == (link.output_size,link.output_mtime_ns)
            except (OSError,ValueError): valid = False
            result.append({**link.model_dump(),'valid':valid})
    return {'data_dir':str(settings.general.data_dir),'items':result}


def import_output(job_id, index):
    deadline = time.monotonic()+2
    with heavy_writer(name='import-restored-output',cancelled=lambda:time.monotonic()>deadline) as acquired:
        if not acquired:
            raise RuntimeError('资料库正在处理其他任务，稍后自动重试。')
        item = queue_item(job_id,index)
        output = Path(item['output']).resolve()
        output_key = path_key(output)
        aliases = media_path_aliases(settings.general.media_dirs)
        source_path = item['video']['path']
        source_key = canonical_path_key(source_path,aliases)
        if source_key == canonical_path_key(output,aliases):
            raise ValueError('成片不能覆盖原视频。')
        RestoredOutputLink.__table__.create(db.engine,checkfirst=True)
        with Session(db.engine) as session:
            source_candidates = session.exec(select(Media).where(Media.filename==Path(source_path).name)).all()
            sources = [media for media in source_candidates if canonical_path_key(media.path,aliases)==source_key]
            if not sources:
                raise ValueError('原视频已不在当前资料库中。')
            source = sorted(sources,key=lambda media:(not media.faces_extracted,media.id))[0]
            link = session.exec(select(RestoredOutputLink).where(RestoredOutputLink.output_key==output_key)).first()
            media = session.get(Media,link.media_id) if link else None
            if link and media and (link.output_size,link.output_mtime_ns)==snapshot(output):
                return {'status':'existing','media_id':media.id,'source_path':link.source_path}
            if media and media.faces_extracted:
                raise ValueError('已有成片发生变化，未覆盖其人脸结果。')
            if media is None:
                candidates = session.exec(select(Media).where(Media.filename==output.name)).all()
                for candidate in sorted(candidates,key=lambda media:(not media.faces_extracted,media.id)):
                    try: same = path_key(Path(candidate.path).resolve())==output_key
                    except OSError: same = False
                    if same:
                        media=candidate
                        break
            if media is None:
                media,prepared,error = process_file(output)
                if prepared is not None: prepared.close()
                if media is None or not media.duration or media.duration <= 0:
                    raise ValueError(error or '无法读取成片信息，稍后重试。')
                media.path=str(output)
                media.created_at=source.created_at
                session.add(media);session.flush()
                thumbnail,error = generate_thumbnail(media)
                if not thumbnail:
                    raise ValueError(error or '成片封面生成失败，稍后重试。')
                media.thumbnail_path=thumbnail
                session.add(media)
            if snapshot(output)!=(item['output_size'],item['output_mtime_ns']):
                raise ValueError('入库时成片发生变化，稍后重试。')
            record = RestoredOutputLink(media_id=media.id,output_key=output_key,source_path=source.path,
                source_media_id=source.id,output_path=str(output),output_size=item['output_size'],
                output_mtime_ns=item['output_mtime_ns'],job_id=job_id,item_index=index,mode=item['mode'])
            session.merge(record)
            safe_commit(session)
            return {'status':'imported','media_id':media.id,'source_path':source.path}
