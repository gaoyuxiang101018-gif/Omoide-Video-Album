import type { FirstSeenPerson } from './services/personEvidence';

export function isCaptureDay(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export const captureDayCode = (date: string) => date.slice(2).replace(/-/g, '');
export function captureDayLabel(date: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', timeZone: 'UTC',
  }).format(new Date(`${date}T12:00:00Z`));
}

export function groupFirstSeenPeople(people: FirstSeenPerson[], query = '') {
  const search = query.trim().toLocaleLowerCase();
  const groups = new Map<string, FirstSeenPerson[]>();
  for (const person of people) {
    const date = isCaptureDay(person.first_date) ? person.first_date : '';
    const searchable = `${person.name || ''} ${person.id} ${date} ${date ? captureDayCode(date) : '日期未知'}`;
    if (search && !searchable.toLocaleLowerCase().includes(search)) continue;
    const group = groups.get(date) || [];
    group.push(person);
    groups.set(date, group);
  }
  return [...groups].sort(([a], [b]) => a ? b ? b.localeCompare(a) : -1 : b ? 1 : 0)
    .map(([date, items]) => ({ date, people: items.sort((a, b) => a.id - b.id) }));
}
