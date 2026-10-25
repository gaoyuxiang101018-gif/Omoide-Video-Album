import React, { useEffect, useState } from "react";
import { Alert, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField, Typography } from "@mui/material";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import { apiFetch } from "../services/api";
import { pickDirectory, reloadConfig, saveConfig } from "../services/config";
import { startTask } from "../services/taskActions";
import { useTaskEvents } from "../TaskEventsContext";
import { normalizeLibraryPath } from "../context/VideoLibraryContext";
import type { AppConfig } from "../types";

export function AddFolderDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [path, setPath] = useState(""), [error, setError] = useState(""), [saving, setSaving] = useState(false), [saved, setSaved] = useState(false);
  const { activeTasks, forceRefresh } = useTaskEvents();
  useEffect(() => { if (open) { setPath(""); setError(""); setSaved(false); } }, [open]);
  const browse = async () => {
    try { const selected = await pickDirectory(); if (selected) setPath(selected); }
    catch { setError("文件夹选择器暂不可用，可以直接输入完整路径。"); }
  };
  const add = async () => {
    const chosen = path.trim();
    if (!/^(?:[a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+|\/)/.test(chosen)) { setError("请输入完整文件夹路径。"); return; }
    setSaving(true); setError("");
    try {
      if (!saved) {
        // Refresh before appending so a separate settings page's changes are kept.
        const latest = await apiFetch<AppConfig>("/api/config/", { errorMessage: "读取当前文件夹失败" });
        if (latest.general.media_dirs.some(dir => normalizeLibraryPath(dir.path) === normalizeLibraryPath(chosen))) throw new Error("这个文件夹已经添加过了，可在左侧打开，或运行扫描更新。");
        await saveConfig({ ...latest, general: { ...latest.general, media_dirs: [...latest.general.media_dirs, { path: chosen, read_only: true }] } });
        setSaved(true);
        await reloadConfig();
      }
      if (activeTasks.some(task => task.task_type === "scan" && ["pending", "running"].includes(task.status))) {
        setError("文件夹已添加。当前扫描结束后，请点击“扫描更新”，把新文件导入相册。");
        return;
      }
      await startTask("scan"); await forceRefresh();
      window.dispatchEvent(new Event("omoide-open-tasks")); onClose();
    } catch (err) { setError(err instanceof Error ? err.message : "添加文件夹失败，请重试。"); }
    finally { setSaving(false); }
  };
  return <Dialog open={open} onClose={saving ? undefined : onClose} maxWidth="sm" fullWidth>
    <DialogTitle>添加视频文件夹</DialogTitle>
    <DialogContent><Typography variant="body2" color="text.secondary" mb={2}>加入后会显示在左侧。先扫描文件与封面，再选择视频识别人脸。</Typography>
      <Stack direction="row" gap={1} alignItems="center"><TextField autoFocus fullWidth size="small" label="文件夹路径" value={path} onChange={e => setPath(e.target.value)} disabled={saving || saved} placeholder="输入完整路径，或点击选择" /><Button startIcon={<FolderOpenIcon />} onClick={browse} disabled={saving || saved} sx={{ flexShrink: 0 }}>选择文件夹</Button></Stack>
      <Typography variant="caption" color="text.secondary" display="block" mt={1.5}>原视频以只读方式接入，文件保留在原来的位置。</Typography>
      {!!error && <Alert severity={saved ? "info" : "error"} sx={{ mt: 2 }}>{error}</Alert>}
    </DialogContent>
    <DialogActions><Button onClick={onClose} disabled={saving}>{saved ? "关闭" : "取消"}</Button><Button variant="contained" onClick={add} disabled={saving || !path.trim()} startIcon={saving ? <CircularProgress size={16} /> : undefined}>{saved ? "开始扫描" : "添加并扫描"}</Button></DialogActions>
  </Dialog>;
}
