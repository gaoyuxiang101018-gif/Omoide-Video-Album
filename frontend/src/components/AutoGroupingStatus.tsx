import React, { useEffect, useState } from "react";
import { Box, Tooltip, Typography } from "@mui/material";

export function AutoGroupingStatus() {
  const [state, setState] = useState<{ enabled: boolean; phase: string; updated_at: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => {
      setNow(Date.now());
      fetch(`${import.meta.env.BASE_URL}auto-group-status.json`, { cache: "no-store", signal: controller.signal }).then(response => response.ok ? response.json() : null).then(value => { if (value?.updated_at) setState(value); }).catch(() => {});
    };
    refresh(); const timer = window.setInterval(refresh, 6000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, []);
  const online = !!state && now / 1000 - state.updated_at < 30;
  const ready = online && state.enabled && state.phase !== "error";
  const label = !online ? "自动归类未连接" : !state?.enabled ? "自动归类已关闭" : state.phase === "grouping" ? "正在自动归类" : state.phase === "waiting" ? "识别后自动归类" : state.phase === "error" ? "自动归类需重试" : "自动归类已开启";
  return <Tooltip title={ready ? "识别完成后会自动归类人物，同一视频的多帧也可以建立人物。" : "通过桌面快捷方式打开软件可启动自动归类；也可在任务面板立即重新归类。"}><Box sx={{ display: { xs: "none", lg: "flex" }, alignItems: "center", gap: 0.8, whiteSpace: "nowrap" }}><Box sx={{ width: 6, height: 6, borderRadius: "50%", bgcolor: ready ? "success.main" : "warning.main" }} /><Typography variant="caption" color="text.secondary">{label}</Typography></Box></Tooltip>;
}
