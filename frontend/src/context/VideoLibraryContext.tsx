import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "../services/api";
import { getConfig } from "../services/config";
import { useTaskCompletionVersion } from "../TaskEventsContext";
import type { CursorPage, MediaDirectory, MediaPreview } from "../types";
import config from "../config";
import { belongsToLibraryDirectory, attachRestoredOutputs, readyRestoredSources, getRestoredOriginalIds, RestoredMediaLink, deduplicateLibraryVideos, MediaPathAlias, splitRestoredOriginals, normalizeLibraryPath } from "../albumUtils";
import { filmRequest, FilmVisibility } from "../services/film";
import { useLocalStoragePreference } from "../hooks/useLocalStoragePreference";
import { getRecognitionStates, RecognitionActivityItem, RecognitionState } from "../albumUtils";
import { getPersonCacheState } from '../services/personEvidence';
import { PERSON_VIEWS_CHANGED } from '../services/personViewCache';
import { useListStore } from '../stores/useListStore';

export type VideoFaceStatus = "pending" | "faces" | "empty" | "unknown";
interface FaceStatePage { items: { id: number; faces_extracted: boolean }[]; next_cursor: string | null; }
interface RestoredLinksResponse { data_dir: string; items: RestoredMediaLink[]; }
interface RecognitionActivityResponse { data_dir: string; items: RecognitionActivityItem[]; global_tasks: string[]; }
interface LibraryState {
  profilePath: string;
  pathAliases: MediaPathAlias[];
  videos: MediaPreview[];
  directories: MediaDirectory[];
  faceStates: Map<number, VideoFaceStatus>;
  loading: boolean;
  loadedCount: number;
  error: string | null;
  statusError: string | null;
  isInDirectory: (path: string, directory: string) => boolean;
  hiddenOriginals: MediaPreview[];
  restoredOriginalIds: Set<number> | null;
  recognitionStates: Map<number, RecognitionState>;
  activityReady: boolean;
  activityError: string | null;
  globalRecognitionBusy: boolean;
  showRestoredOriginals: boolean;
  setShowRestoredOriginals: (show: boolean) => void;
  visibilityError: string | null;
  reload: () => void;
}
const LibraryContext = createContext<LibraryState | null>(null);

export { normalizeLibraryPath, isInDirectory } from "../albumUtils";

async function readPages<T>(fetchPage: (cursor: string | null) => Promise<{ items: T[]; next_cursor: string | null }>, onProgress?: (count: number) => void) {
  const items: T[] = [], seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await fetchPage(cursor);
    items.push(...page.items);
    onProgress?.(items.length);
    cursor = page.next_cursor;
    if (cursor && seen.has(cursor)) throw new Error("文件列表分页异常，请刷新重试。");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return items;
}

export function VideoLibraryProvider({ children }: { children: React.ReactNode }) {
  const [indexedVideos, setVideos] = useState<MediaPreview[]>([]);
  const [directories, setDirectories] = useState<MediaDirectory[]>([]);
  const [faceStates, setFaceStates] = useState(new Map<number, VideoFaceStatus>());
  const [loading, setLoading] = useState(true);
  const [loadedCount, setLoadedCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [pathAliases, setPathAliases] = useState<MediaPathAlias[]>([]);
  const [profilePath, setProfilePath] = useState("");
  const [visibility, setVisibility] = useState<FilmVisibility | null>(null);
  const [visibilityError, setVisibilityError] = useState<string | null>(null);
  const [restoredLinks, setRestoredLinks] = useState<RestoredLinksResponse | null>(null);
  const [activity, setActivity] = useState<RecognitionActivityResponse | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);
  const indexedIds = useRef(new Set<number>());
  indexedIds.current = new Set(indexedVideos.map(item => item.id));
  const links = useMemo(() => restoredLinks && normalizeLibraryPath(restoredLinks.data_dir) === normalizeLibraryPath(profilePath) ? restoredLinks.items : [], [restoredLinks, profilePath]);
  const currentActivity = activity && normalizeLibraryPath(activity.data_dir) === normalizeLibraryPath(profilePath) ? activity : null;
  const activityReady = !!currentActivity && !activityError;
  const globalRecognitionBusy = !!currentActivity?.global_tasks.length;
  const recognitionStates = useMemo(() => getRecognitionStates(indexedVideos, currentActivity?.items ?? [], pathAliases), [indexedVideos, currentActivity, pathAliases]);
  const [originalVisibility, setOriginalVisibility] = useLocalStoragePreference("restoredOriginalVisibility", ["hide", "show"] as const, "hide");
  const showRestoredOriginals = originalVisibility === "show";
  const setShowRestoredOriginals = useCallback((show: boolean) => setOriginalVisibility(show ? "show" : "hide"), [setOriginalVisibility]);
  const isInDirectory = useCallback((path: string, directory: string) => belongsToLibraryDirectory(path, directory, pathAliases, links), [pathAliases, links]);
  const taskVersion = useTaskCompletionVersion(["scan", "process_media", "run_processor", "run_processor_for_media", "cluster_persons", "clean_missing_files"]);
  const reload = useCallback(() => setRevision(v => v + 1), []);
  useEffect(() => {
    if (!profilePath || config.PRESENTATION_MODE) return;
    const controller = new AbortController(); let timer: number;
    setActivity(null); setActivityError(null);
    const poll = async () => {
      const request = new AbortController(), abort = () => request.abort();
      controller.signal.addEventListener("abort", abort, { once: true });
      const timeout = window.setTimeout(abort, 8000);
      let busy = false;
      try {
        const value = await apiFetch<RecognitionActivityResponse>("/api/tasks/recognition-activity", { signal: request.signal });
        if (controller.signal.aborted) return;
        if (normalizeLibraryPath(value.data_dir) !== normalizeLibraryPath(profilePath)) throw new Error("资料库已切换");
        setActivity(previous => JSON.stringify(previous) === JSON.stringify(value) ? previous : value);
        setActivityError(null); busy = !!value.items.length || !!value.global_tasks.length;
      } catch {
        if (!controller.signal.aborted) setActivityError("暂时无法更新视频任务状态，请稍后刷新；批量选择暂不可用。");
      } finally {
        window.clearTimeout(timeout); controller.signal.removeEventListener("abort", abort);
      }
      if (!controller.signal.aborted) timer = window.setTimeout(poll, busy ? 2000 : 5000);
    };
    poll(); return () => { controller.abort(); window.clearTimeout(timer); };
  }, [profilePath]);
  useEffect(() => {
    if (!profilePath || config.PRESENTATION_MODE) return;
    const controller = new AbortController();
    let timer: number;
    const poll = async () => {
      const request = new AbortController();
      const abort = () => request.abort();
      controller.signal.addEventListener("abort", abort, { once: true });
      const timeout = window.setTimeout(abort, 8000);
      try {
        const history = apiFetch<RestoredLinksResponse>("/api/media/restored-links", { signal: request.signal }).then(associations => {
          if (controller.signal.aborted) return;
          if (normalizeLibraryPath(associations.data_dir) !== normalizeLibraryPath(profilePath)) throw new Error("资料库已切换");
          setRestoredLinks(previous => JSON.stringify(previous) === JSON.stringify(associations) ? previous : associations);
          if (associations.items.some(link => link.valid && !indexedIds.current.has(link.media_id))) setRevision(value => value + 1);
        });
        const [current] = await Promise.all([filmRequest<FilmVisibility>("/visibility", undefined, request.signal), history]);
        if (controller.signal.aborted) return;
        if (normalizeLibraryPath(current.data_dir) !== normalizeLibraryPath(profilePath)) throw new Error("资料库已切换");
        setVisibility(previous => previous?.data_dir === current.data_dir && JSON.stringify(previous.hidden_sources) === JSON.stringify(current.hidden_sources) ? previous : current);
        setVisibilityError(null);
      } catch {
        if (!controller.signal.aborted) { setVisibility(null); setVisibilityError("暂时无法核验还原成片或入库关联，原片保持显示；连接恢复后会自动更新。"); }
      } finally {
        window.clearTimeout(timeout);
        controller.signal.removeEventListener("abort", abort);
      }
      if (!controller.signal.aborted) timer = window.setTimeout(poll, 5000);
    };
    poll();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [profilePath]);
  const linkedVideos = useMemo(() => attachRestoredOutputs(indexedVideos, links), [indexedVideos, links]);
  const originalGroups = useMemo(() => splitRestoredOriginals(linkedVideos, readyRestoredSources(linkedVideos, visibility && normalizeLibraryPath(visibility.data_dir) === normalizeLibraryPath(profilePath) ? visibility.hidden_sources : [], links, pathAliases), pathAliases), [linkedVideos, visibility, profilePath, pathAliases, links]);
  const videos = showRestoredOriginals ? linkedVideos : originalGroups.visible;
  const hiddenOriginals = originalGroups.hidden;
  const restoredOriginalIds = useMemo(() => !restoredLinks || normalizeLibraryPath(restoredLinks.data_dir) !== normalizeLibraryPath(profilePath) ? null : getRestoredOriginalIds(indexedVideos, links, pathAliases, visibility && normalizeLibraryPath(visibility.data_dir) === normalizeLibraryPath(profilePath) ? visibility.hidden_sources : []), [indexedVideos, links, pathAliases, visibility, profilePath, restoredLinks]);
  useEffect(() => {
    const handler = () => reload();
    window.addEventListener("runtime-config-updated", handler);
    return () => window.removeEventListener("runtime-config-updated", handler);
  }, [reload]);
  useEffect(()=>{
    const changed=()=>{
      const store=useListStore.getState();
      store.clearListsByPrefix('people-');store.clearListsByPrefix('person-');store.clearListsByPrefix('/api/person/');
    };
    window.addEventListener(PERSON_VIEWS_CHANGED,changed);
    return ()=>window.removeEventListener(PERSON_VIEWS_CHANGED,changed);
  },[]);
  useEffect(() => {
    const controller = new AbortController(), signal = controller.signal;
    setLoading(true); setError(null); setStatusError(null); setLoadedCount(0);
    // Only the small database records are read here; video files are opened on demand.
    const videoRequest = readPages<MediaPreview>(cursor => apiFetch<CursorPage<MediaPreview>>("/api/media/videos", { query: { cursor, limit: 200 }, signal, errorMessage: "读取视频列表失败" }), count => { if (!signal.aborted) setLoadedCount(count); });
    const stateRequest = readPages(cursor => apiFetch<FaceStatePage>("/api/nopersons", { query: { cursor, limit: 200, media_type: "video", scope: "all" }, signal, errorMessage: "读取识别状态失败" }));
    const settingsRequest = config.PRESENTATION_MODE ? Promise.resolve(null) : Promise.all([getConfig(), apiFetch<MediaPathAlias[]>("/api/config/path-aliases", { signal })]);
    (config.PRESENTATION_MODE?Promise.resolve(null):getConfig()).then(value=>{if(value&&!signal.aborted){setProfilePath(value.general.data_dir);setDirectories(value.general.media_dirs??[]);}}).catch(()=>{});
    getPersonCacheState().catch(()=>{});
    Promise.allSettled([videoRequest, stateRequest, settingsRequest]).then(results => {
      if (signal.aborted) return;
      const [media, states, settings] = results;
      const aliases = settings.status === "fulfilled" && settings.value ? settings.value[1] : [];
      setPathAliases(aliases);
      if (media.status === "fulfilled") {
        const noFaces = new Map(states.status === "fulfilled" ? states.value.map(item => [item.id, item.faces_extracted]) : []);
        const priority = (item: MediaPreview) => states.status !== "fulfilled" ? 0 : !noFaces.has(item.id) ? 3 : noFaces.get(item.id) ? 2 : 1;
        const unique = deduplicateLibraryVideos(media.value, aliases, priority);
        setVideos(unique);
        if (states.status === "fulfilled") {
          setFaceStates(new Map(unique.map(item => [item.id, noFaces.has(item.id) ? (noFaces.get(item.id) ? "empty" : "pending") : "faces"])));
        } else {
          setFaceStates(new Map()); setStatusError("识别状态暂不可用，请刷新重试。");
        }
      } else {
        setVideos([]); setFaceStates(new Map());
        setError(media.reason instanceof Error ? media.reason.message : "读取视频失败，请重试。");
      }
      if (settings.status === "fulfilled" && settings.value) { setDirectories(settings.value[0].general.media_dirs ?? []); setProfilePath(settings.value[0].general.data_dir); }
      else if (settings.status === "rejected") setError("读取文件夹路径对应关系失败，请刷新重试。");
      setLoading(false);
    });
    return () => controller.abort();
  }, [revision, taskVersion]);
  return <LibraryContext.Provider value={{ profilePath,pathAliases,videos, directories, faceStates, loading, loadedCount, error, statusError, reload, isInDirectory, hiddenOriginals, restoredOriginalIds, recognitionStates, activityReady, activityError, globalRecognitionBusy, showRestoredOriginals, setShowRestoredOriginals, visibilityError }}>{children}</LibraryContext.Provider>;
}

export function useVideoLibrary() {
  const context = useContext(LibraryContext);
  if (!context) throw new Error("VideoLibraryProvider is missing");
  return context;
}
