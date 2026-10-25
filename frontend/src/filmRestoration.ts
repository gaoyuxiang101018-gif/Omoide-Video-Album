import { canonicalLibraryPath } from './albumUtils';
import type { MediaPathAlias } from './albumUtils';
import type { FilmItem, FilmJob } from './services/film';

export type RestorationFilter = 'all' | 'unrestored' | 'completed' | 'pending' | 'failed';
export interface RestorationEntry { job: FilmJob; item: FilmItem; }
export interface FilmRestoration {
  role: 'source' | 'output';
  kind: 'completed' | 'running' | 'queued' | 'paused' | 'failed';
  successes: RestorationEntry[];
  modes: string[];
  available?: RestorationEntry;
  pending?: RestorationEntry;
  needsVerification: boolean;
}
const pendingPriority: Record<string, number> = { running: 3, queued: 2, paused: 1 };
const outputMode = (mode: string) => mode === 'hlg' ? 'HDR' : mode === 'sdr' ? 'SDR' : mode;

function summarize(entries: RestorationEntry[], role: FilmRestoration['role']): FilmRestoration {
  const ordered = [...entries].sort((a, b) => b.job.created_at - a.job.created_at);
  const successes = ordered.filter(entry => entry.item.status === 'succeeded');
  const modes = [...new Set(successes.map(entry => outputMode(entry.job.mode)))].sort((a, b) => a === b ? 0 : a === 'SDR' ? -1 : b === 'SDR' ? 1 : a.localeCompare(b));
  const pending = ordered.filter(entry => pendingPriority[entry.item.status]).sort((a, b) => pendingPriority[b.item.status] - pendingPriority[a.item.status])[0];
  const available = successes.find(entry => entry.item.output_exists);
  return { role, successes, modes, pending, available,
    kind: successes.length ? 'completed' : pending ? pending.item.status as FilmRestoration['kind'] : 'failed',
    needsVerification: successes.length > 0 && !available };
}

export function indexFilmRestorations(jobs: FilmJob[], aliases: MediaPathAlias[] = []) {
  const sources = new Map<string, RestorationEntry[]>(), outputs = new Map<string, RestorationEntry[]>();
  for (const job of jobs) for (const item of job.items) {
    if (!item.video?.path || !['succeeded', 'running', 'queued', 'paused', 'failed'].includes(item.status)) continue;
    const entry = { job, item }, key = canonicalLibraryPath(item.video.path, aliases);
    sources.set(key, [...(sources.get(key) || []), entry]);
    if (item.status === 'succeeded' && item.output) {
      const outputKey = canonicalLibraryPath(item.output, aliases);
      outputs.set(outputKey, [...(outputs.get(outputKey) || []), entry]);
    }
  }
  const index = new Map<string, FilmRestoration>();
  for (const [key, entries] of outputs) index.set(key, summarize(entries, 'output'));
  for (const [key, entries] of sources) index.set(key, summarize(entries, 'source'));
  return index;
}

export function restorationLabel(value?: FilmRestoration) {
  if (!value) return '未还原';
  if (value.kind === 'completed') return `${value.role === 'output' ? '还原成片' : '已还原'}${value.modes.length ? ` · ${value.modes.join(' / ')}` : ''}`;
  return { running: '还原中', queued: '排队中', paused: '已暂停', failed: '还原失败' }[value.kind];
}

export function matchesRestoration(value: FilmRestoration | undefined, filter: RestorationFilter) {
  return filter === 'all' || (filter === 'completed' ? value?.kind === 'completed'
    : filter === 'unrestored' ? value?.kind !== 'completed'
    : filter === 'pending' ? !!value?.pending : value?.kind === 'failed');
}
export const canSelectUnrestored = (value?: FilmRestoration) => value?.kind !== 'completed' && !value?.pending;
