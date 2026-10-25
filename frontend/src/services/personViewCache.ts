import { setMediaCacheScope } from '../urlUtils';

export interface ViewStamp { profile_key: string; revision: string; }
export const PERSON_VIEWS_CHANGED = 'person-views-changed';
export class ViewCache {
  private values = new Map<string, {value: unknown; size: number; at: number}>();
  private pending = new Map<string, Promise<unknown>>();
  private bytes = 0;
  generation = 0;
  constructor(private maxBytes = 24 * 1024 * 1024, private ttl = 5 * 60 * 1000) {}
  peek<T>(key: string): T | undefined {
    const item=this.values.get(key);
    if (!item) return;
    if (Date.now()-item.at>this.ttl) {this.values.delete(key);this.bytes-=item.size;return;}
    this.values.delete(key);this.values.set(key,item);return item.value as T;
  }
  put<T>(key:string,value:T) {
    const size=JSON.stringify(value).length*2;
    const old=this.values.get(key);if(old)this.bytes-=old.size;
    this.values.delete(key);
    if(size>this.maxBytes)return;
    this.values.set(key,{value,size,at:Date.now()});this.bytes+=size;
    while(this.bytes>this.maxBytes) {const first=this.values.entries().next().value!;this.values.delete(first[0]);this.bytes-=first[1].size;}
  }
  read<T>(key:string,loader:()=>Promise<T>):Promise<T> {
    const saved=this.peek<T>(key);if(saved!==undefined)return Promise.resolve(saved);
    const current=this.pending.get(key);if(current)return current as Promise<T>;
    const generation=this.generation;
    const request=loader().then(value=>{if(generation!==this.generation)throw new DOMException('数据已更新','AbortError');this.put(key,value);return value;}).finally(()=>{if(this.pending.get(key)===request)this.pending.delete(key);});
    this.pending.set(key,request);return request;
  }
  clear() {this.generation++;this.values.clear();this.pending.clear();this.bytes=0;}
}
export const personViewCache=new ViewCache();
let stamp:ViewStamp|null=null;
export const currentViewStamp=()=>stamp;
export function acceptViewStamp(next:ViewStamp) {
  if(stamp && (stamp.profile_key!==next.profile_key || stamp.revision!==next.revision)) personViewCache.clear();
  stamp=next;setMediaCacheScope(next.profile_key);
}
export function invalidatePersonViews() {
  personViewCache.clear();stamp=null;
  if(typeof window!=='undefined')window.dispatchEvent(new Event(PERSON_VIEWS_CHANGED));
}
export function forCaller<T>(request:Promise<T>,signal?:AbortSignal):Promise<T> {
  if(!signal)return request;
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(new DOMException('Aborted','AbortError'));
    if(signal.aborted){request.catch(()=>{});abort();return;}
    signal.addEventListener('abort',abort,{once:true});
    request.then(value=>{signal.removeEventListener('abort',abort);if(!signal.aborted)resolve(value);},error=>{signal.removeEventListener('abort',abort);if(!signal.aborted)reject(error);});
  });
}
