import {
  CursorPage,
  Media,
  MediaDetail,
  MediaFolderListing,
  MediaLocation,
} from "../types";
import { apiFetch } from "./api";

export const getMedia = async (
  id: string,
  signal?: AbortSignal
): Promise<MediaDetail> =>
  apiFetch<MediaDetail>(`/api/media/${id}`, {
    errorMessage: "加载媒体失败",
    signal,
  });

export const getImages = async (
  cursor: string | null,
  sortOrder: "newest" | "latest",
  signal?: AbortSignal
): Promise<CursorPage<Media>> =>
  apiFetch<CursorPage<Media>>("/api/media/images", {
    query: { cursor, sort: sortOrder },
    errorMessage: "获取图片失败",
    signal,
  });

export const getVideos = async (
  cursor: string | null,
  sortOrder: "newest" | "latest",
  signal?: AbortSignal
): Promise<CursorPage<Media>> =>
  apiFetch<CursorPage<Media>>("/api/media/videos", {
    query: { cursor, sort: sortOrder },
    errorMessage: "获取视频失败",
    signal,
  });

export const getFavorites = async (
  cursor: string | null,
  sortOrder: "newest" | "latest",
  signal?: AbortSignal
): Promise<CursorPage<Media>> =>
  apiFetch<CursorPage<Media>>("/api/media/favorites", {
    query: { cursor, sort: sortOrder },
    errorMessage: "获取收藏失败",
    signal,
  });

export const getMediaLocations = async (
  north: number,
  south: number,
  east: number,
  west: number,
  signal?: AbortSignal
): Promise<MediaLocation[]> =>
  apiFetch<MediaLocation[]>("/api/media/locations", {
    query: { north, south, east, west },
    errorMessage: "获取媒体文件位置失败",
    signal,
  });

export interface CameraFilter {
  make?: string | null;
  model?: string | null;
}

export const getMediaList = async (
  cursor: string | null,
  sortOrder: "newest" | "latest",
  tags: string[],
  folder?: string | null,
  recursive = true,
  camera?: CameraFilter | null,
  signal?: AbortSignal
): Promise<CursorPage<Media>> => {
  // An empty `folder` means "library root" to the backend, so it must be sent
  // even when empty (apiFetch's `query` would drop ""); build it by hand.
  const params = new URLSearchParams();
  params.append("sort", sortOrder);
  if (cursor) {
    params.append("cursor", cursor);
  }
  tags.forEach((tag) => params.append("tags", tag));
  if (folder !== undefined && folder !== null) {
    params.append("folder", folder);
  }
  if (!recursive) {
    params.append("recursive", "false");
  }
  if (camera?.make) {
    params.append("camera_make", camera.make);
  }
  if (camera?.model) {
    params.append("camera_model", camera.model);
  }
  return apiFetch<CursorPage<Media>>(`/api/media/?${params}`, {
    errorMessage: "获取媒体文件列表失败",
    signal,
  });
};

export const getMediaFolders = async (
  parent?: string | null,
  previewLimit = 4,
  signal?: AbortSignal
): Promise<MediaFolderListing> =>
  apiFetch<MediaFolderListing>("/api/media/folders", {
    // An omitted and an empty `parent` both mean the library root.
    query: {
      parent,
      preview_limit: previewLimit !== 4 ? previewLimit : undefined,
    },
    errorMessage: "获取媒体文件夹失败",
    signal,
  });

export const getSimilarMedia = async (
  mediaId: number,
  signal?: AbortSignal
): Promise<Media[]> =>
  apiFetch<Media[]>(`/api/media/${mediaId}/get-similar`, {
    errorMessage: "加载相似媒体文件失败",
    signal,
  });
