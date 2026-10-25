"""Offline release checks, invoked explicitly before the GUI entry point."""
import io
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

def run(root):
    root = Path(root)
    profile = root/'profile'; profile.mkdir(parents=True,exist_ok=True)
    appdata = root/'appdata'; (appdata/'omoide').mkdir(parents=True,exist_ok=True)
    os.environ['APPDATA'] = str(appdata)
    os.environ['OMOIDE_CONFIG_DIR'] = str(appdata/'omoide')
    (appdata/'omoide/bootstrap.yaml').write_text(json.dumps({'active_profile':str(profile),'profiles':[{'name':'Progress tests','path':str(profile)}]}),'utf8')
    (profile/'config.yaml').write_text(json.dumps({'general':{'data_dir':str(profile),'media_dirs':[]},'scan':{'auto_scan':False,'auto_cluster_on_scan':False},'tagging':{'auto_tagging':False}}),'utf8')
    from sqlmodel import Session,SQLModel,select
    import app.database as database
    from app.models import ProcessingTask,Media,Face
    from app.tasks import media_processing as processing
    from app.tasks import state
    SQLModel.metadata.create_all(database.engine)
    from sqlalchemy.orm import configure_mappers
    configure_mappers()

    class FakeProcessor:
        name='faces'; active=False; handles_empty_scenes=True
        def load_model(self): pass
        def unload(self): pass
        def reset_for_media(self,media,session): media.faces_extracted=False
        def process(self,media,session,scenes):
            media.faces_extracted=True; session.add(media)
            return True

    class Checks(unittest.TestCase):
        def test_scan_recognizes_existing_file_through_mount_alias(self):
            from app.config.schema import MediaDirectory
            from app.tasks import scan
            actual=root/'scan_actual';actual.mkdir(exist_ok=True)
            mapped=root/'scan_mapped'
            (actual/'already.mp4').write_bytes(b'offline fixture')
            with Session(database.engine) as session:
                existing=Media(path=str(mapped/'already.mp4'),filename='already.mp4',size=15,duration=1,faces_extracted=True)
                task=ProcessingTask(task_type='scan')
                session.add(existing);session.add(task);session.commit();session.refresh(task)
                identifier=task.id
            original_resolve=Path.resolve
            def resolve(path,*args,**kwargs):
                return actual if path==mapped else original_resolve(path,*args,**kwargs)
            with patch.object(scan.settings.general,'media_dirs',[MediaDirectory(path=mapped)]),patch.object(Path,'resolve',resolve),patch.object(scan,'process_file',return_value=(None,None,'must not reparse')) as process:
                scan.run_scan(identifier)
                self.assertEqual(process.call_count,0,'mapped record must block duplicate scan of resolved path')
            with Session(database.engine) as session:
                self.assertEqual(session.get(ProcessingTask,identifier).total,0)
                self.assertTrue(session.exec(select(Media).where(Media.path==str(mapped/'already.mp4'))).one().faces_extracted)

        def test_path_alias_api_and_directory_boundary(self):
            from app.media_paths import canonical_path_key
            import asyncio
            from app.api.config import get_media_path_aliases
            self.assertIsInstance(asyncio.run(get_media_path_aliases()),list)
            aliases=[{'path':str(root/'mount'),'resolved_path':str(root/'network')}]
            self.assertEqual(canonical_path_key(root/'mount'/'video.mp4',aliases),canonical_path_key(root/'network'/'video.mp4',aliases))
            self.assertNotEqual(canonical_path_key(root/'mount2'/'video.mp4',aliases),canonical_path_key(root/'network'/'video.mp4',aliases))

        def test_scan_still_imports_new_file_beside_old_alias(self):
            from app.config.schema import MediaDirectory
            from app.tasks import scan
            actual=root/'new_scan_actual';actual.mkdir(exist_ok=True)
            mapped=root/'new_scan_mapped'
            for name in ('old.mp4','new.mp4'):(actual/name).write_bytes(b'fixture')
            with Session(database.engine) as session:
                session.add(Media(path=str(mapped/'old.mp4'),filename='old.mp4',size=7,duration=1))
                task=ProcessingTask(task_type='scan');session.add(task);session.commit();session.refresh(task);identifier=task.id
            original_resolve=Path.resolve
            def resolve(path,*args,**kwargs):return actual if path==mapped else original_resolve(path,*args,**kwargs)
            def parse(path):return Media(path=str(path),filename=path.name,size=7,duration=1),None,None
            with patch.object(scan.settings.general,'media_dirs',[MediaDirectory(path=mapped)]),patch.object(Path,'resolve',resolve),patch.object(scan,'process_file',side_effect=parse) as process,patch.object(scan,'generate_thumbnail',return_value=('fixture.jpg',None)):
                scan.run_scan(identifier)
                self.assertEqual(process.call_count,1)
                self.assertEqual(process.call_args.args[0].name,'new.mp4')
            with Session(database.engine) as session:
                task=session.get(ProcessingTask,identifier)
                self.assertEqual((task.status,task.total,task.processed),('completed',1,1))

        def task(self):
            with Session(database.engine) as session:
                task=ProcessingTask(task_type='run_processor_for_media')
                session.add(task);session.commit();session.refresh(task);return task.id
        def test_network_error_does_not_abort_following_video(self):
            identifiers=[]
            with Session(database.engine) as session:
                for name in ('offline.mp4','readable.mp4'):
                    path=root/name;path.write_bytes(b'not actual face material')
                    media=Media(path=str(path),filename=name,size=12,duration=1,faces_extracted=False,extracted_scenes=True)
                    session.add(media);session.commit();session.refresh(media);identifiers.append(media.id)
                preserved=Face(media_id=identifiers[0],bbox=[0,0,2,2],timestamp=0)
                session.add(preserved);session.commit()
            identifier=self.task();old_stat=Path.stat
            def stat(path,*args,**kwargs):
                if path.name=='offline.mp4':raise OSError(433,'device unavailable')
                return old_stat(path,*args,**kwargs)
            with patch.object(processing,'processors',[FakeProcessor()]),patch.object(Path,'stat',stat):
                # The selected implementation obtains the same registry list.
                import app.processor_registry as registry
                with patch.object(registry,'processors',processing.processors):
                    try:
                        import app.tasks.selected_processing as selected
                        with patch.object(selected,'processors',processing.processors),patch.object(processing,'_needs_scene_extraction',lambda media:False):
                            processing.run_processors_for_media(identifier,['faces'],identifiers)
                    except ModuleNotFoundError:
                        processing.run_processors_for_media(identifier,['faces'],identifiers)
            with Session(database.engine) as session:
                task=session.get(ProcessingTask,identifier)
                self.assertEqual(str(task.status),'completed');self.assertEqual(task.processed,2)
                self.assertTrue(session.get(Media,identifiers[1]).faces_extracted)
                self.assertFalse(session.get(Media,identifiers[0]).faces_extracted)
                self.assertEqual(len(session.exec(select(Face).where(Face.media_id==identifiers[0])).all()),1)
        def test_progress_and_failures_survive_transient_state_clear(self):
            from app.tasks import progress_journal as journal
            identifier=self.task()
            state.set_task_progress(identifier,current_item='readable.mp4',current_step='faces',frame_current=2,frame_total=15,video_second=6.0,video_duration=60)
            state.clear_task_progress(identifier)
            self.assertEqual(journal.read(identifier)['frame_current'],2)
            state.record_task_failure(identifier,'offline.mp4','network unavailable')
            state.clear_task_progress(identifier);state._task_failures.pop(identifier,None)
            saved=journal.read(identifier)
            self.assertEqual(saved['last_error'],'network unavailable')
        def test_history_contains_terminal_and_pending_tasks(self):
            from app.api.tasks import task_history,list_active_tasks
            identifier=self.task()
            with Session(database.engine) as session:
                finished=ProcessingTask(task_type='run_processor_for_media',status='completed',processed=2,total=2)
                session.add(finished);session.commit()
                rows=task_history(200,session)['items']
                self.assertTrue(any(row['id']==identifier for row in rows))
                self.assertTrue(any(row['id']==identifier for row in [item.model_dump() for item in list_active_tasks(session)]))
                self.assertTrue(any(str(row['status'])=='completed' for row in rows))
        def test_frame_fields_are_exposed_by_api_schema(self):
            from app.models import ProcessingTaskRead
            identifier=self.task()
            with Session(database.engine) as session:base=session.get(ProcessingTask,identifier).model_dump()
            row=ProcessingTaskRead(**base,frame_current=3,frame_total=15,video_second=12)
            self.assertEqual(row.model_dump()['frame_current'],3)
        def test_face_processor_publishes_real_sample_time_without_model(self):
            import numpy as np
            from app.processors.faces import FaceProcessor
            from app.models import Scene
            from app.tasks import progress_journal as journal
            identifier=self.task()
            with Session(database.engine) as session:
                media=Media(path=str(root/'frame-only.mp4'),filename='frame-only.mp4',size=1,duration=60,faces_extracted=False)
                session.add(media);session.commit();session.refresh(media)
                scene=Scene(media_id=media.id,start_time=6,end_time=6)
                state.set_task_progress(identifier,current_item=media.path,current_step='faces')
                processor=FaceProcessor()
                with patch.object(processor,'_analyze',return_value=[]),patch.object(processor,'_needs_padded_retry',return_value=False):
                    processor.process(media,session,[(scene,np.zeros((16,16,3),dtype=np.uint8))])
                # The frame update may be throttled behind the phase change; flush explicitly for this assertion.
                journal.update(identifier,force=True,**state.get_task_progress()[identifier])
                self.assertEqual(journal.read(identifier)['video_second'],6)
                self.assertEqual(journal.read(identifier)['frame_total'],1)
        def test_new_item_does_not_reuse_previous_frame_timestamp(self):
            from app.tasks import progress_journal as journal
            identifier=self.task()
            state.set_task_progress(identifier,current_item='a.mp4',current_step='faces',frame_current=10,video_second=50)
            state.set_task_progress(identifier,current_item='b.mp4',current_step='extracting_scenes')
            self.assertNotIn('video_second',journal.read(identifier))

    stream=io.StringIO();result=unittest.TextTestRunner(stream=stream,verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Checks))
    report={'success':result.wasSuccessful(),'tests':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),'output':stream.getvalue(),'real_face_inference_started':False,'profile':str(profile)}
    (root/'selftest-result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),'utf8')
    return result.wasSuccessful()

def serve_preview(root,port):
    """Read-only browser verification server using the real packaged task APIs."""
    assert run(root)
    import sys
    from datetime import datetime,timezone
    from sqlmodel import Session
    from fastapi import FastAPI,Request
    from fastapi.responses import HTMLResponse,JSONResponse
    from fastapi.staticfiles import StaticFiles
    import uvicorn
    import app.database as database
    from app.config import settings
    from app.models import ProcessingTask
    from app.api.tasks import router
    from app.tasks import progress_journal as journal
    root=Path(root)
    with Session(database.engine) as session:
        running=ProcessingTask(task_type='run_processor_for_media',status='running',total=7,processed=3,started_at=datetime.now(timezone.utc))
        failed=ProcessingTask(task_type='run_processor_for_media',status='failed',total=71,processed=35)
        session.add(running);session.add(failed);session.commit();session.refresh(running);session.refresh(failed)
        ids={'running':running.id,'failed':failed.id}
    journal.update(ids['running'],force=True,current_item='Y:/示例视频/正在识别的运动会视频.mp4',current_step='faces',frame_current=4,frame_total=15,video_second=12,video_duration=60)
    journal.update(ids['failed'],force=True,fatal_error='OSError: [WinError 433] 网络设备暂不可用，剩余项目没有处理。')
    journal.item(ids['failed'],1,'faces','Y:/示例视频/暂不可读的视频.mp4','failed','网络盘暂不可用，请恢复连接后再选择未完成视频。')
    (root/'preview-state.json').write_text(json.dumps(ids),'utf8')
    app=FastAPI()
    @app.middleware('http')
    async def read_only(request:Request,call_next):
        if request.method!='GET':return JSONResponse({'error':'Read-only verification server'},status_code=403)
        return await call_next(request)
    app.include_router(router,prefix='/api/tasks')
    @app.get('/api/config/')
    def config():return settings.model_dump(mode='json')
    @app.get('/api/config/path-aliases')
    def aliases():return []
    @app.get('/api/media/videos')
    @app.get('/api/nopersons')
    def empty_media():return {'items':[],'next_cursor':None}
    dist=Path(sys.executable).parent/'_internal/dist'
    app.mount('/static',StaticFiles(directory=dist),name='static')
    @app.get('/auto-group-status.json')
    def companion():return {'enabled':False,'phase':'disabled','updated_at':0}
    @app.get('/{path:path}')
    def index(path:str):
        html=(dist/'index.html').read_text('utf8')
        config={'VITE_API_ENABLE_PEOPLE':'true','VITE_API_PRESENTATION_MODE':'false','APP_VERSION':'0.7.5-local'}
        return HTMLResponse(html.replace('</head>',f'<script>window.runtimeConfig={json.dumps(config)}</script></head>'))
    uvicorn.run(app,host='127.0.0.1',port=int(port),log_config=None,access_log=False)
