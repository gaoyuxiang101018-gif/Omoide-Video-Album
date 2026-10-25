import React, { useEffect, useState } from "react";
import { Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Stack, ToggleButton, ToggleButtonGroup, Typography } from "@mui/material";
import { apiFetch } from "../services/api";

const ENDPOINT = "http://127.0.0.1:18124/resources";
interface ResourceState { mode: string; cpu_percent: number; applied: boolean; verified_cpu_percent?: number; error?: string; }
const modes = [{ value: "light", label: "轻量", percent: 25 }, { value: "balanced", label: "均衡", percent: 50 }, { value: "full", label: "全速", percent: 100 }];

interface ModelMemory { loaded_models: string[]; busy: boolean; working_set_bytes: number | null; private_bytes: number | null; automatic_face_unload: boolean; }
export function ModelMemoryPanel() {
  const [memory,setMemory] = useState<ModelMemory | null>(null), [error,setError] = useState("");
  const [releasing,setReleasing] = useState(false), [message,setMessage] = useState("");
  useEffect(() => {
    const controller = new AbortController(); let timer: number;
    const refresh = async () => {
      try {
        const value = await apiFetch<ModelMemory>("/api/tasks/model-memory",{signal:controller.signal});
        if (!controller.signal.aborted) { setMemory(value);setError(""); }
      } catch { if (!controller.signal.aborted) setError("暂时无法读取模型内存状态，请稍后重试。"); }
      if (!controller.signal.aborted) timer = window.setTimeout(refresh,3000);
    };
    refresh();return () => { controller.abort();window.clearTimeout(timer); };
  },[]);
  const release = async () => {
    if (!memory || memory.busy || releasing) return;
    setReleasing(true);setError("");setMessage("");
    try {
      const value = await apiFetch<{after:ModelMemory}>("/api/tasks/release-models",{method:"POST"});
      setMemory(value.after);setMessage("空闲模型和内存缓存已释放，下次识别时会重新加载。");
    } catch (err) { setError(err instanceof Error ? err.message : "释放模型内存失败，请稍后重试。"); }
    finally { setReleasing(false); }
  };
  const names:Record<string,string>={faces:"人脸模型",embedding_extractor:"图像检索模型",auto_tagger:"图像标签模型",clip:"图像模型缓存"};
  return <Box sx={{mt:3,pt:2,borderTop:1,borderColor:"divider"}}>
    <Typography variant="subtitle1" fontWeight={600}>模型与内存</Typography>
    <Typography variant="body2" color="text.secondary" mt={.5}>识别结束后自动卸载人脸模型。已保存的人物、人脸和视频时间段保持不变。</Typography>
    {memory && <Typography variant="body2" mt={1.5}>{memory.loaded_models.length ? `已加载：${memory.loaded_models.map(name=>names[name]||name).join("、")}` : "当前未加载识别模型"}{memory.working_set_bytes != null ? ` · 软件内存约 ${Math.round(memory.working_set_bytes/1024/1024)} MB` : ""}</Typography>}
    <Button variant="outlined" onClick={release} disabled={!memory || memory.busy || releasing || !!error} sx={{mt:1.5}}>{releasing ? "正在释放…" : memory?.busy ? "任务进行中，空闲后可释放" : "释放模型内存"}</Button>
    {!!message && <Alert severity="success" sx={{mt:1.5}}>{message}</Alert>}
    {!!error && <Alert severity="warning" sx={{mt:1.5}}>{error}</Alert>}
  </Box>;
}

export function ResourceLimitsPanel() {
  const [state, setState] = useState<ResourceState | null>(null), [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => fetch(ENDPOINT, { signal: controller.signal }).then(response => { if (!response.ok) throw new Error(); return response.json(); }).then(value => { setState(value); setError(""); }).catch(() => { if (!controller.signal.aborted) setError("资源控制服务暂未连接。请通过桌面“Omoide 视频相册”快捷方式启动软件后重试。"); });
    refresh(); const timer = window.setInterval(refresh, 6000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, []);
  const change = async (mode: string | null) => {
    if (!mode || saving) return;
    setSaving(true); setError("");
    try {
      const response = await fetch(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }) });
      if (!response.ok) throw new Error("保存资源限制失败，请重试。");
      setState(await response.json());
    } catch (err) { setError(err instanceof Error ? err.message : "连接失败，请重试。"); }
    finally { setSaving(false); }
  };
  return <Box>
    <Typography variant="body2" color="text.secondary" mb={2}>限制后台占用，让电脑同时处理其他工作。切换后即时生效，并记住下次使用。</Typography>
    {!!error && <Alert severity="warning" sx={{ mb: 2 }}>{error}</Alert>}
    {!state && !error && <CircularProgress size={22} />}
    <ToggleButtonGroup exclusive fullWidth value={state?.mode ?? "balanced"} onChange={(_, value) => change(value)} aria-label="资源占用档位" disabled={!state || saving} sx={{ mb: 2 }}>
      {modes.map(mode => <ToggleButton key={mode.value} value={mode.value} aria-label={`${mode.label}模式`} sx={{ py: 1.7, flexDirection: "column", gap: 0.5 }}><Typography fontWeight={600}>{mode.label}</Typography><Typography variant="caption">CPU 上限 {mode.percent}%</Typography></ToggleButton>)}
    </ToggleButtonGroup>
    {state && <Alert severity={state.applied ? "success" : "warning"} icon={false} sx={{ mb: 2 }}>{state.applied ? `已生效：CPU 上限 ${state.verified_cpu_percent ?? state.cpu_percent}%（整机总算力）` : `尚未生效：${state.error || "等待识别程序启动"}`}</Alert>}
    <Stack spacing={1}>
      <Typography variant="body2">显卡一次运行一个识别任务，避免多个视频抢占资源。</Typography>
      <Typography variant="caption" color="text.secondary">色彩还原跟随此档位，最多约 5 秒生效。人脸处理和色彩还原分别应用上限，同时运行时两者的占用会叠加。</Typography>
      <Typography variant="caption" color="text.secondary">CPU 限制同时覆盖后续启动的视频解码进程。轻量、均衡模式降低后台优先级，影响速度，不降低采样精度。</Typography>
      <Typography variant="caption" color="text.secondary">GPU 占用率和显存暂不能设置固定硬上限；处理高分辨率视频时仍可能短时升高。</Typography>
    </Stack>
    <ModelMemoryPanel />
  </Box>;
}

export function ResourceLimitsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth><DialogTitle>资源占用</DialogTitle><DialogContent>{open && <ResourceLimitsPanel />}</DialogContent><DialogActions><Button onClick={onClose}>完成</Button></DialogActions></Dialog>;
}
