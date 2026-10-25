import React, { createContext, useContext, useEffect, useState } from "react";
import { apiFetch } from "../services/api";
import type { Task } from "../types";

export interface HistoricalTask extends Task {
  created_at?: string; started_at?: string; finished_at?: string;
  frame_current?: number; frame_total?: number; video_second?: number; video_duration?: number;
  updated_at_epoch?: number; fatal_error?: string; last_error?: string; last_error_path?: string;
  item_counts?: Record<string,number>;
}
interface TaskHistory { tasks: HistoricalTask[]; loading: boolean; error: string; updatedAt: number; refresh: () => void; }
const Context = createContext<TaskHistory | null>(null);
export function TaskHistoryProvider({ children }: { children: React.ReactNode }) {
  const [tasks,setTasks] = useState<HistoricalTask[]>([]), [loading,setLoading] = useState(true), [error,setError] = useState("");
  const [updatedAt,setUpdatedAt] = useState(0), [revision,setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); let timer: number;
    const poll = async () => {
      let active = false;
      try {
        const result = await apiFetch<{items:HistoricalTask[]}>("/api/tasks/history",{query:{limit:100},signal:controller.signal,errorMessage:"无法读取识别进度。后台可能已关闭，或尚未加载更新后的程序。"});
        if (controller.signal.aborted) return;
        setTasks(result.items); setError("");setUpdatedAt(Date.now());
        active = result.items.some(task=>["running","pending"].includes(task.status));
      } catch (err) { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "读取进度失败。"); }
      if (!controller.signal.aborted) { setLoading(false); timer=window.setTimeout(poll,active?2000:5000); }
    };
    poll();return()=>{controller.abort();window.clearTimeout(timer);};
  },[revision]);
  return <Context.Provider value={{tasks,loading,error,updatedAt,refresh:()=>setRevision(value=>value+1)}}>{children}</Context.Provider>;
}
export function useTaskHistory() { const value=useContext(Context);if(!value)throw new Error("TaskHistoryProvider missing");return value; }
export const TASK_NAMES: Record<string,string> = {export_person_clips:"导出人物片段",scan:"扫描文件夹",process_media:"识别未处理文件",run_processor:"运行识别模块",run_processor_for_media:"识别所选视频",cluster_persons:"人物自动归类",backfill_face_timestamps:"补齐人脸时间戳",backfill_face_quality:"更新人脸质量",find_duplicates:"查找重复项",compute_blur_scores:"画面清晰度评分",clean_missing_files:"检查缺失记录"};
export const STEP_NAMES: Record<string,string> = {export_person_clips:"剪辑与合成片段",preparing:"准备任务",checking_source:"检查原片与网络盘",extracting_scenes:"读取视频画面",extracting_frames:"提取视频画面",loading_model:"加载模型",faces:"检测与识别人脸",exif:"读取视频信息",blur:"评估清晰度",embedding_extractor:"提取画面特征",auto_tagger:"整理画面标签",idle:"保存本视频结果",error:"记录失败项",finished:"任务结束",clustering_batch:"人物自动归类",clustering_unassigned:"归类待确认人脸",matching_known_persons:"匹配已有人物",merging_similar_persons:"合并相似人物"};
export function taskStatus(task: HistoricalTask) {
  if (task.status==="completed") return task.failure_count ? "已结束，有失败项" : "已完成";
  return {pending:"排队中",running:"处理中",failed:"异常中断",cancelled:"已停止"}[task.status] || task.status;
}
TASK_NAMES.refine_face_range='局部人脸精查';
STEP_NAMES.refine_face_range='密集取帧与识别';
export function taskPercent(task: HistoricalTask) { return task.total>0 ? Math.min(100,Math.max(0,Math.round(task.processed/task.total*100))) : null; }
export const isRecognitionTask = (task: HistoricalTask) => ["process_media","run_processor","run_processor_for_media","cluster_persons","backfill_face_quality","backfill_face_timestamps"].includes(task.task_type);
