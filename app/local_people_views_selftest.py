"""Explicit isolated checks for cached person views, first sightings and unnamed merges."""
import asyncio
from datetime import datetime
import io
import importlib
import json
from pathlib import Path
import unittest
from unittest.mock import patch


def fixture(root):
    from sqlmodel import Session
    import app.database as db
    from app.config import settings
    from app.models import Face,Media,Person,PersonMediaLink
    from PIL import Image
    root=Path(root);root.mkdir(parents=True,exist_ok=True)
    db.ensure_vec_tables()
    thumb=settings.general.thumb_dir/'faces/cache-fixture.jpg';thumb.parent.mkdir(parents=True,exist_ok=True)
    Image.new('RGB',(160,160),(94,137,169)).save(thumb)
    with Session(db.engine) as session:
        media=[]
        for index,duration in enumerate((20,10,None)):
            path=root/f'cache-example-{index}.mp4';path.write_bytes(b'isolated fixture')
            row=Media(path=str(path),filename=path.name,size=16,duration=duration,width=320,height=180,created_at=datetime(2026,10,23+min(index,1),10),thumbnail_path='faces/cache-fixture.jpg',faces_extracted=True)
            session.add(row);session.flush();media.append(row.id)
        persons=[]
        for _ in range(2):
            person=Person(name=None,appearance_count=1);session.add(person);session.flush();persons.append(person.id)
        for person_id,stamps in ((persons[0],(0,2,4,12,-1,22,None)),(persons[1],(1,3,9))):
            first=None
            for stamp in stamps:
                face=Face(person_id=person_id,media_id=media[0],thumbnail_path='faces/cache-fixture.jpg',bbox=[0,0,20,20],timestamp=stamp,frontality=.9,det_score=.95)
                session.add(face);session.flush();first=first or face.id
            session.get(Person,person_id).profile_face_id=first
        session.add(Face(person_id=persons[0],media_id=media[2],thumbnail_path='faces/cache-fixture.jpg',bbox=[0,0,20,20],timestamp=None,frontality=.9,det_score=.95))
        session.add(PersonMediaLink(person_id=persons[0],media_id=media[1]))
        session.commit()
    return {'persons':persons,'media':media,'thumbnail':'faces/cache-fixture.jpg'}


def run(root):
    root=Path(root);root.mkdir(parents=True,exist_ok=True)
    from app.local_restored_selftest import run as foundation
    if not foundation(root/'foundation'):return False
    import app.database as db
    import app.person_views as views
    from app.config import settings
    from app.models import Face,Media,Person
    from sqlmodel import Session,select
    from fastapi import HTTPException
    from sqlalchemy import text

    class Checks(unittest.TestCase):
        def setUp(self):
            self.data=fixture(root/self._testMethodName)
            self.session=Session(db.engine)
        def tearDown(self):self.session.close()
        def item(self,snapshot,person_id):return next(item for item in snapshot['items'] if item['id']==person_id)
        def observed_video(self,person_id,created,stamp=12):
            row=Media(path=str(root/f'{self._testMethodName}-{person_id}-{created}-{stamp}.mp4'),filename='gallery.mp4',size=16,duration=30,created_at=created)
            self.session.add(row);self.session.flush()
            self.session.add(Face(person_id=person_id,media_id=row.id,thumbnail_path=self.data['thumbnail'],bbox=[0,0,20,20],timestamp=stamp))
            self.session.commit()
            return row.id
        def test_gallery_uses_capture_day_and_one_entry_per_person(self):
            self.session.execute(text('UPDATE media SET created_at=:date WHERE id IN (:photo,:manual)'),{'date':'1900-01-01','photo':self.data['media'][2],'manual':self.data['media'][1]});self.session.commit()
            result=views.first_seen_people(self.session);person=self.data['persons'][0]
            row=self.item(result,person)
            self.assertEqual((row['first_date'],row['first_media_id'],row['first_timestamp']),('2026-10-23',self.data['media'][0],0))
            self.assertEqual(sum(item['id']==person for item in result['items']),1)
        def test_gallery_unknown_dates_and_photo_only_people_are_not_import_dates(self):
            self.session.execute(text("UPDATE media SET created_at='' WHERE id=:id"),{'id':self.data['media'][0]})
            photo_person=Person(name=None,appearance_count=1);self.session.add(photo_person);self.session.flush()
            self.session.add(Face(person_id=photo_person.id,media_id=self.data['media'][2],bbox=[0,0,20,20]));self.session.commit()
            result=views.first_seen_people(self.session)
            self.assertIsNone(self.item(result,self.data['persons'][0])['first_date'])
            photo=self.item(result,photo_person.id)
            self.assertIsNone(photo['first_date']);self.assertIsNone(photo['first_media_id'])
        def test_gallery_new_older_video_moves_person_and_invalidates_cache(self):
            person=self.data['persons'][0];old=views.first_seen_people(self.session)
            self.assertTrue(views.first_seen_people(self.session)['cache_hit'])
            earlier=self.observed_video(person,datetime(2026,10,20,9))
            result=views.first_seen_people(self.session)
            self.assertNotEqual(result['revision'],old['revision']);self.assertFalse(result['cache_hit'])
            self.assertEqual((self.item(result,person)['first_date'],self.item(result,person)['first_media_id']),('2026-10-20',earlier))
        def test_gallery_merge_keeps_earliest_day_and_all_face_records(self):
            from app.api.person.merging import merge_multiple_persons
            from app.schemas.person import MergePersonsBulkRequest
            target,source=self.data['persons'];self.observed_video(source,datetime(2026,10,20,9))
            self.assertEqual(self.item(views.first_seen_people(self.session),target)['first_date'],'2026-10-23')
            merge_multiple_persons(target,MergePersonsBulkRequest(source_ids=[source]),self.session)
            result=views.first_seen_people(self.session)
            self.assertEqual(self.item(result,target)['first_date'],'2026-10-20')
            self.assertFalse(any(row['id']==source for row in result['items']))
            self.assertEqual(len(views.evidence(self.session,target)['faces']),12)
        def test_gallery_ignores_invalid_dates_and_preserves_capture_calendar_day(self):
            person=self.data['persons'][0]
            self.session.execute(text('UPDATE media SET created_at=:date WHERE id=:id'),{'date':'not-a-date','id':self.data['media'][0]});self.session.commit()
            earlier=self.observed_video(person,datetime(2026,10,20))
            self.session.execute(text('UPDATE media SET created_at=:date WHERE id=:id'),{'date':'2026-10-20 00:30:00+08:00','id':earlier});self.session.commit()
            self.assertEqual(self.item(views.first_seen_people(self.session),person)['first_date'],'2026-10-20')
        def test_gallery_same_day_chooses_first_capture_and_known_dates_before_unknown(self):
            person=self.data['persons'][0]
            self.session.execute(text("UPDATE media SET created_at='' WHERE id=:id"),{'id':self.data['media'][0]});self.session.commit()
            self.observed_video(person,datetime(2026,10,20,14),stamp=3)
            morning=self.observed_video(person,datetime(2026,10,20,9),stamp=7)
            row=self.item(views.first_seen_people(self.session),person)
            self.assertEqual((row['first_date'],row['first_media_id'],row['first_timestamp']),('2026-10-20',morning,7))
        def test_bulk_statistics_include_photos_but_count_unique_videos_and_dates(self):
            item=self.item(views.overview(self.session),self.data['persons'][0])
            self.assertEqual((item['faceCount'],item['videoCount']),(8,2))
            self.assertTrue(item['latestVideo'].startswith('2026-10-24'))
        def test_disk_cache_reuses_a_complete_snapshot_and_survives_reinitialization(self):
            views.overview(self.session);views._initialized.clear()
            self.assertTrue(views.overview(self.session)['cache_hit'])
            with patch.object(Path,'write_text',side_effect=OSError('unavailable')),patch.object(Path,'unlink',side_effect=OSError('locked')):
                self.assertEqual(views._cached(self.session,'unwritable',lambda:{'items':[]})['items'],[])
        def test_rename_and_face_assignment_invalidate_saved_views(self):
            old=views.overview(self.session);person=self.session.get(Person,self.data['persons'][0]);person.name='缓存更新';self.session.add(person);self.session.commit()
            new=views.overview(self.session);self.assertNotEqual(old['revision'],new['revision']);self.assertEqual(self.item(new,person.id)['name'],'缓存更新')
            record=self.session.exec(select(Face).where(Face.person_id==self.data['persons'][1])).first();record.person_id=person.id;self.session.add(record);self.session.commit()
            self.assertEqual(self.item(views.overview(self.session),person.id)['faceCount'],9)
        def test_first_appearance_is_the_first_contiguous_segment(self):
            rows=views.first_appearances(self.session,self.data['media'][0])['items']
            self.assertEqual([(row['start'],row['end']) for row in rows],[(0,4),(1,3)])
            self.assertEqual(rows[0]['detections'],3)
        def test_zero_gap_and_missing_timestamps_do_not_invent_intervals(self):
            rows=views.first_appearances(self.session,self.data['media'][0],0)['items']
            self.assertEqual([(row['start'],row['end']) for row in rows],[(0,0),(1,1)])
            self.assertEqual(views.first_appearances(self.session,self.data['media'][2])['items'],[])
        def test_full_person_evidence_has_dates_and_caches_without_losing_samples(self):
            person=self.data['persons'][0];result=views.evidence(self.session,person)
            self.assertEqual(len(result['faces']),8);self.assertEqual(len(result['media']),3)
            self.assertTrue(all(item['created_at'] for item in result['media']))
            self.assertTrue(views.evidence(self.session,person)['cache_hit'])
        def test_profile_key_separates_libraries_and_corrupt_cache_is_rebuilt(self):
            original=views.state(self.session)
            with patch.object(settings.general,'data_dir',root/'another-profile'):
                self.assertNotEqual(views.state(self.session)['profile_key'],original['profile_key'])
                self.assertFalse(views.overview(self.session)['cache_hit'])
            views.overview(self.session)
            (settings.general.omoide_dir/'view-cache/overview.json').write_text('{broken','utf8')
            self.assertFalse(views.overview(self.session)['cache_hit'])
        def test_unnamed_merge_preserves_faces_and_invalidates_source_cache(self):
            from app.api.person.merging import merge_multiple_persons
            from app.schemas.person import MergePersonsBulkRequest
            target,source=self.data['persons'];before=views.evidence(self.session,source)
            result=merge_multiple_persons(target,MergePersonsBulkRequest(source_ids=[source]),self.session)
            self.assertEqual(result.merged_ids,[source]);self.assertIsNone(self.session.get(Person,target).name)
            self.assertEqual(len(views.evidence(self.session,target)['faces']),11)
            with self.assertRaises(HTTPException):views.evidence(self.session,source)
            self.assertNotEqual(views.state(self.session)['revision'],before['revision'])
        def test_thumbnail_uses_profile_scope_http_cache_and_etag(self):
            from starlette.requests import Request
            main=importlib.import_module('app.main');key=views.state(self.session)['profile_key']
            request=Request({'type':'http','method':'GET','path':'/','headers':[],'query_string':f'view={key}'.encode()})
            response=asyncio.run(main.serve_thumbnail(self.data['thumbnail'],request))
            self.assertIn('max-age=86400',response.headers['cache-control'])
            conditional=Request({'type':'http','method':'GET','path':'/','headers':[(b'if-none-match',response.headers['etag'].encode())],'query_string':f'view={key}'.encode()})
            self.assertEqual(asyncio.run(main.serve_thumbnail(self.data['thumbnail'],conditional)).status_code,304)
            wrong=Request({'type':'http','method':'GET','path':'/','headers':[],'query_string':b'view=000000000000000000000000'})
            with self.assertRaises(HTTPException):asyncio.run(main.serve_thumbnail(self.data['thumbnail'],wrong))

    stream=io.StringIO();result=unittest.TextTestRunner(stream=stream,verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Checks))
    report={'success':result.wasSuccessful(),'tests':result.testsRun,'foundation_tests':15,'output':stream.getvalue(),'private_media_modified':False,'real_recognition_started':False}
    (root/'selftest-result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),'utf8')
    return result.wasSuccessful()


def serve_preview(root,port):
    root=Path(root);root.mkdir(parents=True,exist_ok=True)
    from app.local_restored_selftest import run as foundation
    assert foundation(root/'foundation')
    from app.config import settings
    from app.config.schema import MediaDirectory
    from fastapi.responses import JSONResponse,Response
    from sqlalchemy import text
    from sqlmodel import Session,select
    import app.database as db
    from app.models import Media
    import uvicorn
    data=fixture(root/'media');settings.general.media_dirs=[MediaDirectory(path=root/'media',read_only=True)]
    if (root/'workbench-preview.json').is_file():
        import subprocess
        options=json.loads((root/'workbench-preview.json').read_text('utf8'))
        ffmpeg=Path(options['ffmpeg']);settings.general.ffmpeg_path=ffmpeg
        with Session(db.engine) as session:
            for index,media_id in enumerate(data['media'][:2]):
                media=session.get(Media,media_id);path=Path(media.path);path.unlink()
                subprocess.run([str(ffmpeg),'-v','error','-n','-f','lavfi','-i',f'color=c={"0x284b66" if index==0 else "0x54776c"}:s=640x360:r=30','-t',str(media.duration),'-c:v','libx264','-pix_fmt','yuv420p',str(path)],check=True,capture_output=True,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
                media.size=path.stat().st_size;session.add(media)
            session.execute(text('UPDATE face SET timestamp=2 WHERE person_id=:p AND timestamp=1'),{'p':data['persons'][1]})
            session.commit()
        if options.get('review_preview'):
            import numpy as np
            from types import SimpleNamespace
            from app.processors.faces import FaceProcessor
            def load_fixture_model(self):self.model=SimpleNamespace(models={})
            def analyze_fixture(self,image):
                vector=np.zeros(512,dtype=np.float32);vector[0]=1
                return [SimpleNamespace(bbox=np.array([80,60,140,120]),embedding=vector,det_score=.99,kps=np.array([[95,80],[125,80],[110,95],[98,110],[122,110]]))]
            FaceProcessor.load_model=load_fixture_model;FaceProcessor._analyze=analyze_fixture
    settings.general.static_dir=Path((root/'preview-dist.txt').read_text('utf8').strip())
    app=importlib.import_module('app.main').app
    @app.middleware('http')
    async def guard(request,call_next):
        allowed_review=request.url.path.startswith('/api/person/review/') and (root/'workbench-preview.json').is_file()
        if request.method not in ('GET','HEAD') and not allowed_review and not (request.method=='POST' and request.url.path.startswith('/api/person/') and (request.url.path.endswith('/merge-multiple') or request.url.path.startswith('/api/person/tools/'))):
            return JSONResponse({'detail':'Read-only fixture'},status_code=403)
        if request.url.path=='/auto-group-status.json':return JSONResponse({'enabled':True,'phase':'ready'})
        if request.url.path=='/resources':return JSONResponse({'mode':'balanced','applied':True,'cpu_percent':50})
        if request.url.path=='/visibility':return JSONResponse({'data_dir':str(settings.general.data_dir),'hidden_sources':[]})
        if request.url.path.startswith('/static/') and request.url.path.endswith('.js'):
            path=(settings.general.static_dir/request.url.path[len('/static/'):]).resolve()
            if path.is_relative_to(settings.general.static_dir.resolve()) and path.is_file():return Response(path.read_text('utf8').replace('http://127.0.0.1:18124',f'http://127.0.0.1:{port}').replace('http://127.0.0.1:18125',f'http://127.0.0.1:{port}'),media_type='application/javascript')
        return await call_next(request)
    with Session(db.engine) as session:
        session.execute(text("UPDATE processingtask SET status='completed' WHERE status IN ('running','pending')"));session.commit()
    (root/'preview-state.json').write_text(json.dumps(data),'utf8')
    uvicorn.run(app,host='127.0.0.1',port=int(port),log_config=None,access_log=False)
