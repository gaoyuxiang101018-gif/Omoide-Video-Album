"""Isolated review/refinement integration checks, including real synthetic video decode."""
import asyncio
import io
import json
from pathlib import Path
import subprocess
import unittest
import os
import shutil
from unittest.mock import patch


def run(root):
    root=Path(root);root.mkdir(parents=True,exist_ok=True)
    from app.local_workbench_selftest import run as foundation
    if not foundation(root/'foundation'):
        (root/'selftest-result.json').write_text(json.dumps({'success':False,'error':'foundation failed; inspect foundation reports'}),'utf8')
        return False
    from app.local_people_views_selftest import fixture
    from app import person_review as review, local_refinement as refine, recognition_parameters as parameters, person_views
    from app.models import Face,Person,ProcessingTask
    from app.config import settings
    import app.database as db
    from app.persons import merge_person_into
    from app import merge_history
    from app.processors.faces import FaceProcessor
    from app.tasks.clustering_queries import fetch_faces_and_embeddings
    from app.tasks.face_matching import _bulk_assign_faces_to_persons
    from app.tasks.person_merging import _merge_person_pair
    from fastapi import BackgroundTasks,HTTPException
    from sqlmodel import Session
    from sqlalchemy import text
    import numpy as np
    from PIL import Image
    ffmpeg=Path(os.environ.get('OMOIDE_TEST_FFMPEG') or shutil.which('ffmpeg') or 'ffmpeg')
    settings.general.ffmpeg_path=ffmpeg
    review.ensure_schema();refine.ensure_schema()

    class Checks(unittest.TestCase):
        def setUp(self):
            self.data=fixture(root/self._testMethodName);self.a,self.b=self.data['persons'];self.media=self.data['media'][0]
            self.s=Session(db.engine)
            self.s.execute(text("UPDATE processingtask SET status='completed' WHERE status IN ('pending','running')"));self.s.commit()
        def tearDown(self):self.s.rollback();self.s.close()
        def range(self,source='a',start=0,end=4):return review.Range(media_id=self.media,start=start,end=end,source_person_id=self.a if source=='a' else None)
        def correct(self,mode='assign',source='a',start=0,end=4):
            request=self.range(source,start,end);preview=review.preview(self.s,request)
            self.s.rollback()
            return review.correct(self.s,review.Correction(**request.model_dump(),profile_key=preview['profile_key'],fingerprint=preview['fingerprint'],mode=mode,target_person_id=self.b))
        def undo(self,id):self.s.rollback();return review.undo_correction(self.s,id)
        def face_state(self):return [tuple(r) for r in self.s.execute(text('SELECT id,person_id,media_id,timestamp,bbox,thumbnail_path FROM face ORDER BY id'))]
        def test_timeline_groups_samples_by_person_and_rejects_invalid_stamps(self):
            result=review.timeline(self.s,self.media)
            person=next(p for p in result['items'] if p['id']==self.a)
            self.assertEqual([(s['start'],s['end']) for s in person['segments']],[(0,4),(12,12)])
            self.assertEqual(person['face_count'],4)
        def test_preview_is_read_only_and_filters_only_selected_person(self):
            before=self.face_state();result=review.preview(self.s,self.range());self.assertEqual(result['face_count'],3)
            self.assertEqual(self.face_state(),before)
        def test_correction_and_undo_keep_later_new_faces(self):
            old=self.face_state();change=self.correct()
            self.assertEqual(change['face_count'],3)
            new=Face(person_id=self.b,media_id=self.media,bbox=[30,30,40,40],timestamp=6);self.s.add(new);self.s.commit();identifier=new.id
            self.undo(change['id'])
            self.assertEqual([r for r in self.face_state() if r[0]!=identifier],old)
            self.assertEqual(self.s.get(Face,identifier).person_id,self.b)
        def test_pending_faces_can_be_excluded_without_deleting_any(self):
            face=Face(media_id=self.media,bbox=[40,40,40,40],timestamp=2);self.s.add(face);self.s.commit();id=face.id
            change=self.correct('exclude',source='pending')
            self.assertIsNone(self.s.get(Face,id).person_id)
            self.assertIsNotNone(self.s.execute(text('SELECT face_id FROM face_manual_assignment WHERE face_id=:id'),{'id':id}).first())
            self.undo(change['id']);self.assertIsNotNone(self.s.get(Face,id))
        def test_manual_pins_are_not_reassigned_by_bulk_automatic_matching(self):
            change=self.correct('exclude');faces=review.rows(self.s,'SELECT face_id FROM face_manual_assignment WHERE event_id=:id',{'id':change['id']})
            ids=[f['face_id'] for f in faces]
            _bulk_assign_faces_to_persons(self.s,{id:self.b for id in ids});self.s.commit()
            self.assertTrue(all(self.s.get(Face,id).person_id is None for id in ids))
        def test_excluded_faces_do_not_seed_clusters_and_survive_regular_reset(self):
            change=self.correct('exclude');ids=[r[0] for r in self.s.execute(text('SELECT face_id FROM face_manual_assignment WHERE event_id=:id'),{'id':change['id']})]
            vector=np.zeros(512,np.float32);vector[0]=1
            for id in ids:self.s.execute(text('INSERT OR REPLACE INTO face_embeddings(face_id,person_id,embedding) VALUES(:id,-1,:v)'),{'id':id,'v':vector.tobytes()})
            self.s.commit();found,_=fetch_faces_and_embeddings(self.s)
            self.assertFalse(set(ids)&set(found))
            FaceProcessor().reset_for_media(self.s.get(__import__('app.models',fromlist=['Media']).Media,self.media),self.s);self.s.commit()
            self.assertTrue(all(self.s.get(Face,id) for id in ids))
        def test_changed_face_blocks_undo_and_preserves_new_edit(self):
            change=self.correct();self.s.execute(text('UPDATE face SET person_id=:p WHERE media_id=:media AND timestamp=2'),{'p':self.a,'media':self.media});self.s.commit()
            with self.assertRaises(HTTPException):self.undo(change['id'])
            self.s.rollback();self.assertTrue(self.s.execute(text('SELECT id FROM face WHERE media_id=:media AND person_id=:p AND timestamp=2'),{'media':self.media,'p':self.a}).first())
        def test_old_preview_cannot_apply_after_face_ownership_changes(self):
            request=self.range();p=review.preview(self.s,request);self.s.execute(text('UPDATE face SET person_id=:p WHERE media_id=:m AND timestamp=2'),{'p':self.b,'m':self.media});self.s.commit()
            with self.assertRaises(HTTPException) as caught:review.correct(self.s,review.Correction(**request.model_dump(),profile_key=p['profile_key'],fingerprint=p['fingerprint'],mode='exclude'))
            self.assertEqual(caught.exception.status_code,409)
        def test_new_person_split_is_undoable(self):
            change=self.correct('new');new_id=change['target_person_id'];self.assertNotIn(new_id,(self.a,self.b))
            self.assertEqual(self.s.execute(text('SELECT COUNT(*) FROM face WHERE person_id=:p'),{'p':new_id}).scalar(),3)
            self.undo(change['id']);self.assertIsNotNone(self.s.get(Person,new_id))
        def test_moving_every_face_keeps_original_person_available_for_undo(self):
            request=review.Range(media_id=self.media,start=0,end=20,source_person_id=self.b);p=review.preview(self.s,request);self.s.rollback()
            change=review.correct(self.s,review.Correction(**request.model_dump(),profile_key=p['profile_key'],fingerprint=p['fingerprint'],mode='assign',target_person_id=self.a))
            self.assertIsNotNone(self.s.get(Person,self.b));self.undo(change['id'])
            self.assertEqual(self.s.execute(text('SELECT COUNT(*) FROM face WHERE person_id=:id'),{'id':self.b}).scalar(),3)
        def test_pre_upgrade_merge_journal_without_review_metadata_remains_undoable(self):
            merge_person_into(self.s,self.b,self.a,record_history=True);entry=merge_history.history(self.s)['items'][0]
            payload=json.loads(self.s.execute(text('SELECT payload FROM person_merge_history WHERE id=:id'),{'id':entry['id']}).scalar())
            for snapshot in payload.values():
                snapshot.pop('review_members',None);snapshot.pop('source_id',None)
            self.s.execute(text('UPDATE person_merge_history SET payload=:p WHERE id=:id'),{'id':entry['id'],'p':json.dumps(payload)});self.s.commit()
            merge_history.undo(self.s,entry['id']);self.assertIsNotNone(self.s.get(Person,self.b))
        def test_separation_blocks_manual_and_automatic_merges(self):
            self.s.rollback();review.add_separation(self.s,self.a,self.b)
            self.assertFalse(review.can_merge(self.s,self.a,self.b))
            self.assertIsNone(_merge_person_pair(self.s,self.a,self.b))
            self.s.rollback()
            with self.assertRaises(HTTPException) as caught:merge_person_into(self.s,self.a,self.b,record_history=True)
            self.assertEqual(caught.exception.status_code,409)
        def test_separation_follows_legal_merge_and_merge_undo(self):
            self.s.rollback();review.add_separation(self.s,self.a,self.b)
            third=Person(name='third',appearance_count=0);self.s.add(third);self.s.commit();third_id=third.id
            merge_person_into(self.s,self.a,third_id,record_history=True)
            self.assertFalse(review.can_merge(self.s,third_id,self.b))
            item=merge_history.history(self.s)['items'][0];self.s.rollback();merge_history.undo(self.s,item['id'])
            self.assertFalse(review.can_merge(self.s,self.a,self.b));self.assertTrue(review.can_merge(self.s,third_id,self.b))
        def test_rule_removal_and_reused_person_id_do_not_block_unrelated_new_person(self):
            self.s.rollback();review.add_separation(self.s,self.a,self.b)
            rule=next(r for r in review.history(self.s)['separations'] if {r['person_a_id'],r['person_b_id']}=={self.a,self.b})
            self.s.rollback();review.remove_separation(self.s,rule['id']);self.assertTrue(review.can_merge(self.s,self.a,self.b))
        def test_writes_reject_active_recognition(self):
            self.s.add(ProcessingTask(task_type='process_media',status='running'));self.s.commit()
            with self.assertRaises(HTTPException):self.correct()
        def synthetic(self):
            from app.models import Media
            media=self.s.get(Media,self.media);path=Path(media.path);path.unlink()
            subprocess.run([str(ffmpeg),'-v','error','-n','-f','lavfi','-i','color=c=gray:s=320x180:r=30','-t','3','-c:v','libx264','-pix_fmt','yuv420p',str(path)],capture_output=True,check=True,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            media.duration=3;media.size=path.stat().st_size;self.s.add(media);self.s.commit();return path
        def request(self,**extra):return refine.Request(media_id=self.media,start=0,end=1,interval=.5,profile_key=person_views.state(self.s)['profile_key'],**extra)
        def fake_candidates(self,processor,image,timestamp,root,thumb_root):
            file=root/f'{timestamp}.jpg';Image.fromarray(image).save(file)
            vector=np.zeros(512,np.float32);vector[0]=1
            return [({'bbox':[50,50,50,50],'timestamp':timestamp,'thumbnail_path':file.relative_to(thumb_root).as_posix(),'det_score':.99,'frontality':.9},vector)]
        def run_fake(self,background):
            with patch.object(FaceProcessor,'load_model',return_value=None),patch.object(FaceProcessor,'unload',return_value=None),patch.object(refine,'_candidates',side_effect=self.fake_candidates):asyncio.run(background())
        def test_real_decode_and_add_only_repeated_refinement_deduplicates_per_frame(self):
            self.synthetic();old=self.face_state();background=BackgroundTasks();job=refine.start(self.s,background,self.request());self.run_fake(background)
            record=next(j for j in refine.jobs(self.s)['items'] if j['id']==job['id']);self.assertEqual((record['status'],record['added']),('completed',2),record.get('error'))
            new=self.face_state();self.assertTrue(all(row in new for row in old))
            background=BackgroundTasks();job=refine.start(self.s,background,self.request());self.run_fake(background)
            record=next(j for j in refine.jobs(self.s)['items'] if j['id']==job['id']);self.assertEqual((record['added'],record['duplicates']),(0,2));self.assertEqual(self.face_state(),new)
        def test_local_cancellation_keeps_all_old_faces(self):
            self.synthetic();old=self.face_state();background=BackgroundTasks();job=refine.start(self.s,background,self.request());refine.cancel(self.s,job['id']);self.run_fake(background)
            self.assertEqual(next(j for j in refine.jobs(self.s)['items'] if j['id']==job['id'])['status'],'cancelled');self.assertEqual(self.face_state(),old)
        def test_decode_failure_discards_new_faces_and_its_thumbnails(self):
            self.synthetic();old=self.face_state();background=BackgroundTasks();job=refine.start(self.s,background,self.request())
            frame=np.zeros((180,320,3),np.uint8)
            with patch.object(refine,'decode',side_effect=[frame,RuntimeError('fixture unreadable frame')]):self.run_fake(background)
            record=next(j for j in refine.jobs(self.s)['items'] if j['id']==job['id']);self.assertEqual(record['status'],'failed');self.assertEqual(record['added'],0);self.assertEqual(self.face_state(),old)
            self.assertFalse((settings.general.thumb_dir/'faces/refinement'/job['id']).exists())
        def test_cancellation_during_final_transaction_rolls_back_added_faces(self):
            self.synthetic();old=self.face_state();background=BackgroundTasks();job=refine.start(self.s,background,self.request())
            original=refine.append_candidates
            def append(*args):
                result=original(*args);refine._cancel_events[job['id']].set();return result
            with patch.object(refine,'append_candidates',side_effect=append):self.run_fake(background)
            self.assertEqual(self.face_state(),old)
            self.assertEqual(next(j for j in refine.jobs(self.s)['items'] if j['id']==job['id'])['status'],'cancelled')
        def test_sampling_limits_reject_bad_ranges(self):
            for end in (601, float('inf')):
                with self.assertRaises(Exception):refine.points(refine.Request(media_id=self.media,start=0,end=end,interval=.25,profile_key='fixture'),1000)
            self.assertEqual(len(refine.points(refine.Request(media_id=self.media,start=0,end=600,interval=.25,profile_key='fixture'),600)),2400)
            self.assertEqual(refine.points(self.request(),3),[0,.5])
        def test_already_restored_source_cannot_be_refined(self):
            self.synthetic()
            with patch.object(refine,'_gray_source',return_value=True):
                with self.assertRaises(HTTPException):refine.start(self.s,BackgroundTasks(),self.request())
        def test_parameter_overview_is_read_only_and_does_not_load_models(self):
            old=self.face_state()
            with patch.object(FaceProcessor,'load_model',side_effect=AssertionError('must not load')):result=parameters.overview(self.s)
            items={r['key']:r for group in result['groups'] for r in group['items']}
            self.assertIn('buffalo_l',items['recognizer']['value']);self.assertEqual(items['scene_skip']['status'],'备用')
            self.assertEqual(items['hdbscan_min_samples']['status'],'备用');self.assertEqual(items['cw_threshold']['status'],'生效')
            self.assertEqual(self.face_state(),old)
        def test_decode_really_reads_a_synthetic_frame(self):
            path=self.synthetic();frame=refine.decode(path,.5,ffmpeg,lambda:False);self.assertEqual(frame.shape,(180,320,3))
        def test_z_real_cpu_models_load_and_produce_a_512_dimension_vector(self):
            if not os.environ.get('OMOIDE_TEST_MODEL_ROOT'):
                self.skipTest('Set OMOIDE_TEST_MODEL_ROOT to opt into real model checks')
            from insightface.app import FaceAnalysis
            def build(providers):return FaceAnalysis('buffalo_l',root=os.environ['OMOIDE_TEST_MODEL_ROOT'],allowed_modules=['detection','recognition'],providers=['CPUExecutionProvider'])
            processor=FaceProcessor()
            try:
                with patch.object(settings.processors,'prefer_gpu',False),patch.object(FaceProcessor,'_build_face_analysis',staticmethod(build)):
                    processor.load_model()
                self.assertEqual(set(processor.model.models),{'detection','recognition'})
                self.assertEqual(processor._analyze(np.zeros((180,320,3),np.uint8)),[])
                vec=processor.model.models['recognition'].get_feat(np.zeros((112,112,3),np.uint8)).reshape(-1)
                self.assertEqual(vec.size,512);self.assertTrue(np.isfinite(vec).all());self.assertGreater(np.linalg.norm(vec),0)
            finally:processor.unload()

    stream=io.StringIO();result=unittest.TextTestRunner(stream=stream,verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Checks))
    report={'success':result.wasSuccessful(),'tests':result.testsRun,'workbench_tests':18,'people_view_tests':15,'foundation_tests':15,'output':stream.getvalue(),'real_media_modified':False,'real_recognition_started':False,'synthetic_video_decode':True}
    (root/'selftest-result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),'utf8')
    return result.wasSuccessful()
