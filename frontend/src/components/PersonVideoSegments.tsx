import { withMediaCacheScope } from "../urlUtils";
import React, { useEffect, useMemo, useState,useRef } from "react";
import { Alert, Box, Button, Chip, CircularProgress, Dialog, DialogContent, DialogTitle, IconButton, MenuItem, Stack, TextField, Typography,Tabs,Tab,Table,TableBody,TableCell,TableContainer,TableHead,TableRow } from "@mui/material";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import DownloadIcon from "@mui/icons-material/Download";
import CloseIcon from "@mui/icons-material/Close";
import RefreshIcon from "@mui/icons-material/Refresh";
import { Link } from "react-router-dom";
import type { MediaPreview, Person } from "../types";
import { API } from "../config";
import { encodeFilePath } from "../urlUtils";
import { getPersonEvidence, PersonEvidence,peekPersonEvidence } from "../services/personEvidence";
import {invalidatePersonViews,PERSON_VIEWS_CHANGED} from '../services/personViewCache';
import { AppearanceSegment, getVideoAppearances } from "../appearanceSegments";
import { captureDate, formatVideoDuration } from "../albumUtils";
import { VideoWithPreview } from "./VideoPlayer";
import { useTaskCompletionVersion } from "../TaskEventsContext";
import { useLocalStorageNumber,useLocalStoragePreference } from "../hooks/useLocalStoragePreference";
import PersonClipWorkbench from './PersonClipWorkbench';

export default function PersonVideoSegments({ person }: { person: Person }) {
  const [workbench,setWorkbench]=useState(false);
  const initial=peekPersonEvidence(person.id);
  const [evidence, setEvidence] = useState<PersonEvidence>(()=>initial??{ faces: [], media: [] });
  const [loading, setLoading] = useState(!initial), [error, setError] = useState("");
  const lastPerson=useRef(person.id);
  const [revision, setRevision] = useState(0), [search, setSearch] = useState("");
  const [gap, setGap] = useLocalStorageNumber("personSegmentGap", 4, { min: 0, max: 10 });
  const [sort, setSort] = useState("latest");
  const [view,setView]=useLocalStoragePreference('personSegmentView',['first','segments'] as const,'first');
  const [player, setPlayer] = useState<{ media: MediaPreview; segment: AppearanceSegment; seq: number } | null>(null);
  const refreshKey = useTaskCompletionVersion(["process_media", "run_processor_for_media", "cluster_persons", "backfill_face_timestamps"]);
  useEffect(()=>{const changed=()=>setRevision(value=>value+1);window.addEventListener(PERSON_VIEWS_CHANGED,changed);return ()=>window.removeEventListener(PERSON_VIEWS_CHANGED,changed);},[]);
  useEffect(() => {
    const controller = new AbortController();
    const cached=peekPersonEvidence(person.id);
    if(lastPerson.current!==person.id){setEvidence(cached??{faces:[],media:[]});setLoading(!cached);}
    else if(cached){setEvidence(cached);setLoading(false);}
    lastPerson.current=person.id;setError('');
    getPersonEvidence(person.id, controller.signal).then(result => {
      if (!controller.signal.aborted) setEvidence(result);
    }).catch(err => { if (!controller.signal.aborted && err.name!=='AbortError') setError(err instanceof Error ? err.message : "读取时间段失败"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [person.id, revision, refreshKey]);
  const appearances = useMemo(() => getVideoAppearances(evidence.media, evidence.faces, gap), [evidence, gap]);
  const visible = useMemo(() => appearances.filter(item => `${item.media.filename} ${item.media.path}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())).sort((a, b) => {
    if (sort === "segments") return b.segments.length - a.segments.length || b.media.id - a.media.id;
    if (sort === "detections") return b.faceCount - a.faceCount || b.media.id - a.media.id;
    return (Date.parse(b.media.created_at ?? "") || 0) - (Date.parse(a.media.created_at ?? "") || 0) || b.media.id - a.media.id;
  }), [appearances, search, sort]);
  const segmentCount = appearances.reduce((sum, item) => sum + item.segments.length, 0);
  const play = (media: MediaPreview, segment: AppearanceSegment) => setPlayer(previous => ({ media, segment, seq: (previous?.seq ?? 0) + 1 }));
  const exportCsv = () => {
    const cell = (value: unknown) => {
      let text = String(value ?? "");
      if (/^[=+@\-\t\r]/.test(text)) text = "'" + text;
      return '"' + text.replace(/"/g, '""') + '"';
    };
    const rows: unknown[][] = [["人物", "视频", "文件路径", "开始秒数", "结束秒数", "开始时间", "结束时间", "人脸检测次数", "说明"]];
    for (const item of visible) {
      for (const segment of (view==='first'?item.segments.slice(0,1):item.segments)) rows.push([person.name || `人物${person.id}`, item.media.filename, item.media.path, segment.start, segment.end, formatVideoDuration(segment.start), formatVideoDuration(segment.end), segment.detections, `${view==='first'?'首次出现；':''}采样检测；相邻检测间隔不超过${gap}秒归为一段`]);
      if (!item.segments.length) rows.push([person.name || `人物${person.id}`, item.media.filename, item.media.path, "", "", "", "", item.faceCount, "没有有效时间戳"]);
    }
    const blob = new Blob(["\uFEFF" + rows.map(row => row.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url; link.download = `人物${person.id}-出现时间段.csv`; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <Box>
    <Stack direction="row" spacing={1} mb={2}><Button variant="contained" startIcon={<PlayArrowIcon/>} onClick={()=>setWorkbench(true)}>片段连播 / 导出 / 同框</Button><Button component={Link} to="/merge-history">合并记录</Button></Stack>
    {workbench&&<PersonClipWorkbench person={person} onClose={()=>setWorkbench(false)}/>}
    <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" alignItems={{ xs: "stretch", sm: "center" }} gap={2} mb={2}>
      <Box><Typography variant="h6">出现在哪些视频、什么时间</Typography><Typography variant="body2" color="text.secondary" mt={0.5}>{loading ? "正在读取检测记录…" : `${appearances.length} 个视频 · ${segmentCount} 个检测片段`}</Typography></Box>
      <Stack direction="row" spacing={1}><Button startIcon={<RefreshIcon />} onClick={invalidatePersonViews} disabled={loading}>刷新</Button><Button variant="outlined" startIcon={<DownloadIcon />} onClick={exportCsv} disabled={loading || !!error || !visible.length}>导出时间表</Button></Stack>
    </Stack>
    <Tabs value={view} onChange={(_,value)=>setView(value)} aria-label="人物出现视图" sx={{mb:2}}><Tab value="first" label="首次出现时间表"/><Tab value="segments" label="全部出现片段"/></Tabs>
    <Alert severity="info" icon={false} sx={{ mb: 2, py: 0.3 }}>时间段由采样检测点合并，边界可能有误差；点击时间即可从前 1 秒开始回看。单个检测点不会被扩展成持续出现。</Alert>
    <Stack direction={{ xs: "column", md: "row" }} gap={1.5} mb={3}>
      <TextField size="small" placeholder="搜索视频名称或文件夹" aria-label="筛选人物出现视频" value={search} onChange={e => setSearch(e.target.value)} sx={{ flex: 1 }} />
      <TextField select size="small" label="视频排序" value={sort} onChange={e => setSort(e.target.value)} sx={{ minWidth: 160 }}><MenuItem value="latest">最新视频优先</MenuItem><MenuItem value="segments">出现片段最多</MenuItem><MenuItem value="detections">人脸检测次数最多</MenuItem></TextField>
      <TextField select size="small" label="相邻检测合并间隔" value={gap} onChange={e => setGap(Number(e.target.value))} sx={{ minWidth: 170 }}>{[0, 2, 4, 6, 10].map(value => <MenuItem key={value} value={value}>{value === 0 ? "不合并" : `不超过 ${value} 秒`}</MenuItem>)}</TextField>
    </Stack>
    {error && <Alert severity="error" action={<Button onClick={() => setRevision(v => v + 1)}>重试</Button>}>{error}</Alert>}
    {loading && <Box py={5} textAlign="center"><CircularProgress size={26} /></Box>}
    {!loading && !error && !visible.length && <Box py={5} textAlign="center"><Typography color="text.secondary">{appearances.length ? "没有符合筛选条件的视频。" : "这个人物还没有视频出现记录。请先识别视频并归类人物。"}</Typography><Button component={Link} to="/videos" sx={{ mt: 2 }}>选择要识别的视频</Button></Box>}
    {view==='first' && !!visible.length && <TableContainer sx={{border:1,borderColor:'divider',borderRadius:1,mb:2}}><Table size="small" aria-label="人物在各视频首次出现时间表"><TableHead><TableRow><TableCell>视频 / 拍摄日期</TableCell><TableCell>首次出现</TableCell><TableCell>首次片段结束</TableCell><TableCell>回看</TableCell></TableRow></TableHead><TableBody>{visible.map(item=>{const first=item.segments[0];return <TableRow key={item.media.id}><TableCell sx={{maxWidth:320}}><Typography variant="body2" noWrap title={item.media.filename}>{item.media.filename}</Typography><Typography variant="caption" color="text.secondary">{captureDate(item.media.created_at)}</Typography></TableCell><TableCell sx={{whiteSpace:'nowrap',fontVariantNumeric:'tabular-nums'}}>{first?formatVideoDuration(first.start):'缺少时间戳'}</TableCell><TableCell sx={{whiteSpace:'nowrap',fontVariantNumeric:'tabular-nums'}}>{first?(first.end>first.start?formatVideoDuration(first.end):'单次检测'):'—'}</TableCell><TableCell><Button size="small" disabled={!first} onClick={()=>first&&play(item.media,first)} startIcon={<PlayArrowIcon/>}>回看</Button></TableCell></TableRow>;})}</TableBody></Table></TableContainer>}
    {view==='segments' && <Stack gap={2}>
      {visible.map(({ media, segments, faceCount, missingTimestamps }) => <Box key={media.id} data-appearance-media={media.id} sx={{ p: { xs: 1.5, sm: 2 }, bgcolor: "background.paper", border: "1px solid", borderColor: "divider", borderRadius: 1.5 }}>
        <Stack direction={{ xs: "column", sm: "row" }} gap={2}>
          <Box component="img" src={withMediaCacheScope(`${API}/thumbnails/${encodeFilePath(media.thumbnail_path || `${media.id}.jpg`)}`)} alt={media.filename} loading="lazy" sx={{ width: { xs: "100%", sm: 164 }, aspectRatio: "16/10", objectFit: "cover", borderRadius: 1, alignSelf: "flex-start" }} />
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography variant="subtitle2" noWrap title={media.filename}>{media.filename}</Typography>
            <Typography variant="caption" color="text.secondary">{captureDate(media.created_at)} · 时长 {formatVideoDuration(media.duration)} · {segments.length} 段 · {faceCount} 次检测</Typography>
            <Typography variant="caption" display="block" color="text.secondary" noWrap title={media.path} sx={{ mt: 0.5 }}>{media.path}</Typography>
            {!!segments.length && <Box aria-label="人物出现时间轴" sx={{ display: "flex", position: "relative", bgcolor: "action.hover", height: 22, borderRadius: 0.6, my: 1.5, overflow: "hidden" }}>{segments.map((segment, i) => <Box component="button" key={i} onClick={() => play(media, segment)} title={`${formatVideoDuration(segment.start)} — ${formatVideoDuration(segment.end)}`} aria-label={`从 ${formatVideoDuration(segment.start)} 播放`} sx={{ position: "absolute", left: `${100 * segment.start / (media.duration || 1)}%`, width: `${Math.max(0.7, 100 * (segment.end - segment.start) / (media.duration || 1))}%`, maxWidth: `${100 - 100 * segment.start / (media.duration || 1)}%`, minWidth: 2, height: "100%", bgcolor: "primary.main", cursor: "pointer", p: 0, borderRadius: 0.3 }} />)}</Box>}
            <Stack direction="row" gap={0.8} flexWrap="wrap" mt={1}>
              {segments.map((segment, i) => <Button key={i} data-segment-start={segment.start} variant="outlined" startIcon={<PlayArrowIcon />} onClick={() => play(media, segment)} sx={{ fontVariantNumeric: "tabular-nums", fontSize: 12 }}>{formatVideoDuration(segment.start)}{segment.end > segment.start ? ` – ${formatVideoDuration(segment.end)}` : " · 单次检测"}</Button>)}
              {!segments.length && <Chip size="small" label={missingTimestamps ? "缺少有效时间戳，请在任务面板补齐" : "手动关联视频，尚无检测时间点"} />}
            </Stack>
            {!!missingTimestamps && !!segments.length && <Typography variant="caption" color="warning.main">另有 {missingTimestamps} 次检测缺少有效时间戳，未计入片段。</Typography>}
          </Box>
        </Stack>
      </Box>)}
    </Stack>}
    <Dialog open={!!player} onClose={() => setPlayer(null)} maxWidth="lg" fullWidth>
      <DialogTitle sx={{ pr: 6 }}>{player?.media.filename}<IconButton aria-label="关闭片段预览" onClick={() => setPlayer(null)} sx={{ position: "absolute", right: 12, top: 14 }}><CloseIcon /></IconButton></DialogTitle>
      <DialogContent>{player && <><Typography variant="body2" color="text.secondary" mb={1.5}>检测片段：{formatVideoDuration(player.segment.start)} – {formatVideoDuration(player.segment.end)} · 从前 1 秒开始播放</Typography><VideoWithPreview key={player.media.id} media={player.media} autoplay initialTime={Math.max(0, player.segment.start - 1)} seekRequest={{ time: Math.max(0, player.segment.start - 1), seq: player.seq }} /><Button component={Link} to={`/medium/${player.media.id}`} state={{ sceneStart: Math.max(0, player.segment.start - 1), autoplayVideo: true }} sx={{ mt: 1.5 }}>打开完整视频与人物信息</Button></>}</DialogContent>
    </Dialog>
  </Box>;
}
