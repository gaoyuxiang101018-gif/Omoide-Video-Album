import type { MediaPreview } from "./types";

export const normalizeLibraryPath = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
export interface MediaPathAlias { path: string; resolved_path: string; }
export interface RestoredMediaLink { media_id: number; source_path: string; output_path: string; valid: boolean; mode: string; }
export type RecognitionState = "running" | "queued" | "completed" | "failed";
export interface RecognitionActivityItem { media_id: number; path: string; task_id: string; state: RecognitionState; }

export function getRecognitionStates(items: MediaPreview[], activity: RecognitionActivityItem[], aliases: MediaPathAlias[]) {
  const byPath = new Map<string, RecognitionState>();
  const priority = { running: 4, queued: 3, failed: 2, completed: 1 };
  for (const item of activity) {
    const key = canonicalLibraryPath(item.path, aliases), previous = byPath.get(key);
    if (!previous || priority[item.state] > priority[previous]) byPath.set(key, item.state);
  }
  return new Map(items.flatMap(item => {
    const state = byPath.get(canonicalLibraryPath(item.path, aliases));
    return state ? [[item.id, state] as const] : [];
  }));
}

export function bulkRecognitionCandidates(items: MediaPreview[], faceStates: ReadonlyMap<number, string>, restoredIds: ReadonlySet<number> | null, work: ReadonlyMap<number, RecognitionState>, ready: boolean, globalBusy: boolean) {
  if (!restoredIds || !ready || globalBusy) return [];
  return items.filter(item => faceStates.get(item.id) === "pending" && !restoredIds.has(item.id) && !work.has(item.id));
}

export function matchesVideoVersion(item: MediaPreview, version: string) {
  return version === "restored" ? !!item.restored_source_path : version === "original" ? !item.restored_source_path : true;
}
export function canonicalLibraryPath(path: string, aliases: MediaPathAlias[] = []) {
  const normalized = normalizeLibraryPath(path);
  for (const alias of [...aliases].sort((a, b) => b.path.length - a.path.length)) {
    const source = normalizeLibraryPath(alias.path);
    if (normalized === source || normalized.startsWith(source + "/")) return normalizeLibraryPath(alias.resolved_path) + normalized.slice(source.length);
  }
  return normalized;
}
export const isInDirectory = (path: string, directory: string, aliases: MediaPathAlias[] = []) => {
  const normalized = canonicalLibraryPath(path, aliases), parent = canonicalLibraryPath(directory, aliases);
  return !!parent && normalized.startsWith(parent + "/");
};

export function deduplicateLibraryVideos(items: MediaPreview[], aliases: MediaPathAlias[], priority: (item: MediaPreview) => number) {
  const byPath = new Map<string, MediaPreview>();
  for (const item of items) {
    const key = canonicalLibraryPath(item.path, aliases), previous = byPath.get(key);
    if (!previous || priority(item) > priority(previous) || (priority(item) === priority(previous) && item.id < previous.id)) byPath.set(key, item);
  }
  return Array.from(byPath.values());
}

export function splitRestoredOriginals(items: MediaPreview[], sources: string[], aliases: MediaPathAlias[]) {
  const restored = new Set(sources.map(path => canonicalLibraryPath(path, aliases)));
  const hidden: MediaPreview[] = [], visible: MediaPreview[] = [];
  for (const item of items) (restored.has(canonicalLibraryPath(item.path, aliases)) ? hidden : visible).push(item);
  return { hidden, visible };
}

export function attachRestoredOutputs(items: MediaPreview[], links: RestoredMediaLink[]) {
  const byId = new Map(links.map(link => [link.media_id, link]));
  return items.filter(item => byId.get(item.id)?.valid !== false).map(item => {
    const link = byId.get(item.id);
    return link ? { ...item, restored_source_path: link.source_path, restored_mode: link.mode } : item;
  });
}

export function belongsToLibraryDirectory(path: string, directory: string, aliases: MediaPathAlias[], links: RestoredMediaLink[]) {
  if (isInDirectory(path, directory, aliases)) return true;
  const key = canonicalLibraryPath(path, aliases);
  return links.some(link => link.valid && canonicalLibraryPath(link.output_path, aliases) === key && isInDirectory(link.source_path, directory, aliases));
}

export function readyRestoredSources(items: MediaPreview[], sources: string[], links: RestoredMediaLink[], aliases: MediaPathAlias[]) {
  const ids = new Set(items.map(item => item.id));
  const ready = new Set(links.filter(link => link.valid && ids.has(link.media_id)).map(link => canonicalLibraryPath(link.source_path, aliases)));
  return sources.filter(source => ready.has(canonicalLibraryPath(source, aliases)));
}

export function getRestoredOriginalIds(items: MediaPreview[], links: RestoredMediaLink[], aliases: MediaPathAlias[], verifiedSources: string[] = []) {
  const sources = new Set([...links.map(link => link.source_path), ...verifiedSources].map(path => canonicalLibraryPath(path, aliases)));
  return new Set(items.filter(item => sources.has(canonicalLibraryPath(item.path, aliases))).map(item => item.id));
}

export function formatVideoDuration(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return "—";
  const seconds = Math.max(0, Math.round(value));
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export function sortVideos(items: MediaPreview[], sort: string) {
  const field = sort === "latest" ? "inserted_at" : "created_at";
  const timestamp = (item: MediaPreview) => {
    const value = Date.parse(item[field] ?? "");
    return Number.isFinite(value) ? value : 0;
  };
  return [...items].sort((a, b) => timestamp(b) - timestamp(a) || b.id - a.id);
}

export function captureDate(value?: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return "日期未知";
  return new Date(value).toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
}
