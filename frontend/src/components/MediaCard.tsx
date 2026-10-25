import { withMediaCacheScope } from "../urlUtils";
import React, { useState, useRef, useEffect } from "react";
import { useLocation, Link } from "react-router-dom";
import {
  Card,
  CardActionArea,
  CardMedia,
  Box,
  Checkbox,
  Typography,
} from "@mui/material";
import { MediaPreview } from "../types";
import appConfig, { API } from "../config";
import { encodeFilePath } from "../urlUtils";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import PlayCircleOutlineIcon from "@mui/icons-material/PlayCircleOutline";
import FavoriteIcon from "@mui/icons-material/Favorite";
import FavoriteBorderIcon from "@mui/icons-material/FavoriteBorder";
import LinkOffIcon from "@mui/icons-material/LinkOff";
import {
  useIsSelected,
  useIsSelecting,
  useToggleSelected,
} from "../context/SelectionContext";
import { setMediaFavorite } from "../services/mediaActions";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import { captureDate, formatVideoDuration, RecognitionState } from "../albumUtils";
import type { VideoFaceStatus } from "../context/VideoLibraryContext";

function formatDuration(d?: number): string {
  return formatVideoDuration(d);
}

const WINDOWS_ABS_RE = /^[a-zA-Z]:[\\/]/;

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || WINDOWS_ABS_RE.test(value);
}

function toFileUri(value: string): string | null {
  if (!value) return null;
  const normalized = value.replace(/\\/g, "/");
  if (!isAbsolutePath(normalized)) return null;
  if (WINDOWS_ABS_RE.test(normalized)) {
    return `file:///${encodeURI(normalized)}`;
  }
  return `file://${encodeURI(normalized)}`;
}

function guessMimeType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "bmp":
      return "image/bmp";
    case "webp":
      return "image/webp";
    case "tif":
    case "tiff":
      return "image/tiff";
    default:
      return "application/octet-stream";
  }
}

interface MediaNavigationContext {
  ids: number[];
}

interface MediaCardProps {
  media: MediaPreview;
  mediaListKey?: string;
  navigationContext?: MediaNavigationContext;
  onUnmatch?: () => void;
  unmatchLabel?: string;
  albumStyle?: boolean;
  hoverPreview?: boolean;
  faceStatus?: VideoFaceStatus;
  recognitionState?: RecognitionState;
}

function MediaCard({
  media,
  mediaListKey,
  navigationContext,
  onUnmatch,
  unmatchLabel = "取消与人物匹配",
  albumStyle = false,
  hoverPreview = false,
  faceStatus,
  recognitionState,
}: MediaCardProps) {
  // Narrow subscriptions: a card only re-renders when its own selection
  // state (or selection mode) changes.
  const isSelecting = useIsSelecting();
  const toggle = useToggleSelected();
  const isSelected = useIsSelected(media?.id);
  // This state now explicitly controls when the video player is active.
  const [isPlayerActive, setIsPlayerActive] = useState(false);
  const [playerUrl, setPlayerUrl] = useState<string | null>(null);
  const hoverTimeoutRef = useRef<number | null>(null);
  const hasInitializedPlayerRef = useRef(false);
  const location = useLocation();
  const [isFavorite, setIsFavorite] = useState(!!media?.is_favorite);
  const memeModeEnabled = appConfig.MEME_MODE;
  const isGif =
    media != null
      ? media.filename.toLowerCase().endsWith(".gif") ||
        media.path.toLowerCase().endsWith(".gif")
      : false;
  const useOriginalGif = memeModeEnabled && isGif;

  const isVideo = media ? typeof media.duration === "number" && !isGif : false;
  const isDraggable = !!media && !isVideo;

  const mediaUrl = media
    ? `${API}/originals/${encodeFilePath(media.path)}`
    : `${API}/static/brand/404.png`;
  const filename = media ? media.filename : "404 Not found";
  const mediaId = media ? media.id : null;
  let thumbUrl;
  if (media) {
    if (useOriginalGif) {
      thumbUrl = mediaUrl;
    } else if (media.thumbnail_path) {
      thumbUrl = withMediaCacheScope(`${API}/thumbnails/${encodeFilePath(media.thumbnail_path)}`);
    } else {
      thumbUrl = withMediaCacheScope(`${API}/thumbnails/${media.id}.jpg`);
    }
  } else {
    thumbUrl = `${API}/static/brand/404.png`;
  }
  const linkState = {
    backgroundLocation: location.state?.backgroundLocation || location,
    mediaListKey,
    media,
    navigationContext,
  };

  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    // Reset player state when card content changes (e.g., reused component).
    setIsPlayerActive(false);
    setPlayerUrl(null);
    hasInitializedPlayerRef.current = false;
  }, [mediaId, mediaUrl]);

  useEffect(() => {
    setIsFavorite(!!media?.is_favorite);
  }, [mediaId, media?.is_favorite]);

  const handleToggleFavorite = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (mediaId == null) return;
    const next = !isFavorite;
    setIsFavorite(next);
    setMediaFavorite(mediaId, next).catch(() => {
      setIsFavorite(!next);
    });
  };

  const handleMouseEnter = () => {
    hoverTimeoutRef.current = window.setTimeout(() => {
      if (!hasInitializedPlayerRef.current) {
        hasInitializedPlayerRef.current = true;
        setPlayerUrl(mediaUrl);
      }
      setIsPlayerActive(true);
    }, 650);
  };

  const handleMouseLeave = () => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
    }
    setIsPlayerActive(false);
    setPlayerUrl(null);
    hasInitializedPlayerRef.current = false;
  };

  const handleDragStart = (event: React.DragEvent<HTMLElement>) => {
    if (!media || isVideo) return;
    const filePath = media.path;
    const fileUri = toFileUri(filePath);
    const fallbackUri = fileUri ?? mediaUrl;
    const downloadUrl = mediaUrl;

    event.dataTransfer.effectAllowed = "copy";
    const uriList = [downloadUrl, fileUri].filter(Boolean).join("\r\n");
    event.dataTransfer.setData("text/uri-list", uriList || downloadUrl);
    event.dataTransfer.setData(
      "text/plain",
      isAbsolutePath(filePath) ? filePath : fallbackUri
    );
    event.dataTransfer.setData(
      "DownloadURL",
      `${guessMimeType(media.filename)}:${media.filename}:${downloadUrl}`
    );
    event.dataTransfer.setData("text/html", `<img src="${mediaUrl}">`);
    event.stopPropagation();
  };

  return (
    <Card
      data-media-id={mediaId}
      data-face-status={faceStatus}
      data-recognition-state={recognitionState}
      elevation={0}
      sx={{
        borderRadius: albumStyle ? 1.25 : 2,
        overflow: "hidden",
        position: "relative",
        transition: "box-shadow 0.15s ease",
        border: albumStyle ? "1px solid" : undefined,
        borderColor: "divider",
        backgroundColor: "background.paper",
        outline: isSelected ? "3px solid" : "none",
        outlineColor: isSelected ? "primary.main" : "transparent",
        "&:hover": {
          transform: "none",
          boxShadow: isSelecting
            ? "none"
            : "0 3px 12px rgba(20, 35, 60, 0.08)",
          zIndex: 10,
          "& .media-overlay": {
            opacity: 1,
          },
        },
      }}
    >
      <Link
        to={`/medium/${mediaId}`}
        state={linkState}
        replace={!!location.state?.backgroundLocation}
        style={{ textDecoration: "none", color: "inherit" }}
        onClick={
          isSelecting && mediaId != null
            ? (e) => {
                e.preventDefault();
                toggle(mediaId);
              }
            : undefined
        }
      >
          <CardActionArea
            draggable={isDraggable}
            onDragStart={isDraggable ? handleDragStart : undefined}
            onMouseEnter={isVideo && hoverPreview && !isSelecting ? handleMouseEnter : undefined}
            onMouseLeave={isVideo ? handleMouseLeave : undefined}
            sx={{
              position: "relative",
              display: "block",
              width: "100%",
              paddingTop: albumStyle && isVideo ? "62.5%" : "100%",
              cursor: isDraggable ? "grab" : "pointer",
            }}
          >
          <Box
            sx={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: "100%",
              bgcolor: "action.hover", // Placeholder color
            }}
          >
            {/* We now explicitly render the thumbnail image for videos */}
            <CardMedia
              component="img"
              src={thumbUrl}
              alt={filename}
              loading="lazy"
              sx={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
                // The thumbnail is visible when the player is NOT active
                opacity: isPlayerActive ? 0 : 1,
                transition: "opacity 0.3s ease-in-out",
              }}
            />

            {/* The player is only mounted while hovering a video card */}
            {isVideo && playerUrl && (
              <Box
                sx={{
                  width: "100%",
                  height: "100%",
                  // The player is visible ONLY when it's active
                  opacity: isPlayerActive ? 1 : 0,
                  transition: "opacity 0.3s ease-in-out",
                  // Keep pointer events to allow ReactPlayer to be interactive
                }}
              >
                {/* A plain muted, looping <video> is all a hover preview needs. */}
                <video
                  src={playerUrl}
                  autoPlay={isPlayerActive}
                  loop
                  muted
                  playsInline
                  preload="metadata"
                  crossOrigin="anonymous"
                  aria-hidden="true"
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                  }}
                />
              </Box>
            )}
          </Box>

          {/* Play Icon Overlay */}
          {isVideo && (
            <Box
              sx={{
                position: "absolute",
                top: "50%",
                left: "50%",
                transform: "translate(-50%, -50%) scale(0.8)",
                transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
                opacity: isPlayerActive ? 0 : 0.6,
                pointerEvents: "none",
                bgcolor: "rgba(0,0,0,0.3)",
                borderRadius: "50%",
                p: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                backdropFilter: "blur(4px)",
                ".MuiCardActionArea-root:hover &": {
                    transform: "translate(-50%, -50%) scale(1)",
                    opacity: isPlayerActive ? 0 : 1,
                    bgcolor: "rgba(0,0,0,0.5)",
                }
              }}
            >
              <PlayArrowIcon
                sx={{
                  fontSize: "2.5rem",
                  color: "common.white",
                }}
              />
            </Box>
          )}

          {/* Info Overlay */}
          <Box
            className="media-overlay"
            sx={{
              position: "absolute",
              bottom: 0,
              left: 0,
              width: "100%",
              p: albumStyle ? 1 : 2,
              background: "linear-gradient(to top, rgba(0,0,0,0.8) 0%, rgba(0,0,0,0.4) 60%, rgba(0,0,0,0) 100%)",
              pointerEvents: "none",
              opacity: 0.8, // Always slightly visible
              transition: "opacity 0.3s ease-in-out",
            }}
          >
            <Box
              sx={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-end",
              }}
            >
              {isVideo && media ? (
                <Box 
                    display="flex" 
                    alignItems="center" 
                    gap={0.5} 
                    sx={{ 
                        bgcolor: "rgba(0,0,0,0.6)", 
                        borderRadius: 1, 
                        px: 0.8, 
                        py: 0.2,
                        backdropFilter: "blur(4px)"
                    }}
                >
                  <PlayCircleOutlineIcon sx={{ fontSize: "0.9rem", color: "common.white" }} />
                  <Typography variant="caption" sx={{ color: "common.white", fontWeight: 600, letterSpacing: 0.5 }}>
                    {formatDuration(media.duration)}
                  </Typography>
                </Box>
              ) : (
                <div />
              )}
              
              {(media?.width && media?.height) && (
                  <Typography 
                    variant="caption" 
                    sx={{ 
                        color: "rgba(255,255,255,0.9)", 
                        textShadow: "0 1px 2px rgba(0,0,0,0.5)",
                        fontFamily: "monospace",
                        fontSize: "0.7rem"
                    }}
                  >
                    {media.width}×{media.height}
                  </Typography>
              )}
            </Box>
          </Box>
        </CardActionArea>
        {albumStyle && media && (
          <Box sx={{ px: 1.4, py: 1.3 }}>
            <Typography variant="body2" fontWeight={550} noWrap title={filename} sx={{ fontSize: 12.5 }}>{filename}</Typography>
            {media.restored_source_path && <Typography variant="caption" color="primary" sx={{ fontSize: 10.5 }} title={media.restored_source_path}>还原成片 · {media.restored_mode === "hlg" ? "HLG" : "SDR"}</Typography>}
            <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 0.5, mt: 0.8 }}>
              <Typography variant="caption" color="text.secondary" sx={{ fontSize: 11 }}>{captureDate(media.created_at)}</Typography>
              {faceStatus && <Typography variant="caption" sx={{ fontSize: 10.5, whiteSpace: "nowrap", color: faceStatus === "faces" ? "success.main" : "text.secondary", bgcolor: "action.hover", px: 0.6, borderRadius: 0.5 }}>
                {recognitionState ? { running: "识别中", queued: "排队中", completed: "本批已处理", failed: "本批失败" }[recognitionState] : { pending: "待识别", faces: "检测到人脸", empty: "未检测到人脸", unknown: "状态未知" }[faceStatus]}
              </Typography>}
            </Box>
          </Box>
        )}
      </Link>

      {media && !isSelecting && (
        <>
          {!appConfig.PRESENTATION_MODE && (
            <IconButton aria-label={isFavorite ? "从收藏中移除" : "添加到收藏"}
              onClick={handleToggleFavorite}
              size="small"
              sx={{
                position: "absolute",
                top: 4,
                right: 4,
                zIndex: 20,
                p: 0.5,
                color: isFavorite ? "error.main" : "white",
                bgcolor: "rgba(0,0,0,0.45)",
                "&:hover": { bgcolor: "rgba(0,0,0,0.6)" },
              }}
            >
              {isFavorite ? (
                <FavoriteIcon fontSize="small" />
              ) : (
                <FavoriteBorderIcon fontSize="small" />
              )}
            </IconButton>
          )}
          {appConfig.PRESENTATION_MODE && isFavorite && (
            <Box
              aria-label="收藏"
              sx={{
                position: "absolute",
                top: 4,
                right: 4,
                zIndex: 20,
                p: 0.5,
                display: "flex",
                borderRadius: "50%",
                color: "error.main",
                bgcolor: "rgba(0,0,0,0.45)",
                pointerEvents: "none",
              }}
            >
              <FavoriteIcon fontSize="small" />
            </Box>
          )}
          {onUnmatch && !appConfig.PRESENTATION_MODE && (
            <Tooltip title={unmatchLabel}>
              <IconButton
                aria-label={unmatchLabel}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onUnmatch();
                }}
                size="small"
                sx={{
                  position: "absolute",
                  top: 36,
                  right: 4,
                  zIndex: 20,
                  p: 0.5,
                  color: "white",
                  bgcolor: "rgba(0,0,0,0.45)",
                  "&:hover": { bgcolor: "rgba(0,0,0,0.6)" },
                }}
              >
                <LinkOffIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
        </>
      )}

      {isSelecting && (
        <Box
          sx={{
            position: "absolute",
            top: 4,
            left: 4,
            zIndex: 20,
            pointerEvents: "none",
          }}
        >
          <Checkbox
            checked={isSelected}
            size="small"
            sx={{
              p: 0.5,
              color: "white",
              bgcolor: "rgba(0,0,0,0.45)",
              borderRadius: 1,
              "&.Mui-checked": { color: "primary.main" },
            }}
          />
        </Box>
      )}
    </Card>
  );
}

// Grids render hundreds of cards; skip re-rendering those whose props are unchanged.
export default React.memo(MediaCard);
