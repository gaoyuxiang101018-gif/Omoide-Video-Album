import { apiFetch } from "./api";
import type { CursorPage, FaceRead, MediaPreview, PersonReadSimple } from "../types";
import { acceptViewStamp,currentViewStamp,forCaller,personViewCache,PERSON_VIEWS_CHANGED,ViewStamp } from './personViewCache';

export interface PersonEvidence { faces: FaceRead[]; media: MediaPreview[]; }
export interface PersonMetrics { faceCount: number; videoCount: number; latestVideo?: string; }
export interface PeopleOverview extends ViewStamp { items:(PersonReadSimple & PersonMetrics)[]; cache_hit?:boolean; }
let statePromise:Promise<ViewStamp>|null=null, checkedAt=0;
if(typeof window!=='undefined')window.addEventListener(PERSON_VIEWS_CHANGED,()=>{statePromise=null;checkedAt=0;});
export async function getPersonCacheState(force=false):Promise<ViewStamp> {
  const saved=currentViewStamp();if(!force && saved && Date.now()-checkedAt<2000)return saved;
  if(!statePromise){
    const generation=personViewCache.generation;
    const request=apiFetch<ViewStamp>('/api/person/cache-state').then(value=>{if(generation!==personViewCache.generation)throw new DOMException('数据已更新','AbortError');acceptViewStamp(value);checkedAt=Date.now();return value;}).finally(()=>{if(statePromise===request)statePromise=null;});
    statePromise=request;
  }
  return statePromise;
}
const key=(stamp:ViewStamp,name:string)=>`${stamp.profile_key}:${stamp.revision}:${name}`;
export async function cachedPersonData<T>(name:string,loader:()=>Promise<T>,signal?:AbortSignal):Promise<T> {
  const stamp=await forCaller(getPersonCacheState(),signal);
  return forCaller(personViewCache.read(key(stamp,name),loader),signal);
}
export function peekPeopleOverview():PeopleOverview|undefined {const stamp=currentViewStamp();return stamp ? personViewCache.peek(key(stamp,'overview')) : undefined;}
export function peekPersonEvidence(id:number):PersonEvidence|undefined {const stamp=currentViewStamp();return stamp ? personViewCache.peek(key(stamp,`person:${id}`)) : undefined;}
async function viewRequest<T extends ViewStamp>(name:string,path:string,signal?:AbortSignal,force=false):Promise<T> {
  const stamp=await forCaller(getPersonCacheState(force),signal);
  const result=await forCaller(personViewCache.read<T>(key(stamp,name),()=>apiFetch<T>(path)),signal);
  if(result.profile_key!==stamp.profile_key)throw new DOMException('资料库已切换','AbortError');
  acceptViewStamp(result);personViewCache.put(key(result,name),result);return result;
}
export const getPeopleOverview=(signal?:AbortSignal,force=false)=>viewRequest<PeopleOverview>('overview','/api/person/overview',signal,force);
export interface FirstSeenPerson extends PersonReadSimple {
  first_date: string | null;
  first_media_id: number | null;
  first_filename: string | null;
  first_timestamp: number | null;
}
export interface FirstSeenOverview extends ViewStamp { items: FirstSeenPerson[]; cache_hit?: boolean; }
export function peekFirstSeenPeople():FirstSeenOverview|undefined {const stamp=currentViewStamp();return stamp?personViewCache.peek(key(stamp,'first-seen')):undefined;}
export const getFirstSeenPeople=(signal?:AbortSignal)=>viewRequest<FirstSeenOverview>('first-seen','/api/person/first-seen',signal);
export interface FirstAppearance {person_id:number;name?:string|null;thumbnail_path?:string|null;start:number;end:number;detections:number;}
export const getMediaFirstAppearances=(id:number,gap:number,signal?:AbortSignal)=>viewRequest<ViewStamp & {items:FirstAppearance[]}>(`first:${id}:${gap}`,`/api/person/first-appearances/${id}?gap=${gap}`,signal);

export function enrichEvidence(evidence: PersonEvidence, videoMetadata: MediaPreview[]): PersonEvidence {
  const index = new Map(videoMetadata.map(item => [item.id, item]));
  return { faces: evidence.faces, media: evidence.media.map(item => ({ ...item, ...index.get(item.id) })) };
}

export async function readAllPages<T>(fetchPage: (cursor: string | null) => Promise<CursorPage<T>>) {
  const all: T[] = [], seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await fetchPage(cursor);
    all.push(...page.items); cursor = page.next_cursor;
    if (cursor && seen.has(cursor)) throw new Error("分页数据重复，请刷新重试。");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return all;
}

export async function getPersonEvidence(personId: number, signal?: AbortSignal): Promise<PersonEvidence> {
  return viewRequest<ViewStamp & PersonEvidence>(`person:${personId}`,`/api/person/${personId}/evidence`,signal);
}

export const getAllPeople = (signal?: AbortSignal) => readAllPages(cursor => apiFetch<CursorPage<PersonReadSimple>>("/api/person/", { query: { cursor, limit: 200, sort: "newest" }, signal, errorMessage: "读取人物列表失败" }));

export function personMetrics(evidence: PersonEvidence): PersonMetrics {
  const videos = evidence.media.filter(item => typeof item.duration === "number");
  const dates = videos.map(item => item.created_at).filter((value): value is string => !!value && Number.isFinite(Date.parse(value))).sort((a, b) => Date.parse(b) - Date.parse(a));
  return { faceCount: evidence.faces.length, videoCount: videos.length, latestVideo: dates[0] };
}
