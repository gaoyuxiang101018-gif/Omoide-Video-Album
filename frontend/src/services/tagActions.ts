import { apiFetch } from "./api";

export const removeTagFromMedia = async (mediaId: number, tagId: number) =>
  apiFetch<void>(`/api/tags/media/${mediaId}/${tagId}`, {
    method: "DELETE",
    errorMessage: "从媒体文件移除标签失败",
  });

export const removeTagFromPerson = async (personId: number, tagId: number) =>
  apiFetch<void>(`/api/tags/person/${personId}/${tagId}`, {
    method: "DELETE",
    errorMessage: "从人物移除标签失败",
  });

export const deleteTag = async (tagId: number) =>
  apiFetch<void>(`/api/tags/${tagId}`, {
    method: "DELETE",
    errorMessage: "删除标签失败",
  });
