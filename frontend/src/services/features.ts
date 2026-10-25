import {
  Album,
  CameraCount,
  CursorPage,
  EventItem,
  EventPage,
  HighlightYear,
  LibraryStats,
  Media,
  MemoryGroup,
  PlaceCountry,
  Task,
} from "../types";
import { apiFetch } from "./api";

// ---------- memories & highlights ----------

export const getMemories = async (
  signal?: AbortSignal
): Promise<MemoryGroup[]> =>
  apiFetch<MemoryGroup[]>("/api/memories", {
    errorMessage: "加载回忆失败",
    signal,
  });

export const getHighlights = async (
  year: number,
  limit = 60,
  signal?: AbortSignal
): Promise<Media[]> =>
  apiFetch<Media[]>("/api/memories/highlights", {
    query: { year, limit },
    errorMessage: "加载精彩集锦失败",
    signal,
  });

export const getHighlightYears = async (
  signal?: AbortSignal
): Promise<HighlightYear[]> =>
  apiFetch<HighlightYear[]>("/api/memories/highlights/years", {
    errorMessage: "加载精彩年份失败",
    signal,
  });

// ---------- statistics ----------

export const getLibraryStats = async (
  signal?: AbortSignal
): Promise<LibraryStats> =>
  apiFetch<LibraryStats>("/api/stats", {
    errorMessage: "加载统计信息失败",
    signal,
  });

export const getCameras = async (
  signal?: AbortSignal
): Promise<CameraCount[]> =>
  apiFetch<CameraCount[]>("/api/stats/cameras", {
    errorMessage: "加载相机失败",
    signal,
  });

// ---------- albums ----------

export const getAlbums = async (signal?: AbortSignal): Promise<Album[]> =>
  apiFetch<Album[]>("/api/albums", {
    errorMessage: "加载相册失败",
    signal,
  });

export const getAlbum = async (
  id: number,
  signal?: AbortSignal
): Promise<Album> =>
  apiFetch<Album>(`/api/albums/${id}`, {
    errorMessage: "加载相册失败",
    signal,
  });

export const createAlbum = async (
  name: string,
  description?: string
): Promise<Album> =>
  apiFetch<Album>("/api/albums", {
    method: "POST",
    body: { name, description },
    errorMessage: "创建相册失败",
  });

export const updateAlbum = async (
  id: number,
  patch: { name?: string; description?: string; cover_media_id?: number }
): Promise<Album> =>
  apiFetch<Album>(`/api/albums/${id}`, {
    method: "PATCH",
    body: patch,
    errorMessage: "更新相册失败",
  });

export const deleteAlbum = async (id: number): Promise<void> =>
  apiFetch<void>(`/api/albums/${id}`, {
    method: "DELETE",
    errorMessage: "删除相册失败",
  });

export const addMediaToAlbum = async (
  id: number,
  mediaIds: number[]
): Promise<Album> =>
  apiFetch<Album>(`/api/albums/${id}/media`, {
    method: "POST",
    body: { media_ids: mediaIds },
    errorMessage: "添加媒体文件到相册失败",
  });

export const removeMediaFromAlbum = async (
  id: number,
  mediaIds: number[]
): Promise<Album> =>
  apiFetch<Album>(`/api/albums/${id}/media`, {
    method: "DELETE",
    body: { media_ids: mediaIds },
    errorMessage: "从相册移除媒体文件失败",
  });

export const getAlbumMedia = async (
  id: number,
  cursor: string | null,
  signal?: AbortSignal
): Promise<CursorPage<Media>> =>
  apiFetch<CursorPage<Media>>(`/api/albums/${id}/media`, {
    query: { cursor },
    errorMessage: "加载相册媒体文件失败",
    signal,
  });

// ---------- events ----------

export const getEvents = async (
  cursor: string | null,
  signal?: AbortSignal
): Promise<EventPage> =>
  apiFetch<EventPage>("/api/events", {
    query: { cursor },
    errorMessage: "加载事件失败",
    signal,
  });

export const getEvent = async (
  id: number,
  signal?: AbortSignal
): Promise<EventItem> =>
  apiFetch<EventItem>(`/api/events/${id}`, {
    errorMessage: "加载事件失败",
    signal,
  });

export const getEventMedia = async (
  id: number,
  cursor: string | null,
  signal?: AbortSignal
): Promise<CursorPage<Media>> =>
  apiFetch<CursorPage<Media>>(`/api/events/${id}/media`, {
    query: { cursor },
    errorMessage: "加载事件媒体文件失败",
    signal,
  });

export const updateEvent = async (
  id: number,
  title: string
): Promise<EventItem> =>
  apiFetch<EventItem>(`/api/events/${id}`, {
    method: "PATCH",
    body: { title },
    errorMessage: "重命名事件失败",
  });

export const convertEventToAlbum = async (
  id: number,
  name?: string
): Promise<Album> =>
  apiFetch<Album>(`/api/events/${id}/convert-to-album`, {
    method: "POST",
    body: { name: name ?? null },
    errorMessage: "将事件转换为相册失败",
  });

// ---------- places ----------

export const getPlaces = async (
  signal?: AbortSignal
): Promise<PlaceCountry[]> =>
  apiFetch<PlaceCountry[]>("/api/places", {
    errorMessage: "加载位置失败",
    signal,
  });

export const getPlaceMedia = async (
  city: string,
  country: string | null,
  cursor: string | null,
  signal?: AbortSignal
): Promise<CursorPage<Media>> => {
  // `city` is a required backend param and must be sent even when empty
  // (apiFetch's `query` would drop ""), so build this query string by hand.
  const params = new URLSearchParams();
  params.append("city", city);
  if (country) params.append("country", country);
  if (cursor) params.append("cursor", cursor);
  return apiFetch<CursorPage<Media>>(`/api/places/media?${params}`, {
    errorMessage: "加载地点媒体文件失败",
    signal,
  });
};

// ---------- organize tasks ----------

export const startBuildEvents = async (): Promise<Task> =>
  apiFetch<Task>("/api/tasks/build_events", {
    method: "POST",
    errorMessage: "启动事件聚类失败",
  });

export const startGeocodePlaces = async (): Promise<Task> =>
  apiFetch<Task>("/api/tasks/geocode_places", {
    method: "POST",
    errorMessage: "启动地理编码失败",
  });
