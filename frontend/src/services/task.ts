import { Task } from "../types";
import { apiFetch } from "./api";

export const getTask = async (
  task_id: string,
  signal?: AbortSignal
): Promise<Task> =>
  apiFetch<Task>(`/api/tasks/${task_id}`, {
    errorMessage: "获取任务失败",
    signal,
  });
