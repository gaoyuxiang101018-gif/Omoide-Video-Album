import React, { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Typography,
  Box,
  TextField,
  List,
  ListItemText,
  Radio,
  ListItemButton,
  ListItemIcon,
  Snackbar,
  Alert,
  IconButton,
  CircularProgress,
} from "@mui/material";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import AddIcon from "@mui/icons-material/Add";
import {
  createProfile,
  getConfig,
  listProfiles,
  pickDirectory,
  reloadConfig,
  switchProfile,
  addExistingProfile,
} from "../services/config";
import { getActiveTasks } from "../services/taskActions";
import type { AppConfig, ProfileListResponse } from "../types";
import config from "../config";

const LS_KEY = "omoide.profile.onboarding.v1";

export default function ProfileSetupDialog() {
  const [open, setOpen] = useState(false);
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [profiles, setProfiles] = useState<ProfileListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Selection state
  const [selectedPath, setSelectedPath] = useState<string>("");
  const [newName, setNewName] = useState<string>("我的资料库");
  const [newPath, setNewPath] = useState<string>("");
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [snack, setSnack] = useState<{ open: boolean; msg: string; sev: "success" | "error" }>(
    { open: false, msg: "", sev: "success" }
  );
  const [hasActiveTasks, setHasActiveTasks] = useState(false);

  const shouldSkip = useMemo(() => {
    if (typeof window === "undefined") return true;
    return localStorage.getItem(LS_KEY) === "done";
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Read-only showcase: never prompt for profile setup
    if (config.PRESENTATION_MODE) {
      setLoading(false);
      return;
    }
    const init = async () => {
      try {
        setLoading(true);
        const c = await getConfig();
        if (cancelled) return;
        setCfg(c);

        if (c.general.is_docker || c.general.presentation_mode) {
          // Profiles unsupported in Docker; never show dialog
          setOpen(false);
          return;
        }

        if (shouldSkip) {
          setOpen(false);
          return;
        }

        try {
          const p = await listProfiles();
          if (cancelled) return;
          setProfiles(p);
          // Default selection is current active
          setSelectedPath(p.active_path);
          // Fetch active tasks; if present, only allow viewing, not changing
          try {
            const tasks = await getActiveTasks();
            if (!cancelled) setHasActiveTasks(tasks.length > 0);
          } catch {}
          setOpen(true);
        } catch {
          // If listing fails (unlikely), don't block the app
          setOpen(false);
        }
      } catch {
        setError("初始化资料库设置失败。");
        setOpen(false);
      } finally {
        setLoading(false);
      }
    };
    init();
    return () => {
      cancelled = true;
    };
  }, [shouldSkip]);

  const markDoneAndClose = () => {
    try {
      localStorage.setItem(LS_KEY, "done");
    } catch {}
    setOpen(false);
  };

  const handlePickPath = async () => {
    const p = await pickDirectory();
    if (p) setNewPath(p);
  };
  const handleAddExisting = async () => {
    try {
      const p = await pickDirectory();
      if (!p) return;
      await addExistingProfile(p);
      const updated = await listProfiles();
      setProfiles(updated);
      setSelectedPath(p);
      setSnack({ open: true, msg: "资料库已添加。", sev: "success" });
    } catch (e) {
      setSnack({
        open: true,
        msg: (e instanceof Error && e.message) || "添加资料库失败",
        sev: "error",
      });
    }
  };

  const handleSaveSelected = async () => {
    if (!selectedPath) return markDoneAndClose();
    if (hasActiveTasks) return;
    // Only switch if selection differs from active
    const current = profiles?.active_path || "";
    if (selectedPath === current) {
      return markDoneAndClose();
    }
    setSaving(true);
    try {
      await switchProfile(selectedPath);
      await reloadConfig();
      // Ensure all views reflect the new profile by reloading the SPA
      try {
        window.location.reload();
      } catch {}
    } catch (e) {
      setSnack({
        open: true,
        msg: (e instanceof Error && e.message) || "切换资料库失败",
        sev: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleCreate = async () => {
    if (!newPath) return;
    if (hasActiveTasks) return;
    setCreating(true);
    try {
      await createProfile(newPath, newName || "Profile");
      await reloadConfig();
      setSnack({ open: true, msg: "资料库已创建。", sev: "success" });
      markDoneAndClose();
    } catch (e) {
      setSnack({
        open: true,
        msg: (e instanceof Error && e.message) || "创建资料库失败",
        sev: "error",
      });
    } finally {
      setCreating(false);
    }
  };

  if (!open) return null;

  const defaultPath = cfg?.general.data_dir || "";
  const hasMultiple = (profiles?.profiles?.length || 0) > 1;

  return (
    <>
      <Dialog open={open} onClose={markDoneAndClose} maxWidth="sm" fullWidth>
        <DialogTitle>{"设置您的数据资料库"}</DialogTitle>
        <DialogContent>
          {hasActiveTasks && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              {" 处理正在进行中。任务完成前无法更改资料库。 "}</Alert>
          )}
          {loading ? (
            <Typography>{"加载中…"}</Typography>
          ) : error ? (
            <Typography color="error">{error}</Typography>
          ) : (
            <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {!hasMultiple ? (
                <>
                  <Typography>
                    {" 选择 omoide 数据资料库的存储位置。如果不确定，请保留默认位置。您可以稍后在配置中更改。 "}</Typography>
                  <Box>
                    <Typography variant="subtitle2">{"默认位置"}</Typography>
                    <Typography variant="body2" sx={{ color: "text.secondary" }}>
                      {defaultPath}
                    </Typography>
                  </Box>
                  <Box sx={{ display: "flex", gap: 1 }}>
                    <Button variant="contained" onClick={handleSaveSelected} disabled={hasActiveTasks || saving}>
                      {saving ? (
                        <>
                          {" 正在保存… "}<CircularProgress size={16} sx={{ ml: 1 }} />
                        </>
                      ) : (
                        "保存"
                      )}
                    </Button>
                    <Button startIcon={<FolderOpenIcon />} onClick={handlePickPath} disabled={hasActiveTasks}>
                      {" 选择目录… "}</Button>
                  </Box>
                  <Box sx={{ display: "flex", gap: 1, alignItems: "center" }}>
                    <TextField
                      label="资料库名称"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      fullWidth
                    />
                  </Box>
                  <Box sx={{ display: "flex", gap: 1, alignItems: "center" }}>
                    <TextField
                      label="资料库目录"
                      value={newPath}
                      onChange={(e) => setNewPath(e.target.value)}
                      fullWidth
                      placeholder="选择或输入路径"
                    />
                    <IconButton aria-label="浏览" onClick={handlePickPath} disabled={hasActiveTasks}>
                      <FolderOpenIcon />
                    </IconButton>
                    <Button
                      variant="contained"
                      color="primary"
                      startIcon={!creating ? <AddIcon /> : undefined}
                      onClick={handleCreate}
                      disabled={!newPath || creating || hasActiveTasks}
                    >
                      {creating ? (
                        <CircularProgress size={16} color="inherit" />
                      ) : (
                        "在此创建"
                      )}
                    </Button>
                  </Box>
                </>
              ) : (
                <>
                  <Typography>
                    {" 选择活动资料库或创建新资料库。 "}</Typography>
                  <Box sx={{ display: "flex", gap: 1, mb: 1 }}>
                    <Button variant="outlined" onClick={handleAddExisting} disabled={hasActiveTasks}>
                      {" 添加现有… "}</Button>
                  </Box>
                  <List dense>
                    {profiles?.profiles?.map((p) => (
                      <ListItemButton
                        key={p.path}
                        onClick={() => setSelectedPath(p.path)}
                        selected={selectedPath === p.path}
                      >
                        <ListItemIcon>
                          <Radio checked={selectedPath === p.path} onChange={() => setSelectedPath(p.path)} />
                        </ListItemIcon>
                        <ListItemText
                          primary={p.name || "资料库"}
                          secondary={p.path}
                        />
                      </ListItemButton>
                    ))}
                  </List>
                  <Box sx={{ display: "flex", gap: 1, alignItems: "center", mt: 1 }}>
                    <TextField
                      label="新资料库名称"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      fullWidth
                    />
                  </Box>
                  <Box sx={{ display: "flex", gap: 1, alignItems: "center" }}>
                    <TextField
                      label="新资料库目录"
                      value={newPath}
                      onChange={(e) => setNewPath(e.target.value)}
                      fullWidth
                      placeholder="选择或输入路径"
                    />
                    <IconButton aria-label="浏览" onClick={handlePickPath} disabled={hasActiveTasks}>
                      <FolderOpenIcon />
                    </IconButton>
                    <Button
                      variant="contained"
                      color="primary"
                      startIcon={!creating ? <AddIcon /> : undefined}
                      onClick={handleCreate}
                      disabled={!newPath || creating || hasActiveTasks}
                    >
                      {creating ? (
                        <CircularProgress size={16} color="inherit" />
                      ) : (
                        "创建新的"
                      )}
                    </Button>
                  </Box>
                </>
              )}
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={handleSaveSelected} disabled={hasActiveTasks || saving} variant="contained">
            {saving ? <CircularProgress size={16} sx={{ color: "white" }} /> : "保存"}
          </Button>
        </DialogActions>
      </Dialog>
      <Snackbar
        open={snack.open}
        autoHideDuration={4000}
        onClose={() => setSnack({ ...snack, open: false })}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert severity={snack.sev} onClose={() => setSnack({ ...snack, open: false })}>
          {snack.msg}
        </Alert>
      </Snackbar>
    </>
  );
}
