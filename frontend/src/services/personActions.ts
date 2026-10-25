import {
  CursorPage,
  FaceRead,
  Person,
  PersonRelationshipGraph,
  SimilarPersonWithDetails,
  Task,
} from "../types";
import { apiFetch } from "./api";
import { cachedPersonData } from "./personEvidence";

export interface MergeResult {
  merged_ids: number[];
  skipped_ids: number[];
}

export interface DeletePersonsResult {
  deleted_ids: number[];
  skipped_ids: number[];
}

export interface AddMediaAppearanceResult {
  person_id: number;
  media_id: number;
  added: boolean;
}

/** Starts a background task; poll it via getTask for the outcome. */
export const exportPersonMedia = async (
  personId: number,
  destinationPath: string,
  mode: "copy" | "move"
): Promise<Task> =>
  apiFetch<Task>(`/api/person/${personId}/export-media`, {
    method: "POST",
    body: { destination_path: destinationPath, mode },
    errorMessage: `Failed to ${mode} media`,
  });

export const updatePerson = async (
  personId: number,
  data: { name?: string; profile_face_id?: number }
): Promise<Person> =>
  apiFetch<Person>(`/api/person/${personId}`, {
    method: "PATCH",
    body: data,
    errorMessage: "更新人物失败",
  });

export const setPersonFavorite = async (
  personId: number,
  isFavorite: boolean
): Promise<void> =>
  apiFetch<void>(`/api/person/${personId}/favorite`, {
    method: "PATCH",
    body: { is_favorite: isFavorite },
    errorMessage: "更新收藏失败",
  });

export const deletePerson = async (personId: number) =>
  apiFetch<void>(`/api/person/${personId}`, {
    method: "DELETE",
    errorMessage: "删除人物失败",
  });

export const deletePersonsBulk = async (
  personIds: number[],
): Promise<DeletePersonsResult> =>
  apiFetch<DeletePersonsResult>("/api/person/bulk-delete", {
    method: "POST",
    body: { person_ids: personIds },
    errorMessage: "删除所选人物失败",
  });

export const mergePersons = async (sourceId: number, targetId: number) =>
  apiFetch<void>("/api/person/merge", {
    method: "POST",
    body: { source_id: sourceId, target_id: targetId },
    errorMessage: "合并人物失败",
  });

export const mergeMultiplePersons = async (
  targetId: number,
  sourceIds: number[]
): Promise<MergeResult> =>
  apiFetch<MergeResult>(`/api/person/${targetId}/merge-multiple`, {
    method: "POST",
    body: { source_ids: sourceIds },
    errorMessage: "合并选中的人物失败",
  });

export const autoMergeSimilarPersons = async (
  personId: number
): Promise<MergeResult> =>
  apiFetch<MergeResult>(`/api/person/${personId}/merge-similar`, {
    method: "POST",
    errorMessage: "自动合并相似人物失败",
  });

export const searchPersonsByName = async (
  name: string,
  signal?: AbortSignal
): Promise<Person[]> => {
  const data = await apiFetch<{ items: Person[] }>("/api/person/", {
    query: { name },
    errorMessage: "搜索人物失败",
    signal,
  });
  return data.items;
};

export const getSuggestedFaces = async (
  personId: number,
  limit: number = 100,
  signal?: AbortSignal
): Promise<FaceRead[]> =>
  cachedPersonData(`suggested:${personId}:${limit}`, () => apiFetch<FaceRead[]>(`/api/person/${personId}/suggest-faces`, {
    query: { limit },
    errorMessage: "获取建议人脸失败",
  }), signal);

export const getSimilarPersons = async (
  personId: number,
  signal?: AbortSignal
): Promise<SimilarPersonWithDetails[]> =>
  apiFetch<SimilarPersonWithDetails[]>(`/api/person/${personId}/similarities`, {
    errorMessage: "获取相似人物失败",
    signal,
  });

export const getPersonRelationshipGraph = async (
  personId: number,
  depth: number,
  maxNodes = 100,
  signal?: AbortSignal
): Promise<PersonRelationshipGraph> =>
  apiFetch<PersonRelationshipGraph>(
    `/api/person/${personId}/relationships`,
    {
      query: { depth, max_nodes: maxNodes },
      errorMessage: "获取人物关系图失败",
      signal,
    }
  );

export const getPersonFaces = async (
  personId: number,
  cursor: string | null,
  limit: number,
  sortBy: string = "id_desc",
  mediaId?: number,
  signal?: AbortSignal
): Promise<CursorPage<FaceRead>> =>
  apiFetch<CursorPage<FaceRead>>(`/api/person/${personId}/faces`, {
    query: { limit, sort_by: sortBy, cursor, media_id: mediaId },
    errorMessage: "获取人物人脸失败",
    signal,
  });

export const detachMediaFromPerson = async (
  personId: number,
  mediaId: number
): Promise<void> =>
  apiFetch<void>(`/api/person/${personId}/media/${mediaId}/detach`, {
    method: "POST",
    errorMessage: "从人物分离媒体文件失败",
  });

export const setProfileFace = async (faceId: number, personId: number) => {
  return updatePerson(personId, { profile_face_id: faceId });
};

export const autoSelectProfileFace = async (personId: number): Promise<Person> =>
  apiFetch<Person>(`/api/person/${personId}/profile_face/auto`, {
    method: "POST",
    errorMessage: "自动选择人物头像失败",
  });

export const addMediaAppearanceToPerson = async (
  personId: number,
  mediaId: number
): Promise<AddMediaAppearanceResult> =>
  apiFetch<AddMediaAppearanceResult>(`/api/person/${personId}/media`, {
    method: "POST",
    body: { media_id: mediaId },
    errorMessage: "添加媒体文件出现记录到人物失败",
  });
