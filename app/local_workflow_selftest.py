"""Explicit, isolated release checks; background callbacks are never executed."""
import asyncio
import io
import importlib
import json
from pathlib import Path
import subprocess
import threading
import unittest
from unittest.mock import patch


def run(root):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    from app.local_restored_selftest import run as foundation
    if not foundation(root/'foundation'): return False
    from fastapi import BackgroundTasks, HTTPException
    from sqlmodel import Session, select
    import app.database as db
    import app.frames as frames
    api = importlib.import_module('app.api.tasks')
    from app.config import settings
    from app.models import Media, ProcessingTask
    from app.tasks import progress_journal as journal
    try:
        from app.tasks import recognition_activity as activity
    except ImportError:
        activity = None
    import numpy as np

    class Checks(unittest.TestCase):
        def setUp(self):
            self.session = Session(db.engine)
            for task in self.session.exec(select(ProcessingTask).where(ProcessingTask.status.in_(['pending','running']))).all():
                task.status = 'completed'; self.session.add(task)
            self.session.commit()
            self.background = BackgroundTasks()

        def tearDown(self): self.session.close()

        def media(self, name='a', path=None):
            path = Path(path) if path else root/self._testMethodName/(name+'.mp4')
            path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(b'isolated-fixture')
            item = Media(path=str(path), filename=path.name, size=16, duration=10)
            self.session.add(item); self.session.commit(); self.session.refresh(item)
            return item

        def submit(self, identifiers, names=None):
            body = api.RunProcessorsForMediaRequest(media_ids=identifiers, processor_names=names or ['faces'])
            return asyncio.run(api.start_processors_for_media(body, self.background, self.session))

        def test_pending_request_is_reserved_before_background_starts(self):
            media = self.media()
            first = self.submit([media.id, media.id])
            self.assertEqual(journal.read(first.id).get('selected_media_ids'), [media.id])
            with self.assertRaises(HTTPException) as error: self.submit([media.id])
            self.assertEqual(error.exception.status_code, 409)
            self.assertEqual(len(self.background.tasks), 1)
            self.assertFalse(self.session.get(Media, media.id).faces_extracted)

        def test_other_videos_get_their_own_job_and_do_not_overwrite_running_selection(self):
            one, two = self.media('one'), self.media('two')
            first = self.submit([one.id]); first.status='running'; self.session.add(first); self.session.commit()
            second = self.submit([two.id])
            self.assertNotEqual(first.id, second.id)
            self.assertEqual(journal.read(first.id).get('selected_media_ids'), [one.id])
            self.assertEqual(journal.read(second.id).get('selected_media_ids'), [two.id])
            self.assertEqual(len(self.background.tasks), 2)

        def test_alias_duplicate_cannot_be_queued_again(self):
            self.assertIsNotNone(activity)
            mapped, actual = root/'mapped', root/'actual'
            first, same = self.media(path=mapped/'a.mp4'), self.media(path=actual/'a.mp4')
            with patch.object(activity, 'media_path_aliases', return_value=[{'path':str(mapped),'resolved_path':str(actual)}]):
                self.submit([first.id])
                with self.assertRaises(HTTPException) as error: self.submit([same.id])
            self.assertEqual(error.exception.status_code, 409)

        def test_progress_distinguishes_completed_running_failed_and_queued(self):
            self.assertIsNotNone(activity)
            media = [self.media(str(index)) for index in range(4)]
            task = self.submit([item.id for item in media]); task.status='running'; self.session.add(task); self.session.commit()
            for item, status in zip(media, ['completed','running','failed']):
                journal.item(task.id,item.id,'faces',item.path,status)
            found = {row['media_id']:row['state'] for row in activity.collect_activity(self.session)['items']}
            self.assertEqual([found[item.id] for item in media], ['completed','running','failed','queued'])

        def test_unrelated_processor_does_not_reserve_face_work(self):
            self.assertIsNotNone(activity)
            media = self.media()
            first = self.submit([media.id], ['exif']); first.status='running'; self.session.add(first); self.session.commit()
            self.assertEqual(activity.collect_activity(self.session)['items'], [])
            second = self.submit([media.id])
            self.assertNotEqual(first.id, second.id)
            self.assertEqual(journal.read(first.id).get('processor_names'), ['exif'])

        def test_global_and_selected_face_jobs_cannot_overlap(self):
            media = self.media()
            self.submit([media.id])
            with self.assertRaises(HTTPException) as error:
                asyncio.run(api.start_media_processing(self.background,self.session))
            self.assertEqual(error.exception.status_code,409)
            for task in self.session.exec(select(ProcessingTask).where(ProcessingTask.status=='pending')).all():
                task.status='completed';self.session.add(task)
            self.session.commit()
            asyncio.run(api.start_media_processing(self.background,self.session))
            with self.assertRaises(HTTPException): self.submit([media.id])

        def test_finished_job_releases_reservation(self):
            media = self.media(); first = self.submit([media.id])
            first.status='completed';self.session.add(first);self.session.commit()
            second = self.submit([media.id])
            self.assertNotEqual(first.id,second.id)

        def test_empty_or_invalid_selection_does_not_create_a_job(self):
            for identifiers in ([], [0], [-1]):
                with self.assertRaises(HTTPException) as error: self.submit(identifiers)
                self.assertEqual(error.exception.status_code,422)
            self.assertEqual(self.background.tasks,[])

        def test_frame_batch_bounds_codec_threads_and_scales_before_encoding(self):
            captured=[]
            def execute(cmd, **kwargs):
                captured.append(cmd);return subprocess.CompletedProcess(cmd,0,b'',b'')
            with patch.object(frames,'run_silent',side_effect=execute):
                frames._extract_frames_batch(Path('ffmpeg'),Path('fixture.mp4'),[0,1,2,3],[0.,.2,.4,.6])
            command=captured[0]
            for index,token in enumerate(command):
                if token=='-i':
                    self.assertIn('-threads:v',command[max(0,index-6):index])
            self.assertEqual(command.count('-vf'),4)
            self.assertEqual(command.count('-threads:v'),8)
            self.assertEqual(command[command.index('-filter_threads')+1],'1')

        def test_long_video_keeps_sample_cap_and_never_seeks_exact_eof(self):
            media=self.media(); media.duration=3600
            captured=[]
            with patch.object(settings.video,'max_frames_per_video',1800),patch.object(frames,'_extract_frames_at',side_effect=lambda media, timestamps, duration:captured.extend(timestamps) or []):
                frames._split_by_frames(media)
            self.assertEqual(len(captured),1800)
            self.assertEqual(captured[0],0)
            self.assertTrue(all(0 <= stamp < 3600 for stamp in captured))
            self.assertGreater(captured[-1],3599)

        def test_completed_batches_are_consumed_before_slow_batch_finishes(self):
            media=self.media(); consumed=threading.Event(); blocked=[]
            pixel=np.zeros((4,4,3),dtype=np.uint8)
            def batch(binary,path,indices,timestamps):
                if indices[0]==0 and not consumed.wait(2): blocked.append(True)
                return {index:pixel for index in indices}
            def convert(image,index,timestamps,duration,media_id):
                if index:consumed.set()
                return timestamps[index],timestamps[index]+1,pixel,settings.general.thumb_dir/'fixture.jpg'
            with patch.object(frames,'ensure_ffmpeg_available',return_value=Path('ffmpeg')),patch.object(frames,'_extract_frames_batch',side_effect=batch),patch.object(frames,'_frame_result',side_effect=convert):
                scenes=frames._extract_frames_at(media,[float(index) for index in range(12)],12)
            self.assertEqual(blocked,[])
            self.assertEqual([scene.start_time for scene,_ in scenes],list(range(12)))

        def test_4k_10bit_video_produces_all_requested_frames_with_bounded_size(self):
            marker=root/'ffmpeg-path.txt'
            if not marker.exists(): self.skipTest('FFmpeg integration fixture not requested')
            binary=Path(marker.read_text('utf8').strip())
            video=root/'synthetic-4k-10bit.mkv'
            command=[str(binary),'-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=3840x2160:rate=5','-t','1.2','-vf','format=yuv420p10le','-c:v','libx265','-preset','ultrafast','-threads:v','1','-x265-params','pools=1:frame-threads=1:log-level=error','-y',str(video)]
            result=frames.run_silent(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=90)
            self.assertEqual(result.returncode,0,result.stderr.decode(errors='replace')[-1000:])
            images=frames._extract_frames_batch(binary,video,[0,1,2,3],[0.,.2,.4,.6])
            self.assertEqual(set(images),{0,1,2,3})
            for image in images.values():self.assertEqual(image.shape,(720,1280,3))

    stream=io.StringIO()
    result=unittest.TextTestRunner(stream=stream,verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Checks))
    report={'success':result.wasSuccessful(),'tests':result.testsRun,'foundation_tests':15,'skipped':len(result.skipped),'output':stream.getvalue(),'real_face_inference_started':False,'private_media_modified':False}
    (root/'selftest-result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),'utf8')
    return result.wasSuccessful()


def serve_preview(root, port):
    """Read-only UI fixture using the packaged activity endpoint and built UI."""
    root=Path(root); root.mkdir(parents=True,exist_ok=True)
    from app.local_restored_selftest import run as foundation
    assert foundation(root/'foundation')
    from fastapi import FastAPI, Request
    from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
    from PIL import Image
    from sqlmodel import Session, select
    import app.database as db
    from app.config import settings
    from app.config.schema import MediaDirectory
    from app.models import Media, ProcessingTask
    from app.tasks import progress_journal as journal
    import uvicorn
    router=importlib.import_module('app.api.tasks').router
    folder=root/'示例素材'; output=root/'还原'; folder.mkdir(); output.mkdir()
    settings.general.media_dirs=[MediaDirectory(path=folder,read_only=True)]
    thumb=settings.general.thumb_dir/'workflow-preview.png';thumb.parent.mkdir(parents=True,exist_ok=True)
    Image.new('RGB',(640,360),(83,119,151)).save(thumb)
    names=[(folder,'原灰片.mp4'),(output,'还原成片甲.mp4'),(output,'还原成片乙.mp4'),(folder,'普通视频.mp4'),(output,'还原成片丙.mp4')]
    with Session(db.engine) as session:
        for task in session.exec(select(ProcessingTask).where(ProcessingTask.status.in_(['running','pending']))).all():
            task.status='completed';session.add(task)
        media=[]
        for directory,name in names:
            path=directory/name;path.write_bytes(b'ui-fixture')
            item=Media(path=str(path),filename=name,size=10,duration=30,width=1920,height=1080,thumbnail_path=thumb.name)
            session.add(item);session.flush();media.append(item)
        task=ProcessingTask(task_type='run_processor_for_media',status='running',total=2,processed=0)
        session.add(task);session.commit();session.refresh(task)
        for item in media:session.refresh(item)
        journal.update(task.id,force=True,selected_media_ids=[media[1].id,media[2].id],processor_names=['faces'],current_item=media[1].path,current_step='faces')
        journal.item(task.id,media[1].id,'faces',media[1].path,'running')
        rows=[item.model_dump(mode='json') for item in media]
        identifiers=[item.id for item in media]
    links=[{'media_id':rows[index]['id'],'source_path':rows[0]['path'],'output_path':rows[index]['path'],'valid':True,'mode':'hlg'} for index in (1,2,4)]
    profile=str(settings.general.data_dir)
    dist=Path((root/'preview-dist.txt').read_text('utf8').strip())
    app=FastAPI()
    @app.middleware('http')
    async def read_only(request:Request,call_next):
        if request.method!='GET':return JSONResponse({'detail':'Read-only test fixture'},status_code=403)
        return await call_next(request)
    app.include_router(router,prefix='/api/tasks')
    @app.get('/api/config/')
    def configuration():return settings.model_dump(mode='json')
    @app.get('/api/config/path-aliases')
    def aliases():return []
    @app.get('/api/media/videos')
    def videos():return {'items':rows,'next_cursor':None}
    @app.get('/api/nopersons')
    def states():return {'items':[{'id':identifier,'faces_extracted':False} for identifier in identifiers],'next_cursor':None}
    @app.get('/api/media/restored-links')
    def associations():return {'data_dir':profile,'items':links}
    @app.get('/visibility')
    def visibility():return {'data_dir':profile,'profile':'fixture','hidden_sources':[rows[0]['path']]}
    @app.get('/auto-group-status.json')
    def grouping():return {'enabled':False,'phase':'disabled'}
    @app.get('/resources')
    def resources():return {'mode':'balanced','applied':True,'cpu_percent':50}
    @app.get('/thumbnails/{path:path}')
    def thumbnail(path:str):return FileResponse(thumb)
    @app.get('/static/{path:path}')
    def static(path:str):
        file=(dist/path).resolve()
        if not file.is_relative_to(dist.resolve()) or not file.is_file():return Response(status_code=404)
        if file.suffix=='.js':
            text=file.read_text('utf8').replace('http://127.0.0.1:18125',f'http://127.0.0.1:{port}').replace('http://127.0.0.1:18124',f'http://127.0.0.1:{port}')
            return Response(text,media_type='application/javascript')
        return FileResponse(file)
    @app.get('/api/{path:path}')
    def other(path:str):return []
    @app.get('/{path:path}')
    def index(path:str):
        flags={'VITE_API_ENABLE_PEOPLE':'true','VITE_API_PRESENTATION_MODE':'false','APP_VERSION':'0.7.5-test'}
        return HTMLResponse((dist/'index.html').read_text('utf8').replace('</head>',f'<script>window.runtimeConfig={json.dumps(flags)}</script></head>'))
    (root/'preview-state.json').write_text(json.dumps({'ids':identifiers,'task_id':task.id}),'utf8')
    uvicorn.run(app,host='127.0.0.1',port=int(port),log_config=None,access_log=False)
