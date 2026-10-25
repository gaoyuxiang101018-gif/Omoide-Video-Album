import { SceneRead } from "../types";
import { apiFetch } from "./api";

export const getScenes = async (
  mediaId: number,
  signal?: AbortSignal
): Promise<SceneRead[]> =>
  apiFetch<SceneRead[]>(`/api/media/${mediaId}/scenes`, {
    errorMessage: "获取场景失败",
    signal,
  });

export const createScene = async (
  mediaId: number,
  data: { start_time: number; end_time?: number; description?: string }
): Promise<SceneRead> =>
  apiFetch<SceneRead>(`/api/media/${mediaId}/scenes`, {
    method: "POST",
    body: data,
    errorMessage: "创建场景失败",
  });

export const deleteScene = async (
  mediaId: number,
  sceneId: number
): Promise<void> =>
  apiFetch<void>(`/api/media/${mediaId}/scenes/${sceneId}`, {
    method: "DELETE",
    errorMessage: "删除场景失败",
  });
