export const FILM_API = "http://127.0.0.1:18125";
export interface FilmVisibility { profile: string; data_dir: string; hidden_sources: string[]; }
export interface FilmMetadata { path: string; name: string; size: number; mtime_ns: number; category: string; camera: string; bit_depth: number | null; profile: string; manual_profile?: string | null; width: number; height: number; fps: number; evidence: string[]; status: string; error: string; }
export interface FilmItem { index: number; status: string; video: FilmMetadata; output: string; output_exists: boolean; error: string; }
export interface FilmJob { id: string; mode: string; output_dir: string; status: string; total: number; counts: Record<string, number>; items: FilmItem[]; created_at: number; error: string; }
export interface FilmStatus { profile: string; jobs: FilmJob[]; playback_token: string; busy_other_profile: boolean; resources?: { applied?: boolean; cpu_percent?: number; error?: string }; progress: { job_id?: string; current?: string; fraction?: number; eta_seconds?: number | null; stopping?: boolean; stage?: string }; analysis: { running: boolean; processed: number; total: number; current: string; error: string } | null; }
export interface FilmCapabilities { available: boolean; supported_output_modes: string[]; sdr_profiles: string[]; hdr_profiles: string[]; unavailable_reason?: string; }
export async function filmRequest<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try { response = await fetch(FILM_API + path, { signal, ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) }); }
  catch (error) { if (signal?.aborted) throw error; throw new Error("还原服务未连接。请通过桌面“Omoide 视频相册”快捷方式重新打开软件。"); }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "操作未完成，请重试。");
  return data;
}
export const TYPE_LABELS: Record<string, string> = { DLog: "D-Log 灰片", DLog2: "D-Log 2 灰片", DLogM: "D-Log M 灰片", HDR_HLG: "HDR · HLG", HDR_PQ: "HDR · PQ", Normal10: "普通 10-bit", Normal8: "普通 8-bit", Unknown: "模式待确认" };
export const PROFILE_LABELS: Record<string, string> = { dlog: "D-Log", dlog2: "D-Log 2", hlg: "HLG", rec709: "普通 Rec.709" };
export function filmLabel(item?: FilmMetadata | null) { return !item ? "尚未读取类型" : item.status === "error" ? "读取失败" : item.manual_profile ? `${PROFILE_LABELS[item.manual_profile]} · 手动确认` : TYPE_LABELS[item.category] || "模式待确认"; }
export const JOB_LABELS: Record<string,string> = { queued: "等待还原", running: "还原中", paused: "已暂停", completed: "已完成", succeeded: "已完成", failed: "失败" };
