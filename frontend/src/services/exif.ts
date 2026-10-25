import { ExifData } from "../types";
import { apiFetch } from "./api";

export const getExifData = async (
  mediaId: number,
  signal?: AbortSignal
): Promise<ExifData | null> =>
  apiFetch<ExifData | null>(`/api/media/${mediaId}/processors/exif`, {
    errorMessage: "获取EXIF数据失败",
    signal,
  });
