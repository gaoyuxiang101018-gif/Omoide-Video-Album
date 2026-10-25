"""Explicit isolated checks for model ownership and task cleanup."""
import gc
import importlib
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch, PropertyMock
import weakref


def run(root):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    from app.local_workflow_selftest import run as foundation
    nested = root / 'workflow'
    nested.mkdir(exist_ok=True)
    if (root / 'ffmpeg-path.txt').exists():
        (nested / 'ffmpeg-path.txt').write_text((root / 'ffmpeg-path.txt').read_text('utf8'), 'utf8')
    if not foundation(nested):
        (root / 'selftest-result.json').write_text(json.dumps({'success': False, 'error': 'Workflow regression failed'}), 'utf8')
        return False
    from fastapi import HTTPException
    from sqlmodel import Session, select
    import app.database as db
    import app.processor_registry as registry
    import app.model_memory as memory
    import app.clip_onnx as clip
    from app.config import settings
    from app.models import Media, Face, Person, ProcessingTask
    from app.processors.faces import FaceProcessor
    from app.processors.embedding_extractor import EmbeddingExtractor
    from app.processors.auto_tagger import AutoTagger
    from app.tasks import media_processing as processing
    selected = importlib.import_module('app.tasks.selected_processing')
    measurements = {}

    class Payload:
        pass

    class FakeProcessor:
        name = 'faces'
        active = True
        model = None
        handles_empty_scenes = True
        def __init__(self, fail=False): self.fail=fail; self.unloads=0
        def load_model(self):
            self.model=Payload()
            if self.fail: raise RuntimeError('isolated partial load failure')
        def unload(self): self.unloads+=1; self.model=None
        def get_pending_condition(self): return Media.id < 0

    class Checks(unittest.TestCase):
        def setUp(self):
            self.session=Session(db.engine)
            for task in self.session.exec(select(ProcessingTask).where(ProcessingTask.status.in_(['pending','running']))).all():
                task.status='completed'; self.session.add(task)
            self.session.commit()
        def tearDown(self): self.session.close()
        def task(self):
            row=ProcessingTask(task_type='run_processor_for_media')
            self.session.add(row);self.session.commit();self.session.refresh(row)
            return row.id
        def records(self):
            return {model.__name__: [item.model_dump() for item in self.session.exec(select(model).order_by(model.id)).all()] for model in (Media,Face,Person)}

        def test_face_unload_releases_cyclic_model_and_is_idempotent(self):
            processor=FaceProcessor();processor.active=True
            processor.model=Payload();processor.model.cycle=processor.model
            reference=weakref.ref(processor.model)
            processor.unload();processor.unload()
            self.assertIsNone(reference());self.assertIsNone(processor.model)
            self.assertTrue(processor.active)

        def test_all_task_entrypoints_unload_after_success(self):
            for kind in ('global','single','selected'):
                with self.subTest(kind=kind):self.check_task_cleanup(kind,False,False)

        def test_all_task_entrypoints_unload_after_partial_load_failure(self):
            for kind in ('global','single','selected'):
                with self.subTest(kind=kind):self.check_task_cleanup(kind,True,False)

        def test_all_task_entrypoints_unload_on_cancellation(self):
            for kind in ('global','single','selected'):
                with self.subTest(kind=kind):self.check_task_cleanup(kind,False,True)

        def check_task_cleanup(self,kind,fail,cancelled):
            target=FakeProcessor(fail);identifier=self.task()
            checks=iter([False,True,True]) if kind=='selected' and cancelled else None
            with patch.object(processing,'processors',[target]),patch.object(selected,'processors',[target]),patch.object(processing,'_count_media_to_process',return_value=0),patch.object(processing,'_fetch_media_batch_to_process',return_value=[]),patch.object(processing,'_is_task_cancelled',side_effect=(lambda *args:next(checks,True)) if checks else (lambda *args:cancelled)):
                try:
                    if kind=='global':processing._run_media_processing(identifier)
                    elif kind=='single':processing.run_single_processor(identifier,'faces')
                    else:selected.run(identifier,['faces'],[])
                except RuntimeError:
                    if not fail:raise
            self.assertGreater(target.unloads,0);self.assertIsNone(target.model)
            row=self.session.get(ProcessingTask,identifier);row.status='completed';self.session.add(row);self.session.commit()

        def test_pending_and_running_tasks_block_manual_release(self):
            target=FakeProcessor();target.load_model()
            identifier=self.task();before=self.records()
            with patch.object(registry,'processors',[target]):
                for state in ('pending','running'):
                    row=self.session.get(ProcessingTask,identifier);row.status=state;self.session.add(row);self.session.commit()
                    with self.assertRaises(HTTPException) as error:memory.release_idle_models(self.session)
                    self.assertEqual(error.exception.status_code,409)
                    self.assertIsNotNone(target.model);self.assertEqual(target.unloads,0)
            self.assertEqual(before,self.records())

        def test_manual_release_clears_shared_and_processor_models_preserving_registry_and_records(self):
            face=FaceProcessor();face.model=Payload()
            embedding=EmbeddingExtractor();tagger=AutoTagger()
            shared=Payload();embedding._clip=shared;tagger._clip=shared
            face_ref=weakref.ref(face.model);clip_ref=weakref.ref(shared)
            instances=[face,embedding,tagger];before=self.records()
            with patch.object(registry,'processors',instances),patch.object(clip,'_clip_encoder',shared):
                del shared
                report=memory.release_idle_models(self.session)
                self.assertEqual(report['after']['loaded_models'],[])
                self.assertEqual(registry.processors,instances)
                self.assertEqual(len(registry.processors),3)
                self.assertIsNone(clip._clip_encoder)
            gc.collect()
            self.assertIsNone(face_ref());self.assertIsNone(clip_ref())
            self.assertFalse(report['recognition_data_modified'])
            self.assertEqual(before,self.records())

        def test_memory_measurement_has_real_positive_values(self):
            snapshot=memory.process_memory()
            self.assertGreater(snapshot['working_set_bytes'],0)
            self.assertGreater(snapshot['private_bytes'],0)

        def test_new_profile_defaults_are_dense_and_have_no_face_frame_cap(self):
            from app.config.schema import VideoSettings,FaceRecognitionSettings
            video=VideoSettings()
            self.assertFalse(video.auto_scene_detection)
            self.assertEqual(video.max_frames_per_video,1800)
            self.assertEqual(FaceRecognitionSettings().face_detection_max_video_frames,0)

        def test_unicode_bootstrap_keeps_the_selected_profile(self):
            import os
            from app.config.profiles import read_bootstrap,get_os_app_config_dir
            target=root/'bootstrap-encoding';target.mkdir(exist_ok=True)
            expected={'active_profile':'P:\\facephotodata\\我的资料库','profiles':[{'name':'我的资料库','path':'P:\\facephotodata\\我的资料库'}]}
            (target/'bootstrap.yaml').write_text(json.dumps(expected,ensure_ascii=False),'utf8')
            with patch.dict(os.environ,{'OMOIDE_CONFIG_DIR':str(target)}):
                self.assertEqual(get_os_app_config_dir(),target.resolve())
                self.assertEqual(read_bootstrap(),expected)

        def test_dense_sampling_covers_short_and_one_hour_videos(self):
            import app.frames as frames
            from types import SimpleNamespace
            path=root/'dense-fixture.mp4';path.write_bytes(b'sampling fixture')
            with patch.object(settings.video,'auto_scene_detection',False),patch.object(settings.video,'max_frames_per_video',1800):
                for duration,expected in ((52.,27),(3600.,1800)):
                    captured=[]
                    with patch.object(frames,'_extract_frames_at',side_effect=lambda media,timestamps,duration:captured.extend(timestamps) or []),patch.object(frames,'_detect_video_scenes',side_effect=AssertionError('Dense sampling must bypass scene detection')):
                        frames.split_video(SimpleNamespace(path=str(path),duration=duration,id=999),path)
                    self.assertEqual(len(captured),expected)
                    self.assertEqual(captured[:3],[0,2,4])
                    self.assertTrue(all(0<=stamp<duration for stamp in captured))

        def test_dense_face_processor_scans_more_than_fifteen_samples(self):
            import numpy as np
            from app.models import Scene
            media=Media(path=str(root/'dense-face-fixture.mp4'),filename='dense-face-fixture.mp4',size=1,duration=52)
            self.session.add(media);self.session.commit();self.session.refresh(media)
            scenes=[(Scene(media_id=media.id,start_time=index*2,end_time=index*2),np.zeros((16,16,3),dtype=np.uint8)) for index in range(27)]
            processor=FaceProcessor()
            with patch.object(settings.face_recognition,'face_detection_max_video_frames',0),patch.object(processor,'_analyze',return_value=[]) as analyze,patch.object(processor,'_needs_padded_retry',return_value=False):
                processor.process(media,self.session,scenes)
                self.assertEqual(analyze.call_count,27)

        def test_actual_cached_face_model_can_load_unload_and_reload(self):
            marker=root/'models-path.txt'
            if not marker.exists():self.skipTest('Cached-model integration not requested')
            model_dir=Path(marker.read_text('utf8').strip())
            pack=model_dir/'models'/'buffalo_l'
            self.assertTrue((pack/'det_10g.onnx').is_file())
            self.assertTrue((pack/'w600k_r50.onnx').is_file())
            processor=FaceProcessor();references=[]
            from app.config.schema import FaceDetectionModel
            with patch.object(type(settings.general),'models_dir',new_callable=PropertyMock,return_value=model_dir),patch.object(settings.face_recognition,'face_detection_model',FaceDetectionModel.BUFFALO_L):
                for index in range(2):
                    measurements[f'before_{index}']=memory.process_memory()
                    processor.load_model()
                    measurements[f'loaded_{index}']=memory.process_memory()
                    measurements['providers']=processor.model.det_model.session.get_providers()
                    references.append(weakref.ref(processor.model))
                    session_refs=[weakref.ref(model.session) for model in processor.model.models.values()]
                    processor.unload()
                    measurements[f'after_{index}']=memory.process_memory()
                    self.assertIsNone(references[-1]())
                    self.assertTrue(all(reference() is None for reference in session_refs))
                    self.assertLess(measurements[f'after_{index}']['working_set_bytes'],measurements[f'loaded_{index}']['working_set_bytes'])
            measurements['private_media_inference']=False

    stream=io.StringIO()
    result=unittest.TextTestRunner(stream=stream,verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Checks))
    report={'success':result.wasSuccessful(),'tests':result.testsRun,'workflow_tests':12,'foundation_tests':15,'skipped':len(result.skipped),'output':stream.getvalue(),'measurements':measurements,'private_media_modified':False,'private_media_inference':False}
    (root/'selftest-result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),'utf8')
    return result.wasSuccessful()
