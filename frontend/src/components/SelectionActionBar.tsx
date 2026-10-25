import React, { useState } from "react";
import {
  Button,
  Chip,
  Fade,
  Paper,
  Snackbar,
  Alert,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import ReplayIcon from "@mui/icons-material/Replay";
import PhotoAlbumIcon from "@mui/icons-material/PhotoAlbum";
import { useSelection } from "../context/SelectionContext";
import { RerunProcessorsDialog } from "./RerunProcessorsDialog";
import { AddToAlbumDialog } from "./AddToAlbumDialog";
import config from "../config";
import FaceOutlinedIcon from "@mui/icons-material/FaceOutlined";
import { runProcessorsForMedia } from "../services/taskActions";
import { useTaskEvents } from "../TaskEventsContext";
import { useVideoLibrary } from "../context/VideoLibraryContext";

export const SelectionActionBar: React.FC = () => {
  const { selectedIds, clear } = useSelection();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [albumDialogOpen, setAlbumDialogOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const { activeTasks, forceRefresh } = useTaskEvents();
  const recognitionBusy = activeTasks.some(task => ["process_media", "run_processor", "run_processor_for_media"].includes(task.task_type) && ["pending", "running"].includes(task.status));
  const { recognitionStates, activityReady, globalRecognitionBusy } = useVideoLibrary();
  const selectedReserved = Array.from(selectedIds).some(id => recognitionStates.has(id));
  const recognitionBlocked = !activityReady || globalRecognitionBusy || selectedReserved;
  const [snackbar, setSnackbar] = useState<{
    open: boolean;
    message: string;
    severity?: "success" | "error";
  }>({ open: false, message: "" });

  const count = selectedIds.size;

  if (config.PRESENTATION_MODE) return null;

  const recognize = async () => {
    if (starting || recognitionBlocked || !count) return;
    setStarting(true);
    try {
      await runProcessorsForMedia(Array.from(selectedIds), ["faces"]);
      await forceRefresh(); clear();
      setSnackbar({ open: true, message: "所选视频已加入识别队列，完成后将自动归类人物。", severity: "success" });
      window.dispatchEvent(new Event("omoide-open-tasks"));
    } catch (error) { setSnackbar({ open: true, message: error instanceof Error ? error.message : "识别未能启动，请重试。", severity: "error" }); }
    finally { setStarting(false); }
  };

  return (
    <>
      <Fade in={count > 0}>
        <Paper
          elevation={4}
          sx={{
            position: "fixed",
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 1250,
            px: 2,
            py: 1,
            display: "flex",
            alignItems: "center",
            gap: 1.5,
            borderRadius: 1.5,
            border: "1px solid",
            borderColor: "divider",
            flexWrap: "wrap",
            justifyContent: "center",
            bgcolor: "background.paper",
            maxWidth: "calc(100vw - 32px)",
          }}
        >
          <Chip label={("已选 {0} 个".replace(/\{(\d+)\}/g, (_, i) => String([count][Number(i)])))} size="small" color="primary" />
          <Button variant="contained" startIcon={<FaceOutlinedIcon />} onClick={recognize} disabled={starting || recognitionBlocked}>{starting ? "正在加入…" : !activityReady ? "核对任务…" : globalRecognitionBusy ? "全库识别进行中" : selectedReserved ? "已在识别队列" : recognitionBusy ? "加入识别队列" : "识别所选"}</Button>
          <Button
            size="small"
            startIcon={<PhotoAlbumIcon fontSize="small" />}
            onClick={() => setAlbumDialogOpen(true)}
            variant="text"
            disableElevation
          >
            {" 添加到相册 "}</Button>
          <Button
            size="small"
            startIcon={<ReplayIcon fontSize="small" />}
            onClick={() => setDialogOpen(true)}
            variant="text"
            disableElevation
          >
            {" 更多分析 "}</Button>
          <Button
            size="small"
            startIcon={<CloseIcon fontSize="small" />}
            onClick={clear}
            color="inherit"
          >
            {" 清除 "}</Button>
        </Paper>
      </Fade>

      <RerunProcessorsDialog
        open={dialogOpen}
        mediaIds={Array.from(selectedIds)}
        onClose={() => setDialogOpen(false)}
        onStarted={() =>
          setSnackbar({ open: true, message: "处理已开始。" })
        }
      />

      <AddToAlbumDialog
        open={albumDialogOpen}
        mediaIds={Array.from(selectedIds)}
        onClose={() => setAlbumDialogOpen(false)}
        onAdded={(album) => {
          setSnackbar({
            open: true,
            message: ("已添加到“{0}”。".replace(/\{(\d+)\}/g, (_, i) => String([album.name][Number(i)]))),
          });
          clear();
        }}
      />

      <Snackbar
        open={snackbar.open}
        autoHideDuration={4000}
        onClose={() => setSnackbar((s) => ({ ...s, open: false }))}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert severity={snackbar.severity ?? "success"} variant="filled" sx={{ width: "100%" }}>
          {snackbar.message}
        </Alert>
      </Snackbar>
    </>
  );
};
