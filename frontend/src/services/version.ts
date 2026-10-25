import { VersionUpdateInfo } from "../types";
import { apiFetch } from "./api";

export const getVersionUpdateInfo = async (
  signal?: AbortSignal
): Promise<VersionUpdateInfo> =>
  apiFetch<VersionUpdateInfo>("/api/version/update", {
    errorMessage: "获取更新信息失败",
    signal,
  });
