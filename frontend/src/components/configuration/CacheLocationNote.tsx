import React, { useEffect, useState } from "react";
import { Alert, Typography } from "@mui/material";

export function CacheLocationNote() {
  const [root, setRoot] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${import.meta.env.BASE_URL}cache-location.json`, { signal: controller.signal }).then(response => response.ok ? response.json() : null).then(data => { if (typeof data?.root === "string") setRoot(data.root); }).catch(() => {});
    return () => controller.abort();
  }, []);
  return root ? <Alert severity="info" icon={false} sx={{ mb: 2 }}><Typography variant="body2">缓存存储位置：{root}</Typography><Typography variant="caption">模型、视频封面和软件浏览缓存均存放在此。人物数据库和原视频保留原位置。</Typography></Alert> : null;
}
