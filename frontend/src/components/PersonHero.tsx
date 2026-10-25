import { withMediaCacheScope } from "../urlUtils";
import React, { useEffect, useState } from "react";
import {
  Box,
  Typography,
  Avatar,
  Stack,
  Button,
  Paper,
  useTheme,
  CircularProgress,
  IconButton,
  Tooltip,
} from "@mui/material";
import FavoriteIcon from "@mui/icons-material/Favorite";
import FavoriteBorderIcon from "@mui/icons-material/FavoriteBorder";
import { alpha } from "@mui/material/styles";
import Grid from "@mui/material/Grid";
import { Person } from "../types";
import { PersonEditForm } from "./PersonEditForm";
import config, { API } from "../config";
import { encodeFilePath } from "../urlUtils";
import { setPersonFavorite } from "../services/personActions";

interface PersonHeroProps {
  person: Person;
  onSave: (formData: { name: string }) => Promise<void>;
  onMerge: () => void;
  onDelete: () => void;
  onRefreshSimilar: () => void;
  onAutoSelectProfile: () => void;
  onExportMedia: () => void;
  saving: boolean;
  autoSelectingProfile: boolean;
  canExportMedia: boolean;
  exportingMedia: boolean;
}

export function PersonHero({
  person,
  onSave,
  onMerge,
  onDelete,
  onRefreshSimilar,
  onAutoSelectProfile,
  onExportMedia,
  saving,
  autoSelectingProfile,
  canExportMedia,
  exportingMedia,
}: PersonHeroProps) {
  const theme = useTheme();
  const [isFavorite, setIsFavorite] = useState(Boolean(person.is_favorite));

  useEffect(() => {
    setIsFavorite(Boolean(person.is_favorite));
  }, [person.id, person.is_favorite]);

  const handleToggleFavorite = () => {
    const next = !isFavorite;
    setIsFavorite(next);
    setPersonFavorite(person.id, next).catch(() => setIsFavorite(!next));
  };

  const thumbUrl = person.profile_face?.thumbnail_path
    ? withMediaCacheScope(`${API}/thumbnails/${encodeFilePath(
        person.profile_face.thumbnail_path
      )}`)
    : undefined;

  return (
    <Box sx={{ mb: 3, bgcolor: "background.paper", border: "1px solid", borderColor: "divider", borderRadius: 1.5, p: { xs: 2, md: 2.5 } }}>
      {/* CORRECTED: Using the standard Grid component with your project's 'size' prop syntax */}
      <Grid container spacing={{ xs: 2, md: 3 }} alignItems="center">
        {/* Profile Avatar */}
        <Grid size={{ xs: 12, sm: 3, md: 2 }} sx={{ textAlign: "center" }}>
          <Avatar
            src={thumbUrl}
            sx={{
              width: { xs: 88, md: 100 },
              height: { xs: 88, md: 100 },
              borderRadius: 2,
              mx: "auto",
              border: `4px solid ${theme.palette.background.paper}`,
              boxShadow: "none",
            }}
          />
        </Grid>

        {/* Person Details and Actions */}
        <Grid size={{ xs: 12, sm: 9, md: 10 }}>
          <Stack direction="row" alignItems="center" spacing={1}>
            <Typography variant="h4" component="h1" fontWeight={650}>
              {person.name || "未命名人物"}
            </Typography>
            {config.PRESENTATION_MODE ? (
              isFavorite && (
                <FavoriteIcon color="error" aria-label="收藏" />
              )
            ) : (
              <Tooltip
                title={isFavorite ? "从收藏中移除" : "添加到收藏"}
              >
                <IconButton
                  onClick={handleToggleFavorite}
                  aria-label={
                    isFavorite ? "从收藏中移除" : "添加到收藏"
                  }
                  aria-pressed={isFavorite}
                  sx={{ color: isFavorite ? "error.main" : "text.secondary" }}
                >
                  {isFavorite ? <FavoriteIcon /> : <FavoriteBorderIcon />}
                </IconButton>
              </Tooltip>
            )}
          </Stack>
          <Typography variant="body1" color="text.secondary" gutterBottom>
            {person.appearance_count
              ? `关联 ${person.appearance_count} 个照片或视频文件`
              : "无出现记录"}
          </Typography>

          {!config.PRESENTATION_MODE && (
            <Stack
              direction="row"
              spacing={1}
              mt={2}
              mb={3}
              flexWrap="wrap"
              useFlexGap
            >
              <Button variant="outlined" onClick={onMerge} disabled={saving}>
                {" 合并 "}</Button>
              <Button
                variant="outlined"
                onClick={() => onRefreshSimilar()}
                disabled={saving}
              >
                {" 刷新相似 "}</Button>
              <Button
                variant="outlined"
                onClick={onAutoSelectProfile}
                disabled={saving || autoSelectingProfile}
              >
                {autoSelectingProfile ? (
                  <CircularProgress size={18} thickness={5} />
                ) : (
                  "自动精选头像"
                )}
              </Button>
              {canExportMedia && (
                <Button
                  variant="outlined"
                  onClick={onExportMedia}
                  disabled={saving || exportingMedia}
                >
                  {exportingMedia ? (
                    <CircularProgress size={18} thickness={5} />
                  ) : (
                    "导出 / 复制媒体…"
                  )}
                </Button>
              )}
              <Button
                variant="outlined"
                color="error"
                onClick={onDelete}
                disabled={saving}
              >
                {" 删除 "}</Button>
            </Stack>
          )}
        </Grid>
      </Grid>

      {/* The Edit Form is now more cleanly integrated */}
      {!config.PRESENTATION_MODE && (
        <Paper
          sx={{
            p: { xs: 2, md: 3 },
            bgcolor: (theme) =>
              theme.palette.mode === 'dark'
                ? alpha(theme.palette.common.white, 0.05)
                : alpha(theme.palette.common.black, 0.02),
            mt: 4,
            borderRadius: 3,
          }}
        >
          <PersonEditForm
            initialPersonData={{ name: person.name ?? "" }}
            onSave={onSave}
            saving={saving}
          />
        </Paper>
      )}
    </Box>
  );
}
