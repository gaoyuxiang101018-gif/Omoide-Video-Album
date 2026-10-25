import React, { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Container,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  TextField,
  Typography,
} from "@mui/material";
import TheatersIcon from "@mui/icons-material/Theaters";
import EditIcon from "@mui/icons-material/Edit";
import PhotoAlbumIcon from "@mui/icons-material/PhotoAlbum";
import { useNavigate, useParams } from "react-router-dom";
import config from "../config";
import { CursorMediaGrid } from "../components/CursorMediaGrid";
import { EmptyState } from "../components/EmptyState";
import {
  convertEventToAlbum,
  getEvent,
  getEventMedia,
  updateEvent,
} from "../services/features";
import { EventItem } from "../types";

export default function EventDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const eventId = Number(id);
  const [event, setEvent] = useState<EventItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [isSavingTitle, setIsSavingTitle] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);
  const [isConverting, setIsConverting] = useState(false);

  useEffect(() => {
    if (!Number.isFinite(eventId)) return;
    getEvent(eventId)
      .then(setEvent)
      .catch((err) =>
        setError(err instanceof Error ? err.message : "加载事件失败")
      );
  }, [eventId]);

  const fetcher = useCallback(
    (cursor: string | null, signal: AbortSignal) =>
      getEventMedia(eventId, cursor, signal),
    [eventId]
  );

  const dateRange = event
    ? `${new Date(event.start_at).toLocaleDateString()} – ${new Date(
        event.end_at
      ).toLocaleDateString()}`
    : "";

  if (!config.EVENTS_ENABLED) {
    return (
      <Typography variant="h5" color="text.primary" gutterBottom>
        {" 事件已禁用！ "}</Typography>
    );
  }

  const startRenaming = () => {
    setTitleDraft(event?.title || "");
    setIsRenaming(true);
  };

  const saveTitle = async () => {
    const title = titleDraft.trim();
    if (!title || !event) {
      setIsRenaming(false);
      return;
    }
    setIsSavingTitle(true);
    try {
      const updated = await updateEvent(event.id, title);
      setEvent(updated);
      setIsRenaming(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "重命名事件失败");
    } finally {
      setIsSavingTitle(false);
    }
  };

  const handleConvert = async () => {
    if (!event) return;
    setIsConverting(true);
    try {
      const album = await convertEventToAlbum(event.id);
      navigate(`/album/${album.id}`);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "转换事件失败"
      );
      setIsConverting(false);
      setConvertOpen(false);
    }
  };

  return (
    <Container maxWidth="xl" sx={{ minHeight: "100vh", py: 4 }}>
      <Box display="flex" alignItems="center" gap={1} mb={1} flexWrap="wrap">
        <TheatersIcon color="primary" />
        {isRenaming ? (
          <>
            <TextField
              size="small"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              autoFocus
              disabled={isSavingTitle}
            />
            <Button
              size="small"
              onClick={saveTitle}
              disabled={isSavingTitle || !titleDraft.trim()}
            >
              {" 保存 "}</Button>
            <Button
              size="small"
              onClick={() => setIsRenaming(false)}
              disabled={isSavingTitle}
            >
              {" 取消 "}</Button>
          </>
        ) : (
          <>
            <Typography variant="h5" fontWeight={700}>
              {event?.title || dateRange || "事件"}
            </Typography>
            {event && !config.PRESENTATION_MODE && (
              <IconButton aria-label="重命名事件" size="small" onClick={startRenaming}>
                <EditIcon fontSize="small" />
              </IconButton>
            )}
          </>
        )}
        <Box flexGrow={1} />
        {event && !config.PRESENTATION_MODE && (
          <Button
            variant="outlined"
            size="small"
            startIcon={<PhotoAlbumIcon />}
            onClick={() => setConvertOpen(true)}
          >
            {" 转换为相册 "}</Button>
        )}
      </Box>
      <Typography variant="body2" color="text.secondary" mb={3}>
        {event ? ("{0} · {1} 个项目".replace(/\{(\d+)\}/g, (_, i) => String([dateRange, event.media_count][Number(i)]))) : ""}
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <CursorMediaGrid
        listKey={`event-${eventId}`}
        fetcher={fetcher}
        empty={
          <EmptyState
            icon={<TheatersIcon />}
            title="无媒体"
            description="此事件没有媒体。"
          />
        }
      />

      <Dialog open={convertOpen} onClose={() => setConvertOpen(false)}>
        <DialogTitle>{"将事件转换为相册？"}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {" 这将创建一个包含此事件媒体的新相册并移除该事件。此操作无法撤销（但将来运行“重建事件”可能会从相同媒体重新创建类似事件）。 "}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConvertOpen(false)} disabled={isConverting}>
            {" 取消 "}</Button>
          <Button
            onClick={handleConvert}
            variant="contained"
            disabled={isConverting}
          >
            {" 转换 "}</Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
}
