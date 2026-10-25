import React from "react";
import { Alert, Button, FormControlLabel, Stack, Switch, Typography } from "@mui/material";
import { Link } from "react-router-dom";
import { useVideoLibrary } from "../context/VideoLibraryContext";

export function RestoredOriginalsNotice({ folder = "", onViewOutputs }: { folder?: string; onViewOutputs?: () => void }) {
  const { hiddenOriginals, showRestoredOriginals, setShowRestoredOriginals, visibilityError, isInDirectory } = useVideoLibrary();
  const count = hiddenOriginals.filter(item => !folder || isInDirectory(item.path, folder)).length;
  if (!count && !visibilityError) return null;
  return <Stack gap={1} mb={2}>
    {visibilityError && <Alert severity="warning">{visibilityError}</Alert>}
    {!!count && <Alert severity="info" icon={false} sx={{ "& .MuiAlert-message": { width: "100%" } }}>
      <Stack direction={{ xs: "column", lg: "row" }} gap={1} alignItems={{ lg: "center" }}>
        <Typography variant="body2" sx={{ flex: 1 }}>{showRestoredOriginals ? `正在显示 ${count} 个已还原原片` : `已隐藏 ${count} 个已还原原片`}，原文件保留。</Typography>
        <FormControlLabel sx={{ m: 0 }} control={<Switch size="small" checked={showRestoredOriginals} onChange={(_, checked) => setShowRestoredOriginals(checked)} />} label={<Typography variant="body2">显示已还原原片</Typography>} />
        {onViewOutputs ? <Button size="small" onClick={onViewOutputs}>查看还原成片</Button> : <Button size="small" component={Link} to="/film?tab=jobs">查看还原成片</Button>}
      </Stack>
    </Alert>}
  </Stack>;
}
