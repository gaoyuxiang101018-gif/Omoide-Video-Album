import { Tag } from "../types";
import { CursorPage } from "../types";
import { apiFetch } from "./api";

export const getTags = async (
  cursor: string | null,
  signal?: AbortSignal
): Promise<CursorPage<Tag>> =>
  apiFetch<CursorPage<Tag>>("/api/tags/", {
    query: { cursor },
    errorMessage: "获取标签失败",
    signal,
  });

export const getTag = async (
  id: string,
  signal?: AbortSignal
): Promise<Tag> =>
  apiFetch<Tag>(`/api/tags/${id}`, {
    errorMessage: "加载标签失败",
    signal,
  });
