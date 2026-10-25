import { Media, Task } from "../types";
import { apiFetch } from "./api";

export const convertMedia = async (mediaId: number): Promise<Task> =>
  apiFetch<Task>(`/api/media/${mediaId}/converter`, {
    method: "POST",
    errorMessage: "启动转换失败",
  });

export const deleteMediaRecord = async (mediaId: number) =>
  apiFetch<void>(`/api/media/${mediaId}`, {
    method: "DELETE",
    errorMessage: "删除媒体文件记录失败",
  });

export const deleteMediaFile = async (mediaId: number) =>
  apiFetch<void>(`/api/media/${mediaId}/file`, {
    method: "DELETE",
    errorMessage: "删除媒体文件失败",
  });

export const openMediaFolder = async (mediaId: number): Promise<void> =>
  apiFetch<void>(`/api/media/${mediaId}/open-folder`, {
    method: "POST",
    errorMessage: "打开文件夹失败",
  });

export const openMediaFile = async (mediaId: number): Promise<void> =>
  apiFetch<void>(`/api/media/${mediaId}/open-file`, {
    method: "POST",
    errorMessage: "打开文件失败",
  });

export const setMediaFavorite = async (
  mediaId: number,
  isFavorite: boolean
): Promise<Media> =>
  apiFetch<Media>(`/api/media/${mediaId}/favorite`, {
    method: "PATCH",
    body: { is_favorite: isFavorite },
    errorMessage: "更新收藏失败",
  });
