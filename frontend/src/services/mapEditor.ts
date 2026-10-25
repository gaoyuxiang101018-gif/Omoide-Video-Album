import { CursorPage, MediaPreview } from "../types";
import { apiFetch } from "./api";

export const getMissingGeoMedia = async (
  cursor: string | null,
  signal?: AbortSignal
): Promise<CursorPage<MediaPreview>> =>
  apiFetch<CursorPage<MediaPreview>>("/api/media/missing-geo", {
    query: { cursor },
    errorMessage: "获取无地理位置信息的媒体文件失败",
    signal,
  });

export const updateMediaGeolocation = async (
  mediaId: number,
  latitude: number,
  longitude: number
) =>
  apiFetch<void>(`/api/media/${mediaId}/geolocation`, {
    method: "PATCH",
    body: {
      latitude: latitude,
      longitude: longitude,
    },
    errorMessage: "更新媒体文件地理位置失败",
  });
