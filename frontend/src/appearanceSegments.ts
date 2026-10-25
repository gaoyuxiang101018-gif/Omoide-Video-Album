import type { FaceRead, MediaPreview } from "./types";
export interface AppearanceSegment { start: number; end: number; detections: number; firstFace: FaceRead; }
export interface VideoAppearance { media: MediaPreview; segments: AppearanceSegment[]; missingTimestamps: number; faceCount: number; }

export function buildAppearanceSegments(faces: FaceRead[], duration: number, maxGap: number): AppearanceSegment[] {
  const valid = faces.filter(face => typeof face.timestamp === "number" && Number.isFinite(face.timestamp) && face.timestamp >= 0 && face.timestamp <= duration)
    .sort((a, b) => a.timestamp! - b.timestamp! || a.id - b.id);
  const segments: AppearanceSegment[] = [];
  for (const face of valid) {
    const timestamp = face.timestamp!, previous = segments[segments.length - 1];
    if (previous && timestamp - previous.end <= maxGap) {
      previous.end = timestamp; previous.detections++;
    } else segments.push({ start: timestamp, end: timestamp, detections: 1, firstFace: face });
  }
  return segments;
}

export function getVideoAppearances(media: MediaPreview[], faces: FaceRead[], maxGap = 4): VideoAppearance[] {
  const groups = new Map<number, FaceRead[]>();
  for (const face of faces) {
    const group = groups.get(face.media_id) ?? [];
    group.push(face); groups.set(face.media_id, group);
  }
  return media.filter(item => typeof item.duration === "number").map(item => {
    const group = groups.get(item.id) ?? [], segments = buildAppearanceSegments(group, item.duration!, maxGap);
    const validCount = segments.reduce((count, segment) => count + segment.detections, 0);
    return { media: item, segments, faceCount: group.length, missingTimestamps: group.length - validCount };
  });
}

export type PersonFinderSort = "face_count" | "latest_video" | "video_count" | "newest" | "name";
export function comparePersonMetrics(a: { id: number; name?: string; faceCount?: number; videoCount?: number; latestVideo?: string }, b: typeof a, sort: PersonFinderSort) {
  if (sort === "face_count") return (b.faceCount ?? 0) - (a.faceCount ?? 0) || b.id - a.id;
  if (sort === "video_count") return (b.videoCount ?? 0) - (a.videoCount ?? 0) || (b.faceCount ?? 0) - (a.faceCount ?? 0) || b.id - a.id;
  if (sort === "latest_video") return (Date.parse(b.latestVideo ?? "") || 0) - (Date.parse(a.latestVideo ?? "") || 0) || b.id - a.id;
  if (sort === "name") return (a.name || "").localeCompare(b.name || "", "zh-CN", { numeric: true }) || a.id - b.id;
  return b.id - a.id;
}
