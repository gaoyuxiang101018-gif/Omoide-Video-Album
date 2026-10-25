import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Alert, Avatar, Box, Button, Container, InputAdornment, LinearProgress, Stack, TextField, Typography } from '@mui/material';
import PersonOutlineIcon from '@mui/icons-material/PersonOutline';
import RefreshIcon from '@mui/icons-material/Refresh';
import SearchIcon from '@mui/icons-material/Search';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import { API } from '../config';
import config from '../config';
import { useVideoLibrary } from '../context/VideoLibraryContext';
import { getFirstSeenPeople, peekFirstSeenPeople, FirstSeenPerson } from '../services/personEvidence';
import { invalidatePersonViews, PERSON_VIEWS_CHANGED } from '../services/personViewCache';
import { captureDayCode, captureDayLabel, groupFirstSeenPeople } from '../firstSeenPeople';
import { encodeFilePath, withMediaCacheScope } from '../urlUtils';
import { formatVideoDuration } from '../albumUtils';
import { useTaskCompletionVersion } from '../TaskEventsContext';

export default function FirstSeenPeoplePage() {
  const { profilePath } = useVideoLibrary();
  const initial = peekFirstSeenPeople();
  const [people, setPeople] = useState<FirstSeenPerson[]>(initial?.items || []);
  const [loading, setLoading] = useState(!initial);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [params, setParams] = useSearchParams();
  const lastProfile = useRef(profilePath);
  const query = params.get('q') || '';
  const taskVersion = useTaskCompletionVersion(['process_media', 'run_processor', 'run_processor_for_media', 'cluster_persons', 'backfill_face_timestamps']);

  useEffect(() => {
    const changed = () => setRevision(value => value + 1);
    window.addEventListener(PERSON_VIEWS_CHANGED, changed);
    return () => window.removeEventListener(PERSON_VIEWS_CHANGED, changed);
  }, []);
  useEffect(() => {
    if (!profilePath && !config.PRESENTATION_MODE) return;
    const controller = new AbortController();
    const saved = peekFirstSeenPeople();
    if (lastProfile.current !== profilePath) { setPeople([]); setLoading(true); }
    else if (saved) { setPeople(saved.items); setLoading(false); }
    lastProfile.current = profilePath;
    setRefreshing(true); setError('');
    getFirstSeenPeople(controller.signal).then(value => {
      if (!controller.signal.aborted) setPeople(value.items);
    }).catch(err => {
      if (!controller.signal.aborted && err.name !== 'AbortError') setError(err instanceof Error ? err.message : '读取首次出现日期失败');
    }).finally(() => {
      if (!controller.signal.aborted) { setLoading(false); setRefreshing(false); }
    });
    return () => controller.abort();
  }, [profilePath, taskVersion, revision]);

  const groups = useMemo(() => groupFirstSeenPeople(people, query), [people, query]);
  const count = groups.reduce((total, group) => total + group.people.length, 0);
  return <Container maxWidth={false} sx={{ px: { xs: 2, md: 4 }, py: 3.5 }}>
    <Stack direction="row" justifyContent="space-between" alignItems="flex-start" gap={2} mb={3}>
      <Box><Typography variant="h4" component="h1">首次出现</Typography>
        <Typography variant="body2" color="text.secondary" mt={0.8}>按已识别视频的最早拍摄日期分组，每个人只出现一次，新日期在上。</Typography></Box>
      <Button startIcon={<RefreshIcon />} onClick={invalidatePersonViews} disabled={loading || refreshing} sx={{ flexShrink: 0 }}>刷新</Button>
    </Stack>
    <Stack direction={{ xs: 'column', sm: 'row' }} alignItems={{ sm: 'center' }} gap={1.5} mb={3}>
      <TextField size="small" placeholder="姓名、编号或日期（如 261020）" value={query}
        onChange={event => setParams(previous => { const next = new URLSearchParams(previous); if (event.target.value) next.set('q', event.target.value); else next.delete('q'); return next; }, { replace: true })}
        inputProps={{ 'aria-label': '搜索首次出现人物或日期' }}
        slotProps={{ input: { startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> } }}
        sx={{ width: { xs: '100%', sm: 340 } }} />
      <Typography variant="body2" color="text.secondary" sx={{ ml: { sm: 'auto' } }}>{count} 个人物 · {groups.filter(group => group.date).length} 个日期</Typography>
      <Button component={Link} to="/people" color="inherit">人物检索与合并</Button>
    </Stack>
    {(loading || refreshing) && <LinearProgress aria-label="读取首次出现相册" sx={{ mb: 3 }} />}
    {error && <Alert severity="error" action={<Button onClick={invalidatePersonViews}>重试</Button>} sx={{ mb: 3 }}>{error}</Alert>}
    {!loading && !error && !groups.length && <Box sx={{ textAlign: 'center', py: 8 }}>
      <PersonOutlineIcon sx={{ fontSize: 48, color: 'text.disabled', mb: 2 }} />
      <Typography variant="h6">{people.length ? '没有匹配的人物或日期' : '识别视频后，人物会按首次出现日期显示在这里'}</Typography>
      <Typography variant="body2" color="text.secondary" mt={1}>{people.length ? '试试姓名、人物编号或六位日期，例如 261020。' : '最早日期来自视频的拍摄信息。'}</Typography>
      {!people.length && <Button component={Link} to="/videos" sx={{ mt: 2 }}>前往视频资料库</Button>}
    </Box>}
    {groups.map(group => <Box component="section" key={group.date || 'unknown'} aria-label={group.date ? `${captureDayCode(group.date)}首次出现的人物` : '日期未知的人物'} sx={{ mb: 5 }}>
      <Stack direction="row" alignItems="baseline" flexWrap="wrap" gap={1.5} sx={{ mb: 1.8, pb: 1.2, borderBottom: 1, borderColor: 'divider' }}>
        <Typography component="h2" sx={{ fontFamily: group.date ? 'Consolas, monospace' : 'inherit', fontWeight: 650, fontSize: { xs: 23, sm: 27 }, color: group.date ? 'primary.main' : 'text.secondary', m: 0 }}>{group.date ? captureDayCode(group.date) : '日期未知'}</Typography>
        <Typography variant="body2" color="text.secondary">{group.date ? captureDayLabel(group.date) : '没有可用的视频拍摄日期'}</Typography>
        <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>{group.people.length} 个人物</Typography>
      </Stack>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(auto-fill, minmax(154px, 1fr))' }, gap: { xs: 1.5, md: 2 } }}>
        {group.people.map(person => <Box key={person.id} data-first-seen-person={person.id} sx={{ minWidth: 0 }}>
          <Box component={Link} to={`/person/${person.id}`} sx={{ display: 'block', textDecoration: 'none', color: 'text.primary', borderRadius: 1, '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 3 } }}>
            <Avatar variant="rounded" src={person.profile_face?.thumbnail_path ? withMediaCacheScope(`${API}/thumbnails/${encodeFilePath(person.profile_face.thumbnail_path)}`) : undefined}
              alt={person.name || `未命名人物 ${person.id}`} slotProps={{ img: { loading: 'lazy', decoding: 'async' } }}
              sx={{ width: '100%', height: 'auto', aspectRatio: '1', bgcolor: 'action.hover', color: 'text.disabled', mb: 1 }}><PersonOutlineIcon sx={{ fontSize: 48 }} /></Avatar>
            <Typography fontWeight={600} noWrap title={person.name || `未命名人物 ${person.id}`}>{person.name || `未命名人物 ${person.id}`}</Typography>
          </Box>
          {person.first_media_id ? <Button component={Link} to={`/medium/${person.first_media_id}`} size="small" startIcon={<PlayArrowIcon />} title={person.first_filename || '首次出现的视频'} sx={{ px: 0, minWidth: 0, fontSize: 12 }}>首次视频{person.first_timestamp !== null ? ` · ${formatVideoDuration(person.first_timestamp)}` : ''}</Button>
            : <Typography variant="caption" color="text.secondary">暂无视频记录</Typography>}
        </Box>)}
      </Box>
    </Box>)}
  </Container>;
}
