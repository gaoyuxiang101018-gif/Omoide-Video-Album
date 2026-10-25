import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { Alert, Box, Button, Checkbox, Chip, Container, Dialog, DialogActions, DialogContent, DialogTitle, Divider, FormControlLabel, LinearProgress, MenuItem, Stack, Tab, Tabs, TextField, Typography } from "@mui/material";
import AutoFixHighOutlinedIcon from "@mui/icons-material/AutoFixHighOutlined";
import PlayCircleOutlineIcon from "@mui/icons-material/PlayCircleOutline";
import FolderOpenOutlinedIcon from "@mui/icons-material/FolderOpenOutlined";
import { useVideoLibrary } from "../context/VideoLibraryContext";
import { useSelection } from "../context/SelectionContext";
import { API } from "../config";
import { encodeFilePath, withMediaCacheScope } from "../urlUtils";
import { canonicalLibraryPath, formatVideoDuration, sortVideos } from "../albumUtils";
import { canSelectUnrestored, indexFilmRestorations, matchesRestoration, RestorationFilter } from '../filmRestoration';
import { FilmRestorationBadge } from '../components/FilmRestorationBadge';
import { VideoWithPreview } from "../components/VideoPlayer";
import { AddFolderDialog } from "../components/AddFolderDialog";
import { ResourceLimitsDialog } from "../components/ResourceLimits";
import { RestoredOriginalsNotice } from "../components/RestoredOriginalsNotice";
import { pickDirectory } from "../services/config";
import { FILM_API, filmRequest, FilmMetadata, FilmStatus, FilmCapabilities, FilmJob, FilmItem, TYPE_LABELS, PROFILE_LABELS, JOB_LABELS, filmLabel } from "../services/film";
import type { MediaPreview } from "../types";

export default function FilmPage() {
  const { videos, directories, loading, error: libraryError, isInDirectory, pathAliases, profilePath } = useVideoLibrary();
  const location = useLocation(), [params] = useSearchParams();
  const [selected, setSelected] = useState<Set<number>>(() => new Set<number>((location.state as { restoreIds?: number[] } | null)?.restoreIds || []));
  const { clear } = useSelection();
  useEffect(() => { clear(); }, [clear]);
  const [folder, setFolder] = useState(params.get("folder") || ""), [search, setSearch] = useState(""), [type, setType] = useState("all");
  const [restoreFilter, setRestoreFilter] = useState<RestorationFilter>('all');
  const [tab, setTab] = useState(params.get("tab") === "jobs" ? "jobs" : "library"), [shown, setShown] = useState(48);
  useEffect(() => { if (!loading) setSelected(previous => { const remaining = new Set([...previous].filter(id => videos.some(item => item.id === id))); return remaining.size === previous.size ? previous : remaining; }); }, [videos, loading]);
  const [metadata, setMetadata] = useState<Record<string, FilmMetadata | null>>({}), [status, setStatus] = useState<FilmStatus | null>(null), [caps, setCaps] = useState<FilmCapabilities | null>(null);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0);
  const [connectionError, setConnectionError] = useState("");
  const [adding, setAdding] = useState(false), [resources, setResources] = useState(false), [exporting, setExporting] = useState(false);
  const [mode, setMode] = useState("sdr"), [outputDir, setOutputDir] = useState(() => localStorage.getItem("filmOutputDir") || ""), [skip, setSkip] = useState(true);
  const [detail, setDetail] = useState<MediaPreview | null>(null), [playOutput, setPlayOutput] = useState<{ job: FilmJob; item: FilmItem } | null>(null);
  const lastAnalysis = useRef("");
  useEffect(() => {
    setStatus(null);
    const controller = new AbortController(); let timer: number;
    const poll = async () => {
      try {
        const current = await filmRequest<FilmStatus>("/status", undefined, controller.signal);
        if (controller.signal.aborted) return;
        setStatus(current); setConnectionError("");
        const marker = `${current.profile}-${current.analysis?.processed ?? 0}-${current.analysis?.running ?? false}`;
        if (marker !== lastAnalysis.current) { lastAnalysis.current = marker; setRevision(value => value + 1); }
      } catch (err) { if (!controller.signal.aborted) setConnectionError(err instanceof Error ? err.message : "读取状态失败。"); }
      if (!controller.signal.aborted) timer = window.setTimeout(poll, 2500);
    };
    poll();
    filmRequest<FilmCapabilities>("/capabilities", undefined, controller.signal).then(setCaps).catch(() => {});
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [profilePath]);
  useEffect(() => {
    if (!videos.length) { setMetadata({}); return; }
    const controller = new AbortController();
    filmRequest<{ items: Record<string,FilmMetadata | null> }>("/catalog", { media_ids: videos.map(item => item.id) }, controller.signal).then(data => { if (!controller.signal.aborted) setMetadata(data.items); }).catch(err => { if (!controller.signal.aborted) setError(err.message); });
    return () => controller.abort();
  }, [videos, revision]);
  const restorations = useMemo(() => indexFilmRestorations(status?.jobs || [], pathAliases), [status?.jobs, pathAliases]);
  const filtered = useMemo(() => sortVideos(videos.filter(item => (!folder || isInDirectory(item.path, folder)) && `${item.filename} ${item.path}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()) && (type === "all" || (type === "unread" ? !metadata[item.id] : metadata[item.id]?.category === type)) && (restoreFilter === 'all' || !!status && matchesRestoration(restorations.get(canonicalLibraryPath(item.path, pathAliases)), restoreFilter))), "newest"), [videos, folder, search, type, metadata, isInDirectory, restoreFilter, status, restorations, pathAliases]);
  const unrestoredVideos = useMemo(() => filtered.filter(item => canSelectUnrestored(restorations.get(canonicalLibraryPath(item.path, pathAliases)))), [filtered, restorations, pathAliases]);
  const selectedVideos = videos.filter(item => selected.has(item.id));
  const unsupported = selectedVideos.filter(item => !metadata[item.id] || metadata[item.id]?.status === "error" || (!metadata[item.id]?.manual_profile && !["DLog", "DLog2", "HDR_HLG", "Normal8", "Normal10"].includes(metadata[item.id]?.category || "")));
  useEffect(() => setShown(48), [folder, search, type, restoreFilter]);
  const act = async (operation: () => Promise<unknown>) => { setBusy(true); setError(""); setNotice(""); try { await operation(); setRevision(value => value + 1); setStatus(await filmRequest<FilmStatus>("/status")); } catch (err) { setError(err instanceof Error ? err.message : "操作失败。"); } finally { setBusy(false); } };
  const filmAction = <T,>(path: string, body: Record<string, unknown>) => filmRequest<T>(path, { ...body, library_key: status?.profile });
  const analyze = () => act(async () => { const ids = selected.size ? selectedVideos.map(item => item.id) : filtered.map(item => item.id); await filmAction("/analyze", { media_ids: ids }); setNotice("正在读取相机和颜色模式，不运行人脸识别。"); });
  const control = (action: string, job_id?: string) => act(() => filmAction("/control", { action, job_id }));
  const submit = () => act(async () => {
    const result = await filmAction<{added:number;skipped:number}>("/enqueue", { media_ids: selectedVideos.map(item => item.id), output_dir: outputDir, mode, skip_completed: skip });
    localStorage.setItem("filmOutputDir", outputDir); setExporting(false); setTab("jobs");
    setNotice(`已加入 ${result.added} 个视频${result.skipped ? `，跳过 ${result.skipped} 个已有成片` : ""}。`);
  });
  const percent = Math.round(Math.max(0, Math.min(1, status?.progress.fraction || 0))*100);
  const detailMeta = detail ? metadata[detail.id] : null;
  const selectedRestoredCount = selectedVideos.filter(item => restorations.get(canonicalLibraryPath(item.path, pathAliases))?.kind === 'completed').length;
  return <Container maxWidth={false} sx={{ px:{xs:2,md:4}, py:3.5, pb:12 }}>
    <Stack direction={{xs:"column",sm:"row"}} justifyContent="space-between" gap={2} mb={2.5}>
      <Box><Typography component="h1" variant="h4">视频类型与还原</Typography><Typography variant="body2" color="text.secondary" mt={.8}>同一份视频资料库，查看拍摄模式，批量还原为 SDR 或 HDR。</Typography></Box>
      <Stack direction="row" flexWrap="wrap" gap={1}><Button onClick={() => setResources(true)}>资源占用</Button><Button variant="outlined" onClick={() => setAdding(true)}>添加文件夹</Button><Button component={Link} to="/people">人物检索</Button></Stack>
    </Stack>
    <Typography variant="body2" color="text.secondary" sx={{mb:2}}>Log／HLG 原片还原成功且成片有效后自动隐藏；成片丢失或改变时重新显示原片。</Typography>
    <RestoredOriginalsNotice folder={folder} onViewOutputs={() => setTab("jobs")} />
    {(error || connectionError || libraryError) && <Alert severity="error" sx={{mb:2}}>{error || connectionError || libraryError}</Alert>}
    {caps && !caps.available && <Alert severity="warning" sx={{mb:2}}>{caps.unavailable_reason || "还原组件暂不可用，请检查软件文件是否完整。"}</Alert>}
    {status?.resources?.applied === false && <Alert severity="warning" sx={{mb:2}}>还原进程的 CPU 限制未生效：{status.resources.error || "请重新启动软件后重试。"}</Alert>}
    {status?.resources?.applied && <Typography variant="caption" color="text.secondary" display="block" mb={2}>色彩还原 CPU 上限 {status.resources.cpu_percent}% · 跟随资源档位，最多约 5 秒生效。人脸处理与还原分别限速，同时运行时占用会叠加。</Typography>}
    {notice && <Alert severity="success" sx={{mb:2}} onClose={() => setNotice("")}>{notice}</Alert>}
    {status?.analysis && (status.analysis.running || status.analysis.error) && <Box sx={{mb:2}}><Typography variant="body2">读取视频类型 {status.analysis.processed} / {status.analysis.total} · {status.analysis.current}</Typography><LinearProgress variant="determinate" value={status.analysis.total ? status.analysis.processed/status.analysis.total*100 : 0} sx={{mt:1}} />{status.analysis.error && <Alert severity="error">{status.analysis.error}</Alert>}</Box>}
    {!!status?.progress.job_id && <Box sx={{mb:2}}><Stack direction="row" justifyContent="space-between"><Typography variant="body2">{status.progress.stopping ? "正在暂停并清理未完成副本…" : `正在还原 ${percent}% · ${status.progress.current}`}</Typography><Button size="small" onClick={() => setTab("jobs")}>任务详情</Button></Stack><LinearProgress variant="determinate" value={percent} /></Box>}
    <Tabs value={tab} onChange={(_,value)=>setTab(value)} sx={{mb:3,borderBottom:1,borderColor:"divider"}}><Tab value="library" label={`素材 ${videos.length}`} /><Tab value="jobs" label={`还原任务与成片 ${status?.jobs.length || 0}`} /></Tabs>
    {tab === "library" ? <>
      <Stack direction={{xs:"column",sm:"row"}} flexWrap="wrap" gap={1.5} mb={2}>
        <TextField size="small" label="搜索视频" value={search} onChange={e=>setSearch(e.target.value)} sx={{flex:{xs:'none',sm:'1 1 220px'},minWidth:0}} />
        <TextField select size="small" label="文件夹" value={folder} onChange={e=>setFolder(e.target.value)} sx={{width:{xs:"100%",sm:210}}}><MenuItem value="">全部文件夹</MenuItem>{directories.map(dir=><MenuItem key={dir.path} value={dir.path}>{dir.path.replace(/[\\/]+$/,"").split(/[\\/]/).pop()}</MenuItem>)}</TextField>
        <TextField select size="small" label="视频类型" value={type} onChange={e=>setType(e.target.value)} sx={{width:{xs:"100%",sm:180}}}><MenuItem value="all">全部类型</MenuItem><MenuItem value="unread">尚未读取类型</MenuItem>{Object.entries(TYPE_LABELS).map(([value,label])=><MenuItem key={value} value={value}>{label}</MenuItem>)}</TextField>
        <TextField select size="small" label="还原状态" value={restoreFilter} onChange={e=>setRestoreFilter(e.target.value as RestorationFilter)} sx={{width:{xs:'100%',sm:170}}}><MenuItem value="all">全部还原状态</MenuItem><MenuItem value="unrestored">未还原</MenuItem><MenuItem value="completed">已还原／成片</MenuItem><MenuItem value="pending">排队／还原中／暂停</MenuItem><MenuItem value="failed">还原失败</MenuItem></TextField>
      </Stack>
      <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center" mb={2}><Button onClick={()=>setSelected(new Set(unrestoredVideos.map(item=>item.id)))} disabled={loading || !status || !!connectionError || !unrestoredVideos.length}>全选未还原（{status ? unrestoredVideos.length : '…'}）</Button><Button onClick={()=>setSelected(new Set(filtered.map(item=>item.id)))} disabled={!filtered.length}>全选当前结果（{filtered.length}）</Button><Button onClick={()=>setSelected(new Set())} disabled={!selected.size}>清空选择</Button><Box sx={{flex:1}} /><Button variant="outlined" onClick={analyze} disabled={busy || !status || !!status?.analysis?.running || !filtered.length}>{selected.size ? "读取所选视频类型" : "读取当前文件夹类型"}</Button></Stack>
      {(loading || !status && !connectionError) && <LinearProgress aria-label="读取素材与还原记录" />}
      {!loading && !!status && !filtered.length && <Box py={7} textAlign="center"><FolderOpenOutlinedIcon sx={{fontSize:42,color:"text.disabled"}} /><Typography mt={1}>{videos.length ? "没有符合条件的视频，试试其他文件夹、类型或还原状态。" : "先添加文件夹，在视频资料库中扫描视频。"}</Typography><Button component={Link} to="/videos" sx={{mt:2}}>前往视频资料库</Button></Box>}
      <Box sx={{display:"grid",gridTemplateColumns:{xs:"repeat(2,minmax(0,1fr))",sm:"repeat(auto-fill,minmax(210px,1fr))"},gap:2}}>{filtered.slice(0,shown).map(media=>{const restored=restorations.get(canonicalLibraryPath(media.path,pathAliases));return <Box key={media.id} data-film-media-id={media.id} sx={{bgcolor:"background.paper",border:1,borderColor:selected.has(media.id)?"primary.main":"divider",borderRadius:1.5,overflow:"hidden",minWidth:0}}>
        <Box sx={{position:"relative"}}><Box component="button" aria-label={`预览 ${media.filename}`} onClick={()=>setDetail(media)} sx={{p:0,m:0,border:0,width:"100%",display:"block",cursor:"pointer",bgcolor:"action.hover",position:"relative",aspectRatio:"16/10","&:hover .film-play":{opacity:1}}}><Box component="img" src={withMediaCacheScope(`${API}/thumbnails/${encodeFilePath(media.thumbnail_path || `${media.id}.jpg`)}`)} alt="" loading="lazy" sx={{width:"100%",height:"100%",objectFit:"cover"}} /><PlayCircleOutlineIcon className="film-play" sx={{position:"absolute",left:"calc(50% - 20px)",top:"calc(50% - 20px)",fontSize:40,color:"white",filter:"drop-shadow(0 1px 5px #0008)",opacity:.8}} /></Box><Checkbox checked={selected.has(media.id)} onChange={(_,checked)=>setSelected(previous=>{const next=new Set(previous);if(checked)next.add(media.id);else next.delete(media.id);return next;})} inputProps={{"aria-label":`选择 ${media.filename}`}} sx={{position:"absolute",top:5,left:5,bgcolor:"#ffffffe8",p:.4,borderRadius:1}} /><Box sx={{position:'absolute',top:5,right:5,maxWidth:'calc(100% - 50px)',pointerEvents:'auto'}}><FilmRestorationBadge value={restored} ready={!!status} offline={!!connectionError} /></Box></Box>
        <Box p={1.5}><Typography noWrap fontWeight={600} fontSize={12} title={media.filename}>{media.filename}</Typography><Stack direction="row" flexWrap="wrap" gap={.5} mt={1}><Chip size="small" label={filmLabel(metadata[media.id])} sx={{maxWidth:"100%",height:24,fontSize:10.5}} />{restored?.needsVerification&&<Chip size="small" variant="outlined" color="warning" label="成片需核验" sx={{height:24,fontSize:10.5}} />}</Stack><Typography variant="caption" color="text.secondary" display="block" mt={1}>{metadata[media.id]?.camera && metadata[media.id]?.camera !== "Unknown" ? metadata[media.id]?.camera : "相机待确认"} · {formatVideoDuration(media.duration ?? 0)}</Typography><Stack direction="row" gap={1} flexWrap="wrap"><Button size="small" onClick={()=>setDetail(media)} sx={{mt:.5,p:0}}>预览与颜色模式</Button>{restored?.kind==='completed'&&<Button size="small" onClick={()=>setTab('jobs')} sx={{mt:.5,p:0}}>查看还原记录</Button>}</Stack></Box>
      </Box>;})}</Box>
      {filtered.length>shown && <Box textAlign="center" mt={3}><Button onClick={()=>setShown(value=>value+48)}>显示更多（还有 {filtered.length-shown} 个）</Button></Box>}
      {!!selectedRestoredCount && <Alert severity="info" sx={{mt:2}}>所选视频中有 {selectedRestoredCount} 个已有成功还原记录。不需要重新还原时，可使用“全选未还原”。</Alert>}
      {!!selected.size && <Stack direction={{xs:"column",sm:"row"}} gap={1.5} alignItems={{sm:"center"}} sx={{position:"sticky",bottom:16,mt:3,p:2,bgcolor:"background.paper",border:1,borderColor:"divider",borderRadius:1.5,boxShadow:"0 4px 24px #243a5a20",zIndex:2}}><Box sx={{flex:1}}><Typography fontWeight={600}>已选择 {selectedVideos.length} 个视频</Typography><Typography variant="caption" color="text.secondary">{unsupported.length ? `${unsupported.length} 个需要先读取类型或手动确认颜色模式` : "已准备好还原，成片另存到指定文件夹"}</Typography></Box><Button startIcon={<AutoFixHighOutlinedIcon />} variant="contained" onClick={()=>setExporting(true)} disabled={busy || !!unsupported.length || !selectedVideos.length || !caps?.available}>还原所选视频</Button></Stack>}
    </> : <Stack gap={2}>{!status?.jobs.length && <Box py={7} textAlign="center"><Typography color="text.secondary">暂无合并版还原记录。原 PocketFilm 的记录仍保留在原软件中。</Typography><Button onClick={()=>setTab("library")} sx={{mt:2}}>选择视频开始还原</Button></Box>}{[...(status?.jobs || [])].reverse().map(job=><Box key={job.id} sx={{bgcolor:"background.paper",border:1,borderColor:"divider",borderRadius:1.5,p:2}}><Stack direction="row" gap={1} flexWrap="wrap" alignItems="center"><Typography fontWeight={600}>{job.mode==="hlg"?"HDR · HLG":"普通 SDR"} · {job.total} 个视频</Typography><Chip size="small" label={JOB_LABELS[job.status] || job.status}/><Box sx={{flex:1}} />{job.status==="running"&&<Button disabled={busy||status?.progress.stopping} onClick={()=>control("pause")}>暂停队列</Button>}{["paused","queued"].includes(job.status)&&<Button disabled={busy} onClick={()=>control("resume",job.id)}>继续还原</Button>}{!!job.counts.failed&&job.status!=="running"&&<Button disabled={busy} onClick={()=>control("retry",job.id)}>重试失败项</Button>}</Stack><Typography variant="caption" color="text.secondary" sx={{display:"block",overflowWrap:"anywhere",my:1}}>{job.output_dir}</Typography>{status?.progress.job_id===job.id&&<Box mb={1}><LinearProgress variant="determinate" value={percent}/><Typography variant="caption">{percent}% · {status.progress.current}{status.progress.eta_seconds!=null?` · 预计剩余 ${formatVideoDuration(status.progress.eta_seconds)}`:""}</Typography></Box>}{job.error&&<Alert severity="error">{job.error}</Alert>}{job.items.map(item=><Box key={item.index}><Divider sx={{my:1}}/><Stack direction="row" gap={1} alignItems="center"><Box sx={{flex:1,minWidth:0}}><Typography noWrap variant="body2" title={item.video.path}>{item.video.name || item.video.path.split(/[\\/]/).pop()}</Typography><Typography variant="caption" color={item.status==="failed"?"error":"text.secondary"}>{JOB_LABELS[item.status] || item.status}{item.status==="succeeded"&&!item.output_exists?" · 成片已移动或更改":""}{item.error?` · ${item.error}`:""}</Typography></Box>{item.status==="succeeded"&&item.output_exists&&<Button size="small" onClick={()=>setPlayOutput({job,item})}>播放成片</Button>}</Stack></Box>)}</Box>)}</Stack>}
    <Dialog open={!!detail} onClose={()=>setDetail(null)} maxWidth="md" fullWidth><DialogTitle sx={{overflowWrap:"anywhere"}}>{detail?.filename}</DialogTitle><DialogContent>{detail&&<VideoWithPreview key={detail.id} media={detail} autoplay/>}<Stack gap={1.5} mt={2}><Typography>{filmLabel(detailMeta)}{detailMeta?.bit_depth?` · ${detailMeta.bit_depth}-bit`:""}{detailMeta?.width?` · ${detailMeta.width}×${detailMeta.height}`:""}</Typography>{detailMeta?.error&&<Alert severity="error">{detailMeta.error}</Alert>}<Typography variant="caption" color="text.secondary" sx={{overflowWrap:"anywhere"}}>{detailMeta?.evidence?.join("；") || "读取视频类型后可查看相机与颜色模式依据。"}</Typography>{detailMeta&&<TextField select size="small" label="手动确认原片颜色模式" value={detailMeta.manual_profile || ""} onChange={e=>act(()=>filmAction("/override",{media_id:detail?.id,profile:e.target.value||null}))} disabled={busy}><MenuItem value="">使用自动读取结果</MenuItem>{Object.entries(PROFILE_LABELS).map(([value,label])=><MenuItem key={value} value={value}>{label}</MenuItem>)}</TextField>}<Typography variant="caption" color="text.secondary">仅在确认实际拍摄模式后手动选择，错误模式会使还原颜色失真。</Typography></Stack></DialogContent><DialogActions>{detail&&<Button disabled={busy||!!status?.analysis?.running} onClick={()=>act(()=>filmAction("/analyze",{media_ids:[detail.id]}))}>读取此视频类型</Button>}<Button onClick={()=>setDetail(null)}>关闭</Button></DialogActions></Dialog>
    <Dialog open={exporting} onClose={()=>!busy&&setExporting(false)} maxWidth="sm" fullWidth><DialogTitle>还原 {selectedVideos.length} 个视频</DialogTitle><DialogContent><Stack gap={2} mt={1}><TextField select label="导出方式" size="small" value={mode} onChange={e=>setMode(e.target.value)}><MenuItem value="sdr">普通还原 · SDR Rec.709</MenuItem>{caps?.supported_output_modes.includes("hlg")&&<MenuItem value="hlg">HDR · HLG</MenuItem>}</TextField><TextField label="成片保存文件夹" size="small" value={outputDir} onChange={e=>setOutputDir(e.target.value)} helperText="另存副本；原视频不会覆盖或删除。"/><Button startIcon={<FolderOpenOutlinedIcon/>} onClick={()=>act(async()=>{const result=await pickDirectory();if(result)setOutputDir(result);})}>选择保存文件夹</Button><FormControlLabel control={<Checkbox checked={skip} onChange={(_,value)=>setSkip(value)}/>} label="跳过此目录中已经完成的相同导出"/><Typography variant="caption" color="text.secondary">还原成功且成片有效后自动隐藏 Log／HLG 原片，原文件保留。成片可在“还原任务与成片”中播放。</Typography>{error&&<Alert severity="error">{error}</Alert>}</Stack></DialogContent><DialogActions><Button onClick={()=>setExporting(false)} disabled={busy}>取消</Button><Button variant="contained" onClick={submit} disabled={busy||!outputDir.trim()}>开始还原</Button></DialogActions></Dialog>
    <Dialog open={!!playOutput} onClose={()=>setPlayOutput(null)} maxWidth="md" fullWidth><DialogTitle>还原成片</DialogTitle><DialogContent>{playOutput&&<><Box component="video" src={`${FILM_API}/output?job=${encodeURIComponent(playOutput.job.id)}&index=${playOutput.item.index}&token=${encodeURIComponent(status?.playback_token||"")}`} controls autoPlay sx={{width:"100%",maxHeight:"65vh",bgcolor:"black"}}/><Typography variant="caption" sx={{overflowWrap:"anywhere"}}>{playOutput.item.output}</Typography></>}</DialogContent><DialogActions><Button onClick={()=>setPlayOutput(null)}>关闭</Button></DialogActions></Dialog>
    <AddFolderDialog open={adding} onClose={()=>setAdding(false)}/><ResourceLimitsDialog open={resources} onClose={()=>setResources(false)}/>
  </Container>;
}
