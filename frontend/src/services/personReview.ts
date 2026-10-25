import {apiFetch} from './api';
import {MediaPreview} from '../types';
export interface ReviewRange {media_id:number;start:number;end:number;source_person_id:number|null;}
export interface RangePreview {profile_key:string;fingerprint:string;face_count:number;source_label:string;faces:{id:number;timestamp:number;thumbnail_path:string|null}[];}
export interface TimelineSegment {start:number;end:number;detections:number;thumbnail_path:string|null;}
export interface TimelinePerson {id:number|null;name:string|null;thumbnail_path:string|null;face_count:number;segments:TimelineSegment[];}
export interface FaceTimelineData {media:MediaPreview;items:TimelinePerson[];}
export interface Refinement {id:string;task_id:string;filename:string;media_id:number;start:number;end:number;interval:number;status:string;total:number;processed:number;added:number;matched:number;duplicates:number;error:string|null;}
export const reviewLabel=(p:{id:number|null;name?:string|null})=>p.id===null?'待确认人脸':p.name?.trim()||`未命名人物 #${p.id}`;
export const reviewPreview=(body:ReviewRange)=>apiFetch<RangePreview>('/api/person/review/preview',{method:'POST',body});
export const correctRange=(body:ReviewRange & {profile_key:string;fingerprint:string;mode:string;target_person_id:number|null})=>apiFetch<{face_count:number;target_person_id:number|null}>('/api/person/review/correct',{method:'POST',body});
export const loadTimeline=(id:number,signal?:AbortSignal)=>apiFetch<FaceTimelineData>(`/api/person/review/timeline/${id}`,{signal});
export const refineRange=(body:{media_id:number;start:number;end:number;interval:number;profile_key:string})=>apiFetch<Refinement>('/api/person/review/refinements',{method:'POST',body});
export const loadRefinements=()=>apiFetch<{items:Refinement[]}>('/api/person/review/refinements');
export const cancelRefinement=(id:string)=>apiFetch(`/api/person/review/refinements/${id}/cancel`,{method:'POST'});
export function parseVideoTime(input:string):number|null {
  const parts=input.trim().split(':');if(parts.length>3||parts.some(p=>!/^\d+(\.\d+)?$/.test(p)))return null;
  if(parts.length>1&&parts.slice(0,-1).some(p=>!/^\d+$/.test(p)))return null;
  if(parts.slice(1).some(p=>Number(p)>=60))return null;
  const seconds=parts.reduce((total,p)=>total*60+Number(p),0);return Number.isFinite(seconds)?seconds:null;
}
export function preciseTime(seconds:number):string {const ms=Math.max(0,Math.round(seconds*1000)),hours=Math.floor(ms/3600000),minutes=Math.floor(ms%3600000/60000),tail=ms%60000;const last=String(Math.floor(tail/1000)).padStart(2,'0')+(tail%1000?'.'+String(tail%1000).padStart(3,'0').replace(/0+$/,''):'');return `${hours?`${hours}:`:''}${hours?String(minutes).padStart(2,'0'):minutes}:${last}`;}
