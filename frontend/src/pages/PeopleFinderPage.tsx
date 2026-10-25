import { withMediaCacheScope } from "../urlUtils";
import React, { useEffect, useMemo, useState,useRef } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Alert, Avatar, Box, Button, Checkbox,Chip, CircularProgress, Container, InputAdornment, LinearProgress, MenuItem, Stack, TextField, Typography } from "@mui/material";
import SearchIcon from "@mui/icons-material/Search";
import PersonOutlineIcon from "@mui/icons-material/PersonOutline";
import RefreshIcon from "@mui/icons-material/Refresh";
import MovieOutlinedIcon from "@mui/icons-material/MovieOutlined";
import {getPeopleOverview,peekPeopleOverview,PersonMetrics} from '../services/personEvidence';
import {invalidatePersonViews,PERSON_VIEWS_CHANGED} from '../services/personViewCache';
import MergePeopleDialog from '../components/MergePeopleDialog';
import { useVideoLibrary } from "../context/VideoLibraryContext";
import { comparePersonMetrics, PersonFinderSort } from "../appearanceSegments";
import { useLocalStoragePreference } from "../hooks/useLocalStoragePreference";
import { useTaskCompletionVersion } from "../TaskEventsContext";
import type { PersonReadSimple } from "../types";
import config,{ API } from "../config";
import { encodeFilePath } from "../urlUtils";
import { captureDate } from "../albumUtils";

const SORT_OPTIONS: { value: PersonFinderSort; label: string }[] = [
  { value: "face_count", label: "人脸次数最多" },
  { value: "latest_video", label: "最新视频出现优先" },
  { value: "video_count", label: "涉及视频最多" },
  { value: "newest", label: "最近新增人物" },
  { value: "name", label: "人物名称" },
];

export default function PeopleFinderPage() {
  const {profilePath}=useVideoLibrary();
  const [params, setParams] = useSearchParams();
  const initial=peekPeopleOverview();
  const [people, setPeople] = useState<PersonReadSimple[]>(()=>initial?.items??[]), [metrics, setMetrics] = useState<Record<number, PersonMetrics>>(()=>Object.fromEntries((initial?.items??[]).map(person=>[person.id,person])));
  const [loading, setLoading] = useState(!initial),[refreshing,setRefreshing]=useState(false), [error, setError] = useState("");
  const [revision, setRevision] = useState(0),[selected,setSelected]=useState(new Set<number>()),[selecting,setSelecting]=useState(false),[mergeOpen,setMergeOpen]=useState(false),[message,setMessage]=useState('');
  const lastProfile=useRef(profilePath);
  const search = params.get("q") || "";
  const setSearch = (value: string) => setParams(previous => { const next = new URLSearchParams(previous); if (value) next.set("q", value); else next.delete("q"); return next; }, { replace: true });
  const [namedOnly, setNamedOnly] = useState(false), [shown, setShown] = useState(60);
  const [sort, setSort] = useLocalStoragePreference<PersonFinderSort>("personFinderSort", SORT_OPTIONS.map(option => option.value), "face_count");
  const refreshKey = useTaskCompletionVersion(["process_media", "run_processor", "run_processor_for_media", "cluster_persons", "backfill_face_timestamps"]);
  useEffect(()=>{const changed=()=>setRevision(value=>value+1);window.addEventListener(PERSON_VIEWS_CHANGED,changed);return ()=>window.removeEventListener(PERSON_VIEWS_CHANGED,changed);},[]);
  useEffect(() => {
    if (!profilePath && !config.PRESENTATION_MODE) return;
    const controller = new AbortController(), signal = controller.signal;
    const saved=peekPeopleOverview();
    if(lastProfile.current!==profilePath){setPeople([]);setMetrics({});setSelected(new Set());setLoading(true);}
    else if(saved){setPeople(saved.items);setMetrics(Object.fromEntries(saved.items.map(person=>[person.id,person])));setLoading(false);}
    lastProfile.current=profilePath;setRefreshing(true);setError('');
    getPeopleOverview(signal).then(snapshot=>{if(!signal.aborted){setPeople(snapshot.items);setMetrics(Object.fromEntries(snapshot.items.map(person=>[person.id,person])));}})
      .catch(err=>{if(!signal.aborted && err.name!=='AbortError')setError(err instanceof Error?err.message:'读取人物失败');})
      .finally(()=>{if(!signal.aborted){setLoading(false);setRefreshing(false);}});
    return () => controller.abort();
  }, [revision, refreshKey,profilePath]);
  useEffect(()=>{const ids=new Set(people.map(person=>person.id));setSelected(previous=>new Set([...previous].filter(id=>ids.has(id))));},[people]);
  const selectedPeople=useMemo(()=>people.filter(person=>selected.has(person.id)),[people,selected]);
  const sorted = useMemo(() => people.filter(person => (!namedOnly || !!person.name?.trim()) && `${person.name || ""} ${person.id}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(person => ({ ...person, ...metrics[person.id] })).sort((a, b) => {
    if (sort !== "name" && sort !== "newest" && !loading) {
      const missing = Number(!metrics[a.id]) - Number(!metrics[b.id]);
      if (missing) return missing;
    }
    return comparePersonMetrics(a, b, loading ? "newest" : sort);
  }), [people, search, namedOnly, metrics, loading, sort]);
  useEffect(() => setShown(60), [sort, search, namedOnly]);
  return <Container maxWidth={false} sx={{ px: { xs: 2, md: 4 }, py: 3.5 }}>
    <Stack direction="row" justifyContent="space-between" alignItems="flex-start" gap={2} mb={3}>
      <Box><Typography variant="h4" component="h1">人物检索</Typography><Typography variant="body2" color="text.secondary" mt={0.8}>找到一个人，回看他在视频中出现的时间段。</Typography></Box>
      <Stack direction="row" gap={1} flexWrap="wrap" justifyContent="flex-end"><Button onClick={()=>{setSelecting(value=>!value);setSelected(new Set());}}>{selecting?'取消选择':'选择合并'}</Button>{selecting&&<Button variant="contained" disabled={selected.size<2} onClick={()=>setMergeOpen(true)}>合并所选（{selected.size}）</Button>}<Button aria-label="刷新人物统计" startIcon={<RefreshIcon />} onClick={invalidatePersonViews} disabled={loading||refreshing}>刷新</Button><Button component={Link} to="/videos" variant="outlined" startIcon={<MovieOutlinedIcon />}>识别视频</Button></Stack>
    </Stack>
    <Stack direction={{ xs: "column", sm: "row" }} alignItems={{ sm: "center" }} gap={1.5} mb={2.5}>
      <TextField value={search} onChange={e => setSearch(e.target.value)} size="small" placeholder="搜索姓名或人物编号" inputProps={{ "aria-label": "搜索人物" }} slotProps={{ input: { startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> } }} sx={{ width: { xs: "100%", sm: 300 } }} />
      <TextField select size="small" label="人物排序" value={sort} onChange={e => setSort(e.target.value as PersonFinderSort)} sx={{ minWidth: 190 }}>{SORT_OPTIONS.map(option => <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>)}</TextField>
      <Chip clickable variant={namedOnly ? "filled" : "outlined"} color={namedOnly ? "primary" : "default"} label="只看已命名" onClick={() => setNamedOnly(v => !v)} sx={{ alignSelf: { xs: "flex-start", sm: "auto" } }} />
      <Box sx={{ flex: 1 }} /><Typography variant="body2" color="text.secondary">{sorted.length} 个人物</Typography>
      {!!people.length && <Button component={Link} to="/people/manage" color="inherit">批量管理</Button>}
    </Stack>
    {(loading||refreshing) && <Box mb={2}><Typography variant="caption" color="text.secondary">{people.length?'正在后台更新人物…':'正在读取人物…'}</Typography><LinearProgress sx={{mt:.5}}/></Box>}
    {!loading&&!error&&<Chip size="small" variant="outlined" label="已缓存 · 识别或合并后自动更新" sx={{mb:2}}/>}
    {!!message&&<Alert severity="info" onClose={()=>setMessage('')} sx={{mb:2}}>{message}</Alert>}
    {error && <Alert severity="error" action={<Button onClick={() => setRevision(v => v + 1)}>重试</Button>}>{error}</Alert>}
    {!loading && !error && !sorted.length && <Box sx={{ textAlign: "center", bgcolor: "background.paper", border: "1px solid", borderColor: "divider", borderRadius: 1.5, py: 9 }}><PersonOutlineIcon sx={{ fontSize: 52, color: "text.disabled", mb: 2 }} /><Typography variant="h6">{people.length ? "没有找到这个人物" : "先识别视频，建立人物库"}</Typography><Typography variant="body2" color="text.secondary" mt={1}>{people.length ? "换一个名称、编号，或关闭“只看已命名”。" : "在视频页选择文件开始识别，完成后会自动归类人物。"}</Typography><Button component={Link} to="/videos" variant="contained" sx={{ mt: 3 }}>前往视频资料库</Button></Box>}
    <Box sx={{ display: "grid", gridTemplateColumns: { xs: "repeat(2, minmax(0, 1fr))", sm: "repeat(auto-fill, minmax(176px, 1fr))" }, gap: 2 }}>
      {sorted.slice(0, shown).map(person => <Box key={person.id} data-person-id={person.id} sx={{position:'relative',display: "block", color: "text.primary", bgcolor: "background.paper", border: "1px solid", borderColor:selected.has(person.id)?'primary.main':"divider", borderRadius: 1.5, overflow: "hidden", transition: "box-shadow 150ms", "&:hover": { boxShadow: "0 4px 16px #243A5A12", borderColor: "primary.main" } }}>
        {selecting&&<Checkbox checked={selected.has(person.id)} inputProps={{'aria-label':`选择${person.name||`未命名人物 ${person.id}`}`}} onChange={(_,checked)=>setSelected(previous=>{const next=new Set(previous);if(checked)next.add(person.id);else next.delete(person.id);return next;})} sx={{position:'absolute',top:6,left:6,zIndex:1,bgcolor:'background.paper',p:.4,borderRadius:.7}}/>}
        <Box component={Link} to={`/person/${person.id}`} sx={{display:'block',textDecoration:'none',color:'inherit'}}>
        <Avatar variant="square" src={person.profile_face?.thumbnail_path ? withMediaCacheScope(`${API}/thumbnails/${encodeFilePath(person.profile_face.thumbnail_path)}`) : undefined} alt={person.name || `人物 ${person.id}`} sx={{ width: "100%", height: "auto", aspectRatio: "1", bgcolor: "action.hover", color: "text.disabled" }}><PersonOutlineIcon sx={{ fontSize: 52 }} /></Avatar>
        <Box sx={{ p: 1.5 }}><Typography fontWeight={600} noWrap title={person.name || `未命名人物 ${person.id}`}>{person.name || `未命名人物 ${person.id}`}</Typography><Typography variant="caption" color="text.secondary" display="block" mt={0.7}>{metrics[person.id] ? `${person.faceCount} 次人脸 · ${person.videoCount} 个视频` : loading ? "统计中…" : "统计暂不可用"}</Typography><Typography variant="caption" color="text.secondary" display="block" mt={0.3}>{person.latestVideo ? `最近 ${captureDate(person.latestVideo)}` : loading ? " " : "暂无视频记录"}</Typography><Typography variant="caption" color="primary.main" display="block" mt={1.2}>查看出现片段 →</Typography></Box>
        </Box>
      </Box>)}
    </Box>
    {sorted.length > shown && <Box textAlign="center" mt={3}><Button variant="outlined" onClick={() => setShown(value => value + 60)}>显示更多人物（还有 {sorted.length - shown} 个）</Button></Box>}
    {loading && !people.length && <Box textAlign="center" py={4}><CircularProgress size={24} /></Box>}
    {!!people.length && <Typography variant="caption" display="block" color="text.secondary" mt={2.5}>人脸次数指检测到的人脸记录数；同一视频中的连续画面会计为多次，出现片段会在人物页合并。</Typography>}
    <MergePeopleDialog open={mergeOpen} people={selectedPeople} onClose={()=>setMergeOpen(false)} onMerged={(_,result)=>{setMergeOpen(false);setSelected(new Set());setSelecting(false);setMessage(`已合入 ${result.merged_ids.length} 个人物${result.skipped_ids.length?`，另有 ${result.skipped_ids.length} 个未合并，请刷新检查`:''}。`);}}/>
  </Container>;
}
