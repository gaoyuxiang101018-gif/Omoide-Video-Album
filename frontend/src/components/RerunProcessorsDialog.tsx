import React, { useState } from "react";
import {
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  FormGroup,
  Typography,
} from "@mui/material";
import { runProcessorsForMedia } from "../services/taskActions";

const PROCESSORS = [
  { name: "faces", label: "人脸检测" },
  { name: "embedding_extractor", label: "图像特征" },
  { name: "auto_tagger", label: "自动标签" },
  { name: "blur", label: "模糊评分" },
  { name: "exif", label: "EXIF 数据" },
];

interface Props {
  open: boolean;
  mediaIds: number[];
  onClose: () => void;
  onStarted: () => void;
}

export const RerunProcessorsDialog: React.FC<Props> = ({
  open,
  mediaIds,
  onClose,
  onStarted,
}) => {
  const [selected, setSelected] = useState<Set<string>>(new Set(["faces"]));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const handleRun = async () => {
    if (selected.size === 0) return;
    setLoading(true);
    setError(null);
    try {
      await runProcessorsForMedia(mediaIds, Array.from(selected));
      onStarted();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "未知错误");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>
        {" 重新运行处理器 "}<Typography variant="body2" color="text.secondary" mt={0.5}>
          {mediaIds.length} {" 个项目"}{mediaIds.length !== 1 ? "" : ""} {" 已选择 "}</Typography>
      </DialogTitle>
      <DialogContent>
        <FormGroup>
          {PROCESSORS.map((p) => (
            <FormControlLabel
              key={p.name}
              control={
                <Checkbox
                  checked={selected.has(p.name)}
                  onChange={() => toggle(p.name)}
                  disabled={loading}
                />
              }
              label={p.label}
            />
          ))}
        </FormGroup>
        {error && (
          <Typography color="error" variant="body2" mt={1}>
            {error}
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={loading}>
          {" 取消 "}</Button>
        <Button
          onClick={handleRun}
          variant="contained"
          disabled={loading || selected.size === 0}
          startIcon={loading ? <CircularProgress size={16} /> : undefined}
        >
          {" 运行 "}</Button>
      </DialogActions>
    </Dialog>
  );
};
