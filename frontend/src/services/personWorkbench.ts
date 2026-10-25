import { apiFetch } from './api';
import { MediaPreview } from '../types';
export interface Clip { key:string; start:number; end:number; detections:number; media:MediaPreview; }
export interface ClipPlan { profile_key:string; revision:string; person_id:number; with_person_id:number|null; gap:number; clips:Clip[]; }
export interface ClipExport { id:string; task_id:string; created_at:string; person_id:number; with_person_id:number|null; status:string; total:number; processed:number; output_dir:string; result_path:string|null; error:string|null; }
export interface MergeEntry { id:string; source_id:number; target_id:number; source_name:string|null; target_name:string|null; created_at:string; face_count:number; can_undo:boolean; reason:string|null; undone_at:string|null; restored_id:number|null; }
export const loadClips=(person_id:number,with_person_id:number|null,gap:number,signal?:AbortSignal)=>apiFetch<ClipPlan>('/api/person/tools/segments',{query:{person_id,with_person_id,gap},signal});
export const loadExports=()=>apiFetch<{items:ClipExport[];default_output_dir:string}>('/api/person/tools/exports');
export const exportClips=(plan:ClipPlan,clip_keys:string[],before:number,after:number,output_dir:string,resolution:string)=>apiFetch<ClipExport>('/api/person/tools/exports',{method:'POST',body:{person_id:plan.person_id,with_person_id:plan.with_person_id,gap:plan.gap,profile_key:plan.profile_key,revision:plan.revision,clip_keys,before,after,output_dir,resolution}});
export const cancelExport=(id:string)=>apiFetch(`/api/person/tools/exports/${id}/cancel`,{method:'POST'});
export const loadMergeHistory=()=>apiFetch<{items:MergeEntry[];scope:string}>('/api/person/tools/merge-history');
export const undoMerge=(id:string)=>apiFetch<{restored_id:number;target_id:number;face_count:number}>(`/api/person/tools/merge-history/${id}/undo`,{method:'POST'});
export function clipBounds(clip:Clip,before:number,after:number):[number,number] {
  const duration=clip.media.duration??0;
  let start=Math.max(0,clip.start-before),end=Math.min(duration,clip.end+after);
  if(end-start<.5){end=Math.min(duration,start+.5);start=Math.max(0,end-.5);}
  return [start,end];
}
