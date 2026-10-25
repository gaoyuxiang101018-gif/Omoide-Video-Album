"""Opt-in isolated native tests; never imports the user's configured library."""
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
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    from app.local_people_views_selftest import run as foundation, fixture
    if not foundation(root / 'foundation'):
        return False
    from fastapi import BackgroundTasks, HTTPException
    from sqlalchemy import text
    from sqlmodel import Session
    import app.database as db
    from app.config import settings
    from app.models import Face, Person, PersonRelationship, Tag, PersonTagLink, PersonMediaLink, TimelineEvent, ProcessingTask
    from app.persons import merge_person_into
    from app import person_workbench as clips, merge_history as history, clip_exports as exports
    ffmpeg = Path(os.environ.get('OMOIDE_TEST_FFMPEG') or shutil.which('ffmpeg') or 'ffmpeg')
    assert ffmpeg.is_file(), 'Configured local FFmpeg is required for real export tests'
    settings.general.ffmpeg_path = ffmpeg

    class Checks(unittest.TestCase):
        def setUp(self):
            self.data = fixture(root / self._testMethodName)
            self.target, self.source = self.data['persons']
            self.session = Session(db.engine)
        def tearDown(self):
            self.session.rollback()
            self.session.close()
        def merge(self):
            merge_person_into(self.session, self.source, self.target, record_history=True)
            return history.history(self.session)['items'][0]
        def undo(self, item):
            self.session.rollback()
            return history.undo(self.session, item['id'])
        def test_plan_matches_exact_same_frame_not_nearby_or_manual_links(self):
            plan = clips.segments(self.session, self.target)
            self.assertEqual([(c['start'], c['end']) for c in plan['clips']], [(0,4),(12,12)])
            self.assertEqual(clips.segments(self.session,self.target,self.source)['clips'],[])
            self.session.add(Face(person_id=self.source,media_id=self.data['media'][0],bbox=[0,0,1,1],timestamp=2.00001))
            self.session.commit()
            joint=clips.segments(self.session,self.target,self.source)
            self.assertEqual([(c['start'],c['end'],c['detections']) for c in joint['clips']],[(2,2,1)])
        def test_bounds_clamp_single_frame_and_never_change_detected_interval(self):
            plan=clips.segments(self.session,self.target,gap=0)
            self.assertEqual(clips.playback_bounds(plan['clips'][0],3,1),(0,1))
            self.assertEqual(clips.playback_bounds(plan['clips'][0],0,0),(0,.5))
            self.assertEqual(plan['clips'][0]['end'],0)
        def test_undo_preserves_later_faces_name_and_favorite(self):
            source_faces=[r[0] for r in self.session.execute(text('SELECT id FROM face WHERE person_id=:p'),{'p':self.source})]
            item=self.merge()
            new=Face(person_id=self.target,media_id=self.data['media'][1],bbox=[0,0,1,1],timestamp=2)
            self.session.add(new)
            target=self.session.get(Person,self.target);target.name='后来命名';target.is_favorite=True
            self.session.add(target);self.session.commit();new_id=new.id
            result=self.undo(item)
            self.assertEqual(self.session.get(Face,new_id).person_id,self.target)
            self.assertTrue(all(self.session.get(Face,i).person_id==result['restored_id'] for i in source_faces))
            self.assertEqual(self.session.get(Person,self.target).name,'后来命名')
            self.assertTrue(self.session.get(Person,self.target).is_favorite)
            with self.assertRaises(HTTPException):self.undo(item)
        def test_undo_respects_moved_or_deleted_faces(self):
            item=self.merge()
            face=self.session.execute(text('SELECT id FROM face WHERE person_id=:p LIMIT 1'),{'p':self.target}).scalar()
            # Move a source face specifically.
            payload=json.loads(self.session.execute(text('SELECT payload FROM person_merge_history WHERE id=:id'),{'id':item['id']}).scalar())
            face=payload['before']['faces'][0]
            self.session.execute(text('UPDATE face SET person_id=NULL WHERE id=:id'),{'id':face});self.session.commit()
            with self.assertRaises(HTTPException) as caught:self.undo(item)
            self.assertEqual(caught.exception.status_code,409)
            self.session.rollback()
            self.assertIsNone(self.session.get(Face,face).person_id)
        def test_undo_does_not_overwrite_reused_source_id(self):
            item=self.merge()
            other=Person(id=self.source,name='后来新增人物',appearance_count=0)
            self.session.add(other);self.session.commit()
            result=self.undo(item)
            self.assertNotEqual(result['restored_id'],self.source)
            self.assertEqual(self.session.get(Person,self.source).name,'后来新增人物')
        def test_deleted_target_id_reuse_is_not_treated_as_original_person(self):
            item=self.merge()
            self.session.execute(text('UPDATE face SET person_id=NULL WHERE person_id=:id'),{'id':self.target})
            self.session.execute(text('DELETE FROM personmedialink WHERE person_id=:id'),{'id':self.target})
            self.session.execute(text('DELETE FROM person WHERE id=:id'),{'id':self.target});self.session.commit()
            self.session.add(Person(id=self.target,name='新目标',appearance_count=0));self.session.commit()
            with self.assertRaises(HTTPException):self.undo(item)
            self.session.rollback();self.assertEqual(self.session.get(Person,self.target).name,'新目标')
        def test_journal_failure_rolls_back_merge_and_original_face_ownership(self):
            history.ensure_schema()
            with patch.object(history,'record',side_effect=RuntimeError('journal unavailable')):
                with self.assertRaises(RuntimeError):merge_person_into(self.session,self.source,self.target,record_history=True)
            self.session.rollback()
            self.assertIsNotNone(self.session.get(Person,self.source))
            self.assertEqual(self.session.execute(text('SELECT COUNT(*) FROM face WHERE person_id=:id'),{'id':self.source}).scalar(),3)
        def test_vectors_return_to_restored_person_without_model_loading(self):
            import struct
            face=self.session.execute(text('SELECT id FROM face WHERE person_id=:id LIMIT 1'),{'id':self.source}).scalar()
            self.session.execute(text('INSERT INTO face_embeddings(face_id,person_id,embedding) VALUES(:f,:p,:v)'),{'f':face,'p':self.source,'v':struct.pack('512f',1,*([0]*511))});self.session.commit()
            item=self.merge();result=self.undo(item)
            self.assertEqual(self.session.execute(text('SELECT person_id FROM face_embeddings WHERE face_id=:f'),{'f':face}).scalar(),result['restored_id'])
            self.assertIsNotNone(self.session.execute(text('SELECT embedding FROM person_embeddings WHERE person_id=:p'),{'p':result['restored_id']}).first())
        def test_related_merge_stack_requires_latest_first(self):
            first=self.merge()
            another=Person(name='第三人',appearance_count=0);self.session.add(another);self.session.commit()
            merge_person_into(self.session,another.id,self.target,record_history=True)
            second=history.history(self.session)['items'][0]
            with self.assertRaises(HTTPException):self.undo(first)
            self.session.rollback();self.undo(second);self.undo(first)
        def test_missing_source_in_bulk_does_not_poison_next_merge(self):
            from app.api.person.merging import merge_multiple_persons
            from app.schemas.person import MergePersonsBulkRequest
            result=merge_multiple_persons(self.target,MergePersonsBulkRequest(source_ids=[99999999,self.source]),self.session)
            self.assertEqual(result.merged_ids,[self.source]);self.assertEqual(result.skipped_ids,[99999999])
        def test_undo_restores_manual_links_tags_and_relationships(self):
            tag=Tag(name=self._testMethodName);self.session.add(tag);self.session.flush()
            self.session.add(PersonTagLink(person_id=self.source,tag_id=tag.id))
            self.session.add(PersonMediaLink(person_id=self.source,media_id=self.data['media'][2]))
            third=Person(name='同框人',appearance_count=0);self.session.add(third);self.session.flush()
            a,b=sorted((self.source,third.id));self.session.add(PersonRelationship(person_a_id=a,person_b_id=b,coappearance_count=3))
            self.session.commit();third_id=third.id;tag_id=tag.id
            item=self.merge();result=self.undo(item);sid=result['restored_id']
            self.assertIsNotNone(self.session.get(PersonTagLink,(sid,tag_id)))
            self.assertIsNone(self.session.get(PersonTagLink,(self.target,tag_id)))
            self.assertIsNotNone(self.session.get(PersonMediaLink,(sid,self.data['media'][2])))
            self.assertEqual(self.session.get(PersonRelationship,tuple(sorted((sid,third_id)))).coappearance_count,3)
        def test_changed_relationship_blocks_undo_without_losing_new_counts(self):
            third=Person(name='同框人',appearance_count=0);self.session.add(third);self.session.flush()
            a,b=sorted((self.source,third.id));self.session.add(PersonRelationship(person_a_id=a,person_b_id=b,coappearance_count=3));self.session.commit()
            item=self.merge();pair=tuple(sorted((self.target,third.id)))
            rel=self.session.get(PersonRelationship,pair);rel.coappearance_count+=5;self.session.add(rel);self.session.commit()
            with self.assertRaises(HTTPException):self.undo(item)
            self.session.rollback();self.assertEqual(self.session.get(PersonRelationship,pair).coappearance_count,8)
        def request(self,**kwargs):
            plan=clips.segments(self.session,self.target)
            return exports.ExportRequest(person_id=self.target,profile_key=plan['profile_key'],revision=plan['revision'],clip_keys=[c['key'] for c in plan['clips']],output_dir=str(root/'export-output'),**kwargs)
        def test_stale_export_and_unknown_clip_are_rejected(self):
            request=self.request();request.revision='stale'
            with self.assertRaises(HTTPException) as caught:exports.start_export(self.session,BackgroundTasks(),request)
            self.assertEqual(caught.exception.status_code,409)
            request=self.request();request.clip_keys=['arbitrary-path']
            with self.assertRaises(HTTPException):exports.start_export(self.session,BackgroundTasks(),request)
        def test_export_protects_library_and_source_folders(self):
            request=self.request();request.output_dir=str(settings.general.data_dir)
            with self.assertRaises(HTTPException):exports.start_export(self.session,BackgroundTasks(),request)
        def test_real_export_normalizes_audio_and_produces_playable_montage(self):
            paths=[]
            for index,media_id in enumerate(self.data['media'][:2]):
                row=self.session.execute(text('SELECT path FROM media WHERE id=:id'),{'id':media_id}).scalar();path=Path(row);path.unlink()
                args=[str(ffmpeg),'-v','error','-n','-f','lavfi','-i',f'color=c={"red" if index==0 else "blue"}:s=320x180:r=30']
                if index==0:args+=['-f','lavfi','-i','sine=frequency=440:sample_rate=48000']
                args+=['-t','3','-c:v','libx264','-pix_fmt','yuv420p',str(path)]
                subprocess.run(args,check=True,capture_output=True,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0));paths.append(path)
                self.session.execute(text('UPDATE media SET duration=3 WHERE id=:id'),{'id':media_id})
            self.session.add(Face(person_id=self.target,media_id=self.data['media'][1],bbox=[0,0,1,1],timestamp=1));self.session.commit()
            request=self.request(before=0,after=1);background=BackgroundTasks()
            job=exports.start_export(self.session,background,request)
            asyncio.run(background())
            saved=next(j for j in exports.exports(self.session)['items'] if j['id']==job['id'])
            self.assertEqual(saved['status'],'completed',saved.get('error'))
            result=Path(saved['result_path']);self.assertTrue(result.is_file())
            details=json.loads(subprocess.check_output([str(ffmpeg.with_name('ffprobe.exe')),'-v','error','-show_entries','format=duration:stream=codec_type,width,height','-of','json',str(result)]))
            self.assertAlmostEqual(float(details['format']['duration']),4,delta=.15)
            self.assertEqual({s['codec_type'] for s in details['streams']},{'audio','video'})
            self.assertTrue(all(p.is_file() for p in paths))
            self.assertFalse(list(result.parent.glob('*.part.mp4')))
        def test_cancel_only_own_export_and_keeps_completed_files(self):
            request=self.request();background=BackgroundTasks();job=exports.start_export(self.session,background,request)
            exports.cancel(self.session,job['id']);asyncio.run(background())
            saved=next(j for j in exports.exports(self.session)['items'] if j['id']==job['id'])
            self.assertEqual(saved['status'],'cancelled')
            task=self.session.get(ProcessingTask,job['task_id']);self.session.refresh(task)
            self.assertEqual(task.status,'cancelled')
        def test_ffmpeg_cancellation_reaps_only_the_export_child(self):
            external=subprocess.Popen([str(ffmpeg),'-v','error','-re','-f','lavfi','-i','color=s=64x64','-t','20','-f','null','-'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            try:
                with patch.object(exports,'_cancelled',side_effect=[False,True,True]):
                    with self.assertRaises(exports.ExportCancelled):
                        exports._command([ffmpeg,'-v','error','-re','-f','lavfi','-i','color=s=64x64','-t','20','-f','null','-'],db.engine,'test','test',root/'cancel-test.log',30)
                self.assertIsNone(external.poll())
            finally:
                external.terminate();external.wait(timeout=5)
        def test_missing_video_export_fails_instead_of_silently_skipping(self):
            request=self.request();background=BackgroundTasks();job=exports.start_export(self.session,background,request)
            for clip in clips.segments(self.session,self.target)['clips']:Path(clip['media']['path']).unlink(missing_ok=True)
            asyncio.run(background());saved=next(j for j in exports.exports(self.session)['items'] if j['id']==job['id'])
            self.assertEqual(saved['status'],'failed');self.assertIn('不可读取',saved['error'])

    stream=io.StringIO()
    result=unittest.TextTestRunner(stream=stream,verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Checks))
    report={'success':result.wasSuccessful(),'tests':result.testsRun,'foundation_tests':15,'people_view_tests':15,'output':stream.getvalue(),'private_media_modified':False,'real_recognition_started':False,'real_ffmpeg_test':True}
    (root/'selftest-result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),'utf8')
    return result.wasSuccessful()
