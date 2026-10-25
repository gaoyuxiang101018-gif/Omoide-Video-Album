"""Read-only clip plans from actual video face observations."""
import math
from fastapi import HTTPException
from sqlalchemy import text
from app.person_views import state


def segments(session, person_id, with_person_id=None, gap=4):
    if with_person_id == person_id:
        raise HTTPException(400, '请选择另一个人物')
    stamp = state(session)
    people = [person_id] + ([with_person_id] if with_person_id else [])
    placeholders = ','.join(str(int(p)) for p in people)
    if session.execute(text(f'SELECT COUNT(*) FROM person WHERE id IN ({placeholders})')).scalar() != len(people):
        raise HTTPException(404, '人物不存在，请刷新')
    rows = session.execute(text(f'''SELECT f.person_id,f.timestamp,m.id,m.path,m.filename,m.duration,m.thumbnail_path,m.created_at
        FROM face f JOIN media m ON m.id=f.media_id WHERE f.person_id IN ({placeholders})
        AND m.duration>0 AND f.timestamp>=0 AND f.timestamp<=m.duration
        ORDER BY m.created_at DESC,m.id DESC,f.timestamp''')).mappings()
    videos = {}
    for row in rows:
        timestamp = float(row['timestamp'])
        if not math.isfinite(timestamp):
            continue
        video = videos.setdefault(row['id'], {'media': {k: row[k] for k in ('id', 'path', 'filename', 'duration', 'thumbnail_path', 'created_at')}, 'points': {p: set() for p in people}})
        video['points'][row['person_id']].add(round(timestamp, 3))
    clips = []
    for video in videos.values():
        points = video['points'][person_id]
        if with_person_id:
            points = points & video['points'][with_person_id]
        groups = []
        for timestamp in sorted(points):
            if groups and timestamp - groups[-1]['end'] <= gap + 0.00001:
                groups[-1]['end'] = timestamp
                groups[-1]['detections'] += 1
            else:
                groups.append({'start': timestamp, 'end': timestamp, 'detections': 1})
        for group in groups:
            clips.append({**group, 'key': f"{video['media']['id']}:{group['start']:.3f}:{group['end']:.3f}", 'media': video['media']})
    if len(clips) > 10000:
        raise HTTPException(422, '检测片段超过一万段，请增大片段间隔后再试')
    return {**stamp, 'person_id': person_id, 'with_person_id': with_person_id, 'gap': gap, 'clips': clips, 'basis': 'same_sampled_frame' if with_person_id else 'sampled_detections'}


def playback_bounds(clip, before=1, after=1):
    start = max(0, clip['start'] - before)
    end = min(float(clip['media']['duration']), clip['end'] + after)
    # Single observations need a playable interval even with zero padding.
    if end - start < 0.5:
        end = min(float(clip['media']['duration']), start + 0.5)
        start = max(0, end - 0.5)
    return round(start, 3), round(end, 3)
