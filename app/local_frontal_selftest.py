"""Opt-in isolated regression checks for frontal anchors and profile attachments."""
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch


def run(root):
    root = Path(root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    from app.local_review_selftest import run as foundation
    if not foundation(root / 'foundation'):
        return False
    import numpy as np
    from sqlalchemy import text
    from sqlmodel import Session
    import app.database as db
    from app.models import Face, Person
    from app.local_people_views_selftest import fixture
    from app.tasks.clustering_queries import fetch_faces_and_embeddings
    from app.tasks.face_matching import _load_person_prototype_matrix
    from app.tasks.person_clustering import _assign_faces_to_clusters
    from app.persons import auto_select_profile_face
    from app.config import settings
    from app.tasks.face_matching import _match_unassigned_to_existing
    from fastapi import HTTPException

    class Checks(unittest.TestCase):
        def setUp(self):
            self.fixture = fixture(root / self._testMethodName)
            self.session = Session(db.engine)
            self.media = self.fixture['media'][0]
            self.vector = np.zeros(512, dtype=np.float32)
            self.vector[self.media % 500] = 1
            self.session.execute(text("UPDATE processingtask SET status='completed' WHERE status IN ('pending','running')"))
            self.session.commit()

        def tearDown(self):
            self.session.close()

        def person(self, name=None):
            person = Person(name=name, appearance_count=1)
            self.session.add(person)
            self.session.flush()
            return person.id

        def face(self, person=None, pose=.9, vector=None, score=.95):
            face = Face(person_id=person, media_id=self.media, bbox=[0, 0, 20, 20],
                        thumbnail_path=self.fixture['thumbnail'], frontality=pose, det_score=score)
            self.session.add(face)
            self.session.flush()
            vector = self.vector if vector is None else vector
            self.session.execute(text('INSERT INTO face_embeddings(face_id,person_id,embedding) VALUES(:f,:p,:v)'),
                                 {'f': face.id, 'p': person if person is not None else -1, 'v': vector.tobytes()})
            return face.id

        def test_side_faces_and_unknown_pose_cannot_seed_people(self):
            frontal = self.face(pose=.9)
            side = self.face(pose=.3)
            unknown = self.face(pose=None)
            unknown_confidence = self.face(pose=.9, score=None)
            self.session.commit()
            ids, _ = fetch_faces_and_embeddings(self.session, quality_seed_only=True)
            self.assertIn(frontal, ids)
            self.assertTrue({side, unknown, unknown_confidence}.isdisjoint(ids))

        def test_people_without_a_frontal_anchor_are_not_matching_targets(self):
            frontal, side = self.person(), self.person()
            self.face(frontal, .9)
            self.face(side, .2)
            self.session.commit()
            owners, _ = _load_person_prototype_matrix(self.session)
            self.assertIn(frontal, owners.tolist())
            self.assertNotIn(side, owners.tolist())

        def test_cluster_creation_rechecks_pose_even_if_called_without_seed_filter(self):
            side = [self.face(pose=.3), self.face(pose=.4)]
            self.session.commit()
            before = self.session.execute(text('SELECT COUNT(*) FROM person')).scalar()
            with patch.object(settings.face_recognition, 'person_min_media_count', 1):
                created, ids = _assign_faces_to_clusters({0: (side, [self.vector, self.vector])}, 'frontal-fixture', update_progress=False)
            self.session.expire_all()
            self.assertEqual((created, ids), (0, []))
            self.assertEqual(self.session.execute(text('SELECT COUNT(*) FROM person')).scalar(), before)
            self.assertTrue(all(self.session.get(Face, identifier).person_id is None for identifier in side))

        def test_profile_picture_prefers_frontal_even_when_side_faces_dominate(self):
            person = self.person()
            for _ in range(5):
                self.face(person, .1)
            vector = self.vector.copy()
            index = int(np.argmax(vector))
            vector[index], vector[index + 1] = .8, .6
            frontal = self.face(person, .95, vector)
            self.session.commit()
            self.assertEqual(auto_select_profile_face(self.session, person), frontal)

        def test_a_confident_side_face_attaches_to_the_frontal_person(self):
            person = self.person()
            self.face(person, .9)
            side = self.face(pose=.1)
            self.session.commit()
            pending = _match_unassigned_to_existing(self.session, [side], np.array([self.vector]), None)
            self.session.expire_all()
            self.assertEqual(pending, [])
            self.assertEqual(self.session.get(Face, side).person_id, person)
            self.assertGreaterEqual(self.session.get(Face, self.session.get(Person, person).profile_face_id).frontality, .65)

        def test_ambiguous_side_faces_stay_pending(self):
            a, b = self.person(), self.person()
            self.face(a, .9)
            self.face(b, .9)
            side = self.face(pose=.1)
            self.session.commit()
            self.assertEqual(_match_unassigned_to_existing(self.session, [side], np.array([self.vector]), None), [side])
            self.session.expire_all()
            self.assertIsNone(self.session.get(Face, side).person_id)

        def test_cached_prototype_cannot_bypass_the_anchor_requirement(self):
            person = self.person()
            self.face(person, .1)
            side = self.face(pose=.1)
            self.session.commit()
            pending = _match_unassigned_to_existing(self.session, [side], np.array([self.vector]), None,
                                                     prototypes=(np.array([person]), np.array([self.vector])))
            self.assertEqual(pending, [side])

        def test_frontal_clusters_still_create_people(self):
            faces = [self.face(pose=.9), self.face(pose=.8)]
            self.session.commit()
            with patch.object(settings.face_recognition, 'person_min_media_count', 1):
                created, people = _assign_faces_to_clusters({0: (faces, [self.vector, self.vector])}, 'frontal-fixture', update_progress=False)
            self.assertEqual(created, 1)
            self.assertEqual(len(people), 1)

        def test_existing_side_group_review_is_reversible_and_keeps_every_face(self):
            from app import frontal_policy as policy, person_views
            person, target = self.person(), self.person()
            faces = [self.face(person, .1), self.face(person, .2)]
            self.face(target, .95)
            self.session.commit()
            before = self.session.execute(text('SELECT COUNT(*) FROM face')).scalar()
            preview = policy.preview(self.session)
            self.assertIn(person, [item['id'] for item in preview['items']])
            result = policy.reconcile(self.session, preview['profile_key'], preview['fingerprint'])
            self.session.expire_all()
            self.assertTrue(all(self.session.get(Face, face).person_id == target for face in faces))
            self.assertEqual(self.session.execute(text('SELECT COUNT(*) FROM face')).scalar(), before)
            self.assertIsNotNone(self.session.get(Person, person))
            self.assertNotIn(person, [p['id'] for p in person_views.overview(self.session)['items']])
            self.assertNotIn(person, [p['id'] for p in person_views.first_seen_people(self.session)['items']])
            added = self.face(target, .9)
            self.session.commit()
            policy.undo(self.session, result['id'])
            self.session.expire_all()
            self.assertTrue(all(self.session.get(Face, face).person_id == person for face in faces))
            self.assertEqual(self.session.get(Face, added).person_id, target)

        def test_named_manual_and_unscored_people_are_not_automatically_dismantled(self):
            from app import frontal_policy as policy
            named, manual, unknown = self.person('保留人工人物'), self.person(), self.person()
            self.face(named, .1)
            manual_face = self.face(manual, .1)
            self.face(unknown, None)
            self.session.execute(text("INSERT INTO face_manual_assignment VALUES(:face,NULL,'assign','fixture')"), {'face': manual_face})
            self.session.commit()
            identifiers = {item['id'] for item in policy.preview(self.session)['items']}
            self.assertTrue({named, manual, unknown}.isdisjoint(identifiers))

        def test_review_respects_the_different_people_rule(self):
            from app import frontal_policy as policy
            from app.person_review import add_separation
            source, target = self.person(), self.person()
            side = self.face(source, .1)
            self.face(target, .9)
            self.session.commit()
            add_separation(self.session, source, target)
            preview = policy.preview(self.session)
            policy.reconcile(self.session, preview['profile_key'], preview['fingerprint'])
            self.session.expire_all()
            self.assertIsNone(self.session.get(Face, side).person_id)

        def test_review_rejects_a_stale_preview(self):
            from app import frontal_policy as policy
            person = self.person()
            self.face(person, .1)
            self.session.commit()
            preview = policy.preview(self.session)
            self.face(person, .9)
            self.session.commit()
            with self.assertRaises(HTTPException) as error:
                policy.reconcile(self.session, preview['profile_key'], preview['fingerprint'])
            self.assertEqual(error.exception.status_code, 409)

        def test_clearer_frontal_picture_wins_within_the_same_pose_band(self):
            from PIL import Image
            person = self.person()
            blurry = self.face(person, .95)
            clear = self.face(person, .94)
            filename = settings.general.thumb_dir / f'faces/sharp-{clear}.png'
            data = ((np.indices((128, 128)).sum(axis=0) % 2) * 255).astype(np.uint8)
            Image.fromarray(data).save(filename)
            self.session.get(Face, clear).thumbnail_path = f'faces/sharp-{clear}.png'
            self.session.commit()
            self.assertEqual(auto_select_profile_face(self.session, person), clear)

        def test_another_frame_cannot_pull_an_uncertain_side_face_into_a_person(self):
            person = self.person()
            self.face(person, .95)
            vector = self.vector.copy()
            index = int(np.argmax(vector))
            vector[index], vector[index + 1] = .55, float(np.sqrt(1-.55**2))
            side = self.face(pose=.1, vector=vector)
            frontal = self.face(pose=.95)
            self.session.get(Face, side).timestamp = 1
            self.session.get(Face, frontal).timestamp = 2
            self.session.commit()
            pending = _match_unassigned_to_existing(self.session, [side, frontal], np.array([vector, self.vector]), None)
            self.session.expire_all()
            self.assertIn(side, pending)
            self.assertIsNone(self.session.get(Face, side).person_id)

        def test_review_is_blocked_while_a_real_type_of_analysis_is_running(self):
            from app import frontal_policy as policy
            from app.models import ProcessingTask
            person = self.person()
            face = self.face(person, .1)
            self.session.commit()
            preview = policy.preview(self.session)
            task = ProcessingTask(task_type='run_processor_for_media', status='running')
            self.session.add(task)
            self.session.commit()
            with self.assertRaises(HTTPException) as error:
                policy.reconcile(self.session, preview['profile_key'], preview['fingerprint'])
            self.assertEqual(error.exception.status_code, 409)
            self.assertEqual(self.session.get(Face, face).person_id, person)

        def test_undo_does_not_overwrite_a_later_manual_assignment(self):
            from app import frontal_policy as policy
            person = self.person()
            face = self.face(person, .1)
            self.session.commit()
            preview = policy.preview(self.session)
            result = policy.reconcile(self.session, preview['profile_key'], preview['fingerprint'])
            self.session.execute(text("INSERT INTO face_manual_assignment VALUES(:face,NULL,'exclude','later-edit')"), {'face': face})
            self.session.commit()
            with self.assertRaises(HTTPException) as error:
                policy.undo(self.session, result['id'])
            self.assertEqual(error.exception.status_code, 409)

        def test_mixed_cluster_never_directly_assigns_its_unverified_side_members(self):
            frontal = [self.face(pose=.9), self.face(pose=.8)]
            side = self.face(pose=.1)
            self.session.commit()
            with patch.object(settings.face_recognition, 'person_min_media_count', 1):
                created, _ = _assign_faces_to_clusters({0: (frontal + [side], [self.vector]*3)}, 'frontal-fixture', update_progress=False)
            self.session.expire_all()
            self.assertEqual(created, 1)
            self.assertIsNone(self.session.get(Face, side).person_id)

        def test_legacy_library_gets_the_missing_person_lookup_index(self):
            from app import frontal_policy as policy
            self.session.rollback()
            with db.engine.begin() as connection:
                connection.exec_driver_sql('DROP INDEX IF EXISTS ix_face_person_id')
            policy._ready.discard(db.engine)
            policy.ensure_schema()
            indexes = {row[1] for row in self.session.execute(text('PRAGMA index_list(face)'))}
            self.assertIn('ix_face_person_id', indexes)

    stream = io.StringIO()
    result = unittest.TextTestRunner(stream=stream, verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Checks))
    report = {'success': result.wasSuccessful(), 'tests': result.testsRun, 'output': stream.getvalue(),
              'real_library_modified': False}
    (root / 'selftest-result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), 'utf8')
    return result.wasSuccessful()
