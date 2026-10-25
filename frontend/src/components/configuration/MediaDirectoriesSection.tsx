import { useState } from "react";
import {
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  Grid,
  IconButton,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/Delete";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import { pickDirectory } from "../../services/config";
import { AppConfig, MediaDirectory } from "../../types";
import { normalizeMediaDirPath } from "./mediaDirs";
import { ConfigUpdate } from "./shared";

interface MediaDirRemovalDialogState {
  open: boolean;
  index: number;
  path: string;
  acknowledged: boolean;
}

const CLOSED_DIALOG: MediaDirRemovalDialogState = {
  open: false,
  index: -1,
  path: "",
  acknowledged: false,
};

interface MediaDirectoriesSectionProps {
  config: AppConfig;
  onChange: ConfigUpdate;
  /** Records that the user confirmed removing this (normalized) path. */
  onAcknowledgeRemoval: (normalizedPath: string) => void;
}

export default function MediaDirectoriesSection({
  config,
  onChange,
  onAcknowledgeRemoval,
}: MediaDirectoriesSectionProps) {
  const [removeMediaDirDialog, setRemoveMediaDirDialog] =
    useState<MediaDirRemovalDialogState>(CLOSED_DIALOG);

  const setMediaDirs = (
    update: (dirs: MediaDirectory[]) => MediaDirectory[]
  ) =>
    onChange((prev) => ({
      ...prev,
      general: { ...prev.general, media_dirs: update(prev.general.media_dirs) },
    }));

  const updateMediaDir = (index: number, patch: Partial<MediaDirectory>) =>
    setMediaDirs((dirs) => {
      const next = [...(dirs ?? [])];
      const existing = next[index] ?? { path: "", read_only: false };
      next[index] = { ...existing, ...patch };
      return next;
    });

  const addMediaDir = async () => {
    const chosen = await pickDirectory();
    if (!chosen) return;
    const value = chosen;
    setMediaDirs((dirs) => [...(dirs ?? []), { path: value, read_only: false }]);
  };

  const browseMediaDir = async (index: number) => {
    const path = await pickDirectory();
    if (path) {
      updateMediaDir(index, { path });
    }
  };

  const requestRemoveMediaDir = (index: number) => {
    const currentPath =
      (config.general.media_dirs?.[index]?.path ?? "").trim() || "(empty path)";
    setRemoveMediaDirDialog({
      open: true,
      index,
      path: currentPath,
      acknowledged: false,
    });
  };

  const closeRemoveMediaDirDialog = () => setRemoveMediaDirDialog(CLOSED_DIALOG);

  const confirmRemoveMediaDir = () => {
    const index = removeMediaDirDialog.index;
    const removedPath = normalizeMediaDirPath(removeMediaDirDialog.path);
    if (index < 0) return;
    setMediaDirs((dirs) => dirs.filter((_, i) => i !== index));
    if (removedPath) {
      onAcknowledgeRemoval(removedPath);
    }
    closeRemoveMediaDirDialog();
  };

  return (
    <Grid size={{ xs: 12 }}>
      <Typography variant="h6" sx={{ mt: 2, mb: 1 }}>
        {" 媒体目录 "}</Typography>

      {(config.general.media_dirs ?? []).map((dir, idx) => (
        <Box key={idx} sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <TextField
            fullWidth
            margin="normal"
            label={("媒体目录 #{0}".replace(/\{(\d+)\}/g, (_, i) => String([idx + 1][Number(i)])))}
            value={dir?.path ?? ""}
            onChange={(e) => updateMediaDir(idx, { path: e.target.value })}
            sx={{ flex: 1 }}
            helperText="绝对路径。"
          />
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={Boolean(dir?.read_only)}
                onChange={(e) =>
                  updateMediaDir(idx, { read_only: e.target.checked })
                }
              />
            }
            label="只读"
            sx={{ ml: 1, mr: 0 }}
          />
          <IconButton
            aria-label={("浏览媒体目录 #{0}".replace(/\{(\d+)\}/g, (_, i) => String([idx + 1][Number(i)])))}
            onClick={() => browseMediaDir(idx)}
            size="large"
          >
            <FolderOpenIcon />
          </IconButton>
          <IconButton
            aria-label={("移除媒体目录 #{0}".replace(/\{(\d+)\}/g, (_, i) => String([idx + 1][Number(i)])))}
            onClick={() => requestRemoveMediaDir(idx)}
            size="large"
          >
            <DeleteIcon />
          </IconButton>
        </Box>
      ))}

      <Button
        startIcon={<AddIcon />}
        variant="outlined"
        onClick={addMediaDir}
        sx={{ mt: 1 }}
      >
        {" 添加目录 "}</Button>

      <Dialog
        open={removeMediaDirDialog.open}
        onClose={closeRemoveMediaDirDialog}
        maxWidth="sm"
        fullWidth
        aria-labelledby="remove-media-dir-dialog-title"
      >
        <DialogTitle id="remove-media-dir-dialog-title">
          {" 移除媒体目录 "}</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            {" 从配置中移除此媒体目录后，保存时将从 Omoide 中移除该路径下所有已索引的媒体记录。磁盘上的原始文件不会被删除。 "}</DialogContentText>
          <DialogContentText sx={{ mb: 2 }}>
            {" 目录： "}<code>{removeMediaDirDialog.path}</code>
          </DialogContentText>
          <FormControlLabel
            control={
              <Checkbox
                checked={removeMediaDirDialog.acknowledged}
                onChange={(e) =>
                  setRemoveMediaDirDialog((prev) => ({
                    ...prev,
                    acknowledged: e.target.checked,
                  }))
                }
              />
            }
            label="我明白保存后该目录下已索引的媒体将被移除。"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={closeRemoveMediaDirDialog}>{"取消"}</Button>
          <Button
            color="error"
            variant="contained"
            onClick={confirmRemoveMediaDir}
            disabled={!removeMediaDirDialog.acknowledged}
          >
            {" 移除目录 "}</Button>
        </DialogActions>
      </Dialog>
    </Grid>
  );
}
