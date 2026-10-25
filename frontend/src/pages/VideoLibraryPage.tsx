import React, { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Alert, Box, Button, CircularProgress, Container, FormControlLabel, InputAdornment, MenuItem, Stack, Switch, Tab, Tabs, TextField, ToggleButton, ToggleButtonGroup, Tooltip, Typography } from "@mui/material";
import SearchIcon from "@mui/icons-material/Search";
import AddIcon from "@mui/icons-material/Add";
import SyncIcon from "@mui/icons-material/Sync";
import CheckBoxOutlinedIcon from "@mui/icons-material/CheckBoxOutlined";
import GridViewOutlinedIcon from "@mui/icons-material/GridViewOutlined";
import ViewComfyOutlinedIcon from "@mui/icons-material/ViewComfyOutlined";
import MovieOutlinedIcon from "@mui/icons-material/MovieOutlined";
import { useVideoLibrary, VideoFaceStatus } from "../context/VideoLibraryContext";
import { useSelection } from "../context/SelectionContext";
import { useTaskEvents } from "../TaskEventsContext";
import { startTask } from "../services/taskActions";
import { bulkRecognitionCandidates, captureDate, formatVideoDuration, matchesVideoVersion, sortVideos } from "../albumUtils";
import { useLocalStoragePreference } from "../hooks/useLocalStoragePreference";
import { AddFolderDialog } from "../components/AddFolderDialog";
import MediaCard from "../components/MediaCard";
import config from "../config";
import { ResourceLimitsDialog } from "../components/ResourceLimits";
import { RestoredOriginalsNotice } from "../components/RestoredOriginalsNotice";

export default function VideoLibraryPage() {
  const { videos, directories, faceStates, loading, loadedCount, error, statusError, reload, isInDirectory, hiddenOriginals, restoredOriginalIds, recognitionStates, activityReady, activityError, globalRecognitionBusy, showRestoredOriginals, setShowRestoredOriginals } = useVideoLibrary();
  const [params, setParams] = useSearchParams();
  const folder = params.get("folder") || "", query = params.get("q") || "";
  const filter = ["pending", "faces", "empty", "running", "queued"].includes(params.get("status") || "") ? params.get("status")! : "all";
  const version = ["restored", "original"].includes(params.get("version") || "") ? params.get("version")! : "all";
  const [sort, setSort] = useLocalStoragePreference("videoLibrarySort", ["newest", "oldest", "latest"] as const, "newest");
  const [density, setDensity] = useLocalStoragePreference("videoLibraryDensity", ["comfortable", "compact"] as const, "comfortable");
  const [hover, setHover] = useLocalStoragePreference("videoHoverPreview", ["on", "off"] as const, "off");
  const [adding, setAdding] = useState(false), [scanning, setScanning] = useState(false), [actionError, setActionError] = useState("");
  const [resources, setResources] = useState(false);
  const [shown, setShown] = useState(60);
  const { selectedIds, selectMany, clear, isSelecting, toggleSelecting } = useSelection();
  useEffect(() => { clear(); }, [folder, clear]);
  useEffect(() => { clear(); }, [hiddenOriginals, showRestoredOriginals, clear]);
  const { activeTasks, forceRefresh } = useTaskEvents();
  const scanActive = scanning || activeTasks.some(task => task.task_type === "scan" && ["running", "pending"].includes(task.status));
  const update = (key: string, value: string) => { clear(); setParams(previous => { const next = new URLSearchParams(previous); if (value && value !== "all") next.set(key, value); else next.delete(key); return next; }, { replace: key === "q" }); };
  useEffect(() => setShown(60), [folder, query, filter, sort, version]);
  const base = useMemo(() => videos.filter(item => matchesVideoVersion(item, version) && (!folder || isInDirectory(item.path, folder)) && `${item.filename} ${item.path} ${item.restored_source_path || ""}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [videos, folder, query, version, isInDirectory]);
  const counts = useMemo(() => ({ all: base.length, pending: base.filter(item => faceStates.get(item.id) === "pending").length, faces: base.filter(item => faceStates.get(item.id) === "faces").length, empty: base.filter(item => faceStates.get(item.id) === "empty").length, running: base.filter(item => recognitionStates.get(item.id) === "running").length, queued: base.filter(item => recognitionStates.get(item.id) === "queued").length }), [base, faceStates, recognitionStates]);
  const filtered = useMemo(() => {
    const chosen = base.filter(item => filter === "all" || (["running", "queued"].includes(filter) ? recognitionStates.get(item.id) === filter : faceStates.get(item.id) === filter));
    const ordered = sortVideos(chosen, sort);
    return sort === "oldest" ? ordered.reverse() : ordered;
  }, [base, filter, faceStates, recognitionStates, sort]);
  const ids = useMemo(() => filtered.map(item => item.id), [filtered]);
  const pending = filtered.filter(item => faceStates.get(item.id) === "pending");
  const selectedPending = bulkRecognitionCandidates(filtered, faceStates, restoredOriginalIds, recognitionStates, activityReady, globalRecognitionBusy);
  const skippedOriginals = restoredOriginalIds ? pending.filter(item => restoredOriginalIds.has(item.id)).length : 0;
  const skippedWorking = pending.filter(item => !restoredOriginalIds?.has(item.id) && recognitionStates.has(item.id)).length;
  const folderHasHiddenOriginals = !query && version === "all" && filter === "all" && !showRestoredOriginals && hiddenOriginals.some(item => !folder || isInDirectory(item.path, folder));
  const label = folder ? folder.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() : "全部视频";
  const scan = async () => {
    if (scanActive) { window.dispatchEvent(new Event("omoide-open-tasks")); return; }
    setScanning(true); setActionError("");
    try { await startTask("scan"); await forceRefresh(); window.dispatchEvent(new Event("omoide-open-tasks")); }
    catch (err) { setActionError(err instanceof Error ? err.message : "扫描未能启动"); }
    finally { setScanning(false); }
  };
  const displayed = filtered.slice(0, shown);
  const groups = useMemo(() => {
    const result: { date: string; items: typeof displayed }[] = [];
    displayed.forEach(item => {
      const date = captureDate(sort === "latest" ? item.inserted_at : item.created_at), previous = result[result.length - 1];
      if (previous?.date === date) previous.items.push(item); else result.push({ date, items: [item] });
    });
    return result;
  }, [displayed, sort]);
  return <Container maxWidth={false} sx={{ px: { xs: 2, md: 4 }, py: 3.5, pb: selectedIds.size ? 14 : 4 }}>
    <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" alignItems={{ sm: "center" }} gap={2} mb={3}>
      <Box sx={{ minWidth: 0 }}><Typography component="h1" variant="h4" noWrap title={folder || undefined}>{label}</Typography><Typography variant="body2" color="text.secondary" mt={0.8}>{loading ? `正在读取文件索引… ${loadedCount} 个` : `${base.length} 个视频 · 总时长 ${formatVideoDuration(base.reduce((sum, item) => sum + (item.duration ?? 0), 0))}`}{folder && directories.find(dir => dir.path === folder)?.read_only ? " · 只读" : ""}</Typography></Box>
      {!config.PRESENTATION_MODE && <Stack direction="row" gap={1} flexWrap="wrap"><Button component={Link} to={folder ? `/film?folder=${encodeURIComponent(folder)}` : "/film"} state={{ restoreIds: Array.from(selectedIds) }} variant="outlined">类型与还原{selectedIds.size ? `（${selectedIds.size}）` : ""}</Button><Button onClick={() => setResources(true)} color="inherit">资源占用</Button><Button startIcon={<SyncIcon />} onClick={scan} disabled={scanning} variant="outlined">{scanActive ? "查看扫描进度" : "扫描更新"}</Button><Button startIcon={<AddIcon />} variant="contained" onClick={() => setAdding(true)}>添加文件夹</Button></Stack>}
    </Stack>
    <RestoredOriginalsNotice folder={folder} />
    <Stack direction={{ xs: "column", sm: "row" }} gap={1.5} flexWrap="wrap" alignItems={{ sm: "center" }} mb={2}>
      <TextField fullWidth size="small" placeholder="搜索文件名或文件夹" value={query} onChange={e => update("q", e.target.value)} inputProps={{ "aria-label": "搜索视频" }} slotProps={{ input: { startAdornment: <InputAdornment position="start"><SearchIcon sx={{ fontSize: 18 }} /></InputAdornment> } }} sx={{ maxWidth: { sm: 340 } }} />
      <TextField select size="small" value={sort} onChange={e => setSort(e.target.value as typeof sort)} label="视频排序" sx={{ minWidth: 155 }}><MenuItem value="newest">最新拍摄优先</MenuItem><MenuItem value="oldest">最早拍摄优先</MenuItem><MenuItem value="latest">最近添加优先</MenuItem></TextField>
      <TextField select size="small" value={version} onChange={e => update("version", e.target.value)} label="视频版本" sx={{ minWidth: 145 }}><MenuItem value="all">全部视频</MenuItem><MenuItem value="restored">只看还原成片</MenuItem><MenuItem value="original">只看原始视频</MenuItem></TextField>
      <Box sx={{ flex: 1 }} />
      <Stack direction="row" gap={1.5} alignItems="center" sx={{ flexShrink: 0 }}><FormControlLabel sx={{ mr: 0 }} control={<Switch size="small" checked={hover === "on"} onChange={e => setHover(e.target.checked ? "on" : "off")} />} label={<Typography variant="caption" color="text.secondary" noWrap>悬停预览</Typography>} /><ToggleButtonGroup value={density} exclusive size="small" onChange={(_, value) => { if (value) setDensity(value); }} aria-label="视频封面大小"><ToggleButton value="comfortable" aria-label="舒适封面"><Tooltip title="舒适封面"><GridViewOutlinedIcon sx={{ fontSize: 18 }} /></Tooltip></ToggleButton><ToggleButton value="compact" aria-label="紧凑封面"><Tooltip title="紧凑封面"><ViewComfyOutlinedIcon sx={{ fontSize: 18 }} /></Tooltip></ToggleButton></ToggleButtonGroup></Stack>
    </Stack>
    <Stack direction={{ xs: "column", md: "row" }} justifyContent="space-between" alignItems={{ md: "center" }} gap={1} sx={{ borderBottom: "1px solid", borderColor: "divider", mb: 2.5 }}>
      <Tabs value={filter} onChange={(_, value) => update("status", value)} variant="scrollable" scrollButtons="auto" aria-label="视频识别状态"><Tab value="all" label={`全部 ${counts.all}`} /><Tab value="pending" disabled={!!statusError} label={`待识别 ${counts.pending}`} /><Tab value="running" label={`识别中 ${counts.running}`} /><Tab value="queued" label={`排队中 ${counts.queued}`} /><Tab value="faces" disabled={!!statusError} label={`检测到人脸 ${counts.faces}`} /><Tab value="empty" disabled={!!statusError} label={`未检测到人脸 ${counts.empty}`} /></Tabs>
      {!config.PRESENTATION_MODE && <Stack direction="row" gap={0.5} sx={{ mb: 1, alignSelf: { xs: "flex-start", md: "auto" }, flexWrap: "wrap" }}><Button onClick={toggleSelecting} aria-pressed={isSelecting} disabled={loading} variant={isSelecting ? "outlined" : "text"}>{isSelecting ? "取消选择" : "选择视频"}</Button><Button startIcon={<CheckBoxOutlinedIcon />} disabled={loading || !!statusError || !selectedPending.length} onClick={() => selectMany(selectedPending.map(item => item.id))} sx={{ whiteSpace: "nowrap" }}>全选未识别视频{selectedPending.length ? ` (${selectedPending.length})` : ""}</Button></Stack>}
    </Stack>
    {!!skippedOriginals && <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 2 }}>批量选择已跳过 {skippedOriginals} 个已还原原片</Typography>}
    {!!skippedWorking && <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 2 }}>另有 {skippedWorking} 个视频已在本批任务中，未重复选择。</Typography>}
    {globalRecognitionBusy && <Alert severity="info" sx={{ mb: 2 }}>全库识别正在进行，完成后可继续批量选择。</Alert>}
    {activityError && <Alert severity="warning" sx={{ mb: 2 }}>{activityError}</Alert>}
    {(error || statusError || actionError) && <Alert severity="error" sx={{ mb: 2 }} action={<Button onClick={reload}>刷新重试</Button>}>{error || statusError || actionError}</Alert>}
    {loading && <Box textAlign="center" py={6}><CircularProgress size={26} /></Box>}
    {!loading && !error && !filtered.length && <Box sx={{ textAlign: "center", py: 7, bgcolor: "background.paper", border: "1px solid", borderColor: "divider", borderRadius: 1.5 }}><MovieOutlinedIcon sx={{ fontSize: 46, color: "text.disabled" }} /><Typography variant="h6" mt={2}>{folderHasHiddenOriginals ? "已还原的原片已隐藏" : videos.length ? "没有符合条件的视频" : "添加文件夹，开始建立视频资料库"}</Typography><Typography variant="body2" color="text.secondary" mt={1}>{folderHasHiddenOriginals ? "可在上方查看还原成片，或打开显示已还原原片。" : videos.length ? "试试清除搜索或切换识别状态。" : "扫描会读取文件和封面；选好视频后再识别人脸。"}</Typography><Button onClick={() => { if (folderHasHiddenOriginals) setShowRestoredOriginals(true); else if (videos.length) { clear(); setParams(folder ? { folder } : {}); } else setAdding(true); }} sx={{ mt: 2 }}>{folderHasHiddenOriginals ? "显示已还原原片" : videos.length ? "清除筛选" : "添加文件夹"}</Button></Box>}
    {!loading && groups.map((group, index) => <Box key={`${group.date}-${index}`} mb={3}><Typography variant="subtitle2" sx={{ mb: 1.5, color: "text.secondary", fontSize: 12 }}>{group.date}</Typography><Box sx={{ display: "grid", gridTemplateColumns: { xs: "repeat(2, minmax(0, 1fr))", sm: `repeat(auto-fill, minmax(${density === "compact" ? 170 : 228}px, 1fr))` }, gap: { xs: 1.2, sm: 2 } }}>{group.items.map(media => <MediaCard key={media.id} media={media} albumStyle hoverPreview={hover === "on"} faceStatus={faceStates.get(media.id) ?? "unknown" as VideoFaceStatus} recognitionState={recognitionStates.get(media.id)} navigationContext={{ ids }} />)}</Box></Box>)}
    {!loading && filtered.length > shown && <Box textAlign="center" py={2}><Button variant="outlined" onClick={() => setShown(value => value + 60)}>显示更多视频（还有 {filtered.length - shown} 个）</Button></Box>}
    <AddFolderDialog open={adding} onClose={() => setAdding(false)} />
    <ResourceLimitsDialog open={resources} onClose={() => setResources(false)} />
  </Container>;
}
