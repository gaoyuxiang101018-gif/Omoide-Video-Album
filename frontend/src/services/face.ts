import { CursorPage, FaceRead } from "../types";
import { apiFetch } from "./api";

export const getOrphanFaces = async (
  cursor: string | null,
  signal?: AbortSignal
): Promise<CursorPage<FaceRead>> =>
  apiFetch<CursorPage<FaceRead>>("/api/faces/orphans", {
    query: { cursor },
    errorMessage: "获取孤立人脸失败",
    signal,
  });
