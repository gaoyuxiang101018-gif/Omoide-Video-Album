"""Isolated database tests for restoration-to-album registration."""
import json
import sqlite3
from datetime import datetime
from pathlib import Path
import unittest
from unittest.mock import patch

def run(root):
    from app.local_progress_selftest import run as legacy
    root=Path(root)
    if not legacy(root/'legacy'):return False
    from sqlmodel import Session,select
    import app.database as db
    from app.config import settings
    from app.models import Media,Face
    import app.restored_media as restored
    from app.api.media.restored import SyncRequest,sync_restored
    cache=root/'restore-cache'
    restored.RESTORE_CACHE=cache
    queue=cache/restored.profile_key()/'film.sqlite3';queue.parent.mkdir(parents=True,exist_ok=True)
    with sqlite3.connect(queue) as connection:
        connection.executescript('''CREATE TABLE export_jobs(id TEXT PRIMARY KEY,mode TEXT);
            CREATE TABLE export_items(job_id TEXT,item_index INTEGER,status TEXT,video_json TEXT,output TEXT,
                output_size INTEGER,output_mtime_ns INTEGER);''')
    class Checks(unittest.TestCase):
        def fixture(self,name):
            folder=root/name;folder.mkdir()
            source=folder/'source.mp4';source.write_bytes(b'original-fixture')
            output=folder/'elsewhere'/'source_HLG.mp4';output.parent.mkdir();output.write_bytes(b'output-fixture')
            with Session(db.engine) as session:
                media=Media(path=str(source),filename=source.name,size=source.stat().st_size,duration=10,created_at=datetime(2026,10,18,9,30),faces_extracted=True)
                session.add(media);session.commit();session.refresh(media)
                session.add(Face(media_id=media.id,bbox=[0,0,2,2],timestamp=0));session.commit();source_id=media.id
            with sqlite3.connect(queue) as connection:
                connection.execute('INSERT INTO export_jobs VALUES(?,?)',(name,'hlg'))
                connection.execute('INSERT INTO export_items VALUES(?,?,?,?,?,?,?)',(name,0,'succeeded',json.dumps({'path':str(source)}),str(output),output.stat().st_size,output.stat().st_mtime_ns))
            return source,output,source_id
        def importer(self,name):
            def parse(path):return Media(path=str(path),filename=path.name,size=path.stat().st_size,duration=10,width=1280,height=720),None,None
            with patch.object(restored,'process_file',side_effect=parse),patch.object(restored,'generate_thumbnail',return_value=('restored-fixture.jpg',None)):
                return restored.import_output(name,0)
        def test_import_idempotent_preserves_capture_date_and_original_faces(self):
            source,output,source_id=self.fixture('idempotent')
            first=self.importer('idempotent');again=self.importer('idempotent')
            self.assertEqual(first['media_id'],again['media_id']);self.assertEqual(again['status'],'existing')
            with Session(db.engine) as session:
                media=session.get(Media,first['media_id'])
                self.assertEqual(media.created_at,datetime(2026,10,18,9,30))
                self.assertEqual(media.path,str(output.resolve()));self.assertFalse(media.faces_extracted)
                self.assertTrue(session.get(Media,source_id).faces_extracted)
                self.assertEqual(len(session.exec(select(Face).where(Face.media_id==source_id)).all()),1)
            self.assertEqual(source.read_bytes(),b'original-fixture')
            link=next(row for row in restored.list_links()['items'] if row['media_id']==first['media_id'])
            self.assertEqual(link['source_path'],str(source));self.assertTrue(link['valid'])
        def test_missing_or_changed_output_never_imported(self):
            _,output,_=self.fixture('changed')
            output.write_bytes(b'changed-version')
            with self.assertRaises(ValueError):self.importer('changed')
            output.unlink()
            with self.assertRaises(OSError):self.importer('changed')
        def test_only_successful_queue_items_accepted(self):
            self.fixture('queued')
            with sqlite3.connect(queue) as connection:connection.execute("UPDATE export_items SET status='queued' WHERE job_id='queued'")
            with self.assertRaises(ValueError):self.importer('queued')
        def test_stale_profile_request_cannot_import_into_current_library(self):
            from fastapi import HTTPException
            with self.assertRaises(HTTPException) as failure:
                sync_restored(SyncRequest(profile_path=str(root/'other-profile'),items=[{'job_id':'anything','item_index':0}]))
            self.assertEqual(failure.exception.status_code,409)
        def test_existing_scanned_output_is_reused(self):
            _,output,_=self.fixture('reuse')
            with Session(db.engine) as session:
                media=Media(path=str(output.resolve()),filename=output.name,size=output.stat().st_size,duration=10,thumbnail_path='existing.jpg',faces_extracted=True)
                session.add(media);session.commit();session.refresh(media);identifier=media.id
            result=self.importer('reuse')
            self.assertEqual(result['media_id'],identifier)
            with Session(db.engine) as session:self.assertTrue(session.get(Media,identifier).faces_extracted)
        def test_link_marks_missing_output_invalid_without_deleting_record(self):
            _,output,_=self.fixture('missing-after-import')
            result=self.importer('missing-after-import');output.unlink()
            link=next(row for row in restored.list_links()['items'] if row['media_id']==result['media_id'])
            self.assertFalse(link['valid'])
            with Session(db.engine) as session:self.assertIsNotNone(session.get(Media,result['media_id']))
    import io
    stream=io.StringIO();result=unittest.TextTestRunner(stream=stream,verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Checks))
    report={'success':result.wasSuccessful(),'tests':result.testsRun,'legacy_tests':9,'output':stream.getvalue(),'real_face_inference_started':False,'real_restoration_started':False}
    (root/'selftest-result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),'utf8')
    return result.wasSuccessful()
