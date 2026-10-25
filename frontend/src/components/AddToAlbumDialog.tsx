import React, { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  List,
  ListItemButton,
  ListItemText,
  TextField,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import {
  addMediaToAlbum,
  createAlbum,
  getAlbums,
} from "../services/features";
import { Album } from "../types";

interface Props {
  open: boolean;
  mediaIds: number[];
  onClose: () => void;
  onAdded: (album: Album) => void;
}

export const AddToAlbumDialog: React.FC<Props> = ({
  open,
  mediaIds,
  onClose,
  onAdded,
}) => {
  const [albums, setAlbums] = useState<Album[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    getAlbums()
      .then(setAlbums)
      .catch((err) =>
        setError(err instanceof Error ? err.message : "加载相册失败")
      )
      .finally(() => setLoading(false));
  }, [open]);

  const addTo = async (albumId: number) => {
    setBusy(true);
    setError(null);
    try {
      const album = await addMediaToAlbum(albumId, mediaIds);
      onAdded(album);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "添加媒体文件失败");
    } finally {
      setBusy(false);
    }
  };

  const createAndAdd = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const album = await createAlbum(name);
      const updated = await addMediaToAlbum(album.id, mediaIds);
      setNewName("");
      onAdded(updated);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建相册失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>
        {" 添加 "}{mediaIds.length} {" 个项目"}{mediaIds.length === 1 ? "" : ""} {" 到相册 "}</DialogTitle>
      <DialogContent dividers>
        {error && (
          <Alert severity="error" sx={{ mb: 1 }}>
            {error}
          </Alert>
        )}
        <Box sx={{ display: "flex", gap: 1, mb: 1.5 }}>
          <TextField
            size="small"
            fullWidth
            placeholder="新相册名称"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void createAndAdd();
            }}
            disabled={busy}
          />
          <Button
            variant="contained"
            disableElevation
            startIcon={<AddIcon />}
            onClick={createAndAdd}
            disabled={busy || !newName.trim()}
          >
            {" 创建 "}</Button>
        </Box>
        {loading ? (
          <Box textAlign="center" py={2}>
            <CircularProgress size={24} />
          </Box>
        ) : (
          <List dense>
            {albums.map((album) => (
              <ListItemButton
                key={album.id}
                onClick={() => addTo(album.id)}
                disabled={busy}
              >
                <ListItemText
                  primary={album.name}
                  secondary={("{0} 个项目{1}".replace(/\{(\d+)\}/g, (_, i) => String([album.media_count, album.media_count === 1 ? "" : "s"][Number(i)])))}
                />
              </ListItemButton>
            ))}
          </List>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          {" 取消 "}</Button>
      </DialogActions>
    </Dialog>
  );
};
