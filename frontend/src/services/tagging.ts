import { Tag } from "../types";
import { apiFetch } from "./api";

export const createTag = async (name: string): Promise<Tag> =>
  apiFetch<Tag>("/api/tags/", {
    method: "POST",
    body: { name },
    errorMessage: "创建标签失败",
  });

export const assignTag = async (ownerType: "media" | "person", ownerId: number, tagId: number) =>
  apiFetch<void>(`/api/tags/${ownerType}/${ownerId}/${tagId}`, {
    method: "POST",
    errorMessage: "分配标签失败",
  });
