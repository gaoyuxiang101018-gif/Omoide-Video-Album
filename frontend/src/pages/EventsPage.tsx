import { withMediaCacheScope } from "../urlUtils";
import React, { useEffect, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardActionArea,
  CardContent,
  CircularProgress,
  Container,
  Snackbar,
  Typography,
} from "@mui/material";
import TheatersIcon from "@mui/icons-material/Theaters";
import AutorenewIcon from "@mui/icons-material/Autorenew";
import { Link } from "react-router-dom";
import config, { API } from "../config";
import { encodeFilePath } from "../urlUtils";
import { EmptyState } from "../components/EmptyState";
import { usePagedList } from "../hooks/usePagedList";
import { getEvents, startBuildEvents } from "../services/features";
import { useTaskCompletionVersion } from "../TaskEventsContext";
import { EventItem } from "../types";

const formatRange = (startIso: string, endIso: string) => {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  const startStr = start.toLocaleDateString(undefined, opts);
  const endStr = end.toLocaleDateString(undefined, opts);
  const year = end.getFullYear();
  return startStr === endStr
    ? `${startStr}, ${year}`
    : `${startStr} – ${endStr}, ${year}`;
};

export default function EventsPage() {
  const [snackbar, setSnackbar] = useState("");
  const [startError, setStartError] = useState<string | null>(null);
  const { items, hasMore, isLoading, error, loaderRef, reload } =
    usePagedList<EventItem>("events", getEvents, { refetchOnMount: true });

  // A finished "build events" run replaces the event list.
  const refreshKey = useTaskCompletionVersion(["build_events"]);
  const seenRefreshKey = useRef(refreshKey);
  useEffect(() => {
    if (seenRefreshKey.current === refreshKey) return;
    seenRefreshKey.current = refreshKey;
    reload();
  }, [refreshKey, reload]);

  const handleRebuild = async () => {
    try {
      await startBuildEvents();
      setSnackbar("事件聚类已启动——完成后此页面会刷新。");
    } catch (err) {
      setStartError(err instanceof Error ? err.message : "启动任务失败");
    }
  };

  if (!config.EVENTS_ENABLED) {
    return (
      <Typography variant="h5" color="text.primary" gutterBottom>
        {" 事件已禁用！ "}</Typography>
    );
  }

  return (
    <Container maxWidth="xl" sx={{ minHeight: "100vh", py: 4 }}>
      <Box
        display="flex"
        justifyContent="space-between"
        alignItems="center"
        flexWrap="wrap"
        gap={1}
        mb={3}
      >
        <Box display="flex" alignItems="center" gap={1}>
          <TheatersIcon color="primary" />
          <Typography variant="h5" fontWeight={700}>
            {" 事件 "}</Typography>
        </Box>
        {!config.PRESENTATION_MODE && (
          <Button
            variant="outlined"
            startIcon={<AutorenewIcon />}
            onClick={handleRebuild}
          >
            {" 重建事件 "}</Button>
        )}
      </Box>

      {(error || startError) && (
        <Alert
          severity="error"
          sx={{ mb: 2 }}
          onClose={startError ? () => setStartError(null) : undefined}
        >
          {startError ?? error}
        </Alert>
      )}

      {items.length === 0 && !isLoading && !error && (
        <EmptyState
          icon={<TheatersIcon />}
          title="暂无事件"
          description={
            config.PRESENTATION_MODE
              ? undefined
              : "运行“重建事件”以将您的资料库聚类为旅行和时刻。如需命名事件，请先运行地理编码（地点页面）。"
          }
        />
      )}

      <Box
        sx={{
          display: "grid",
          gap: 2,
          gridTemplateColumns: {
            xs: "repeat(1, 1fr)",
            sm: "repeat(2, 1fr)",
            md: "repeat(3, 1fr)",
            lg: "repeat(4, 1fr)",
          },
        }}
      >
        {items.map((event) => (
          <Card key={event.id} sx={{ borderRadius: 3 }}>
            <CardActionArea component={Link} to={`/event/${event.id}`}>
              <Box
                sx={{
                  aspectRatio: "16/9",
                  bgcolor: "action.hover",
                  overflow: "hidden",
                }}
              >
                {event.cover_thumbnail && (
                  <Box
                    component="img"
                    src={withMediaCacheScope(`${API}/thumbnails/${encodeFilePath(
                      event.cover_thumbnail
                    )}`)}
                    alt={event.title ?? "事件"}
                    loading="lazy"
                    sx={{ width: "100%", height: "100%", objectFit: "cover" }}
                  />
                )}
              </Box>
              <CardContent sx={{ py: 1.5 }}>
                <Typography variant="subtitle2" fontWeight={700} noWrap>
                  {event.title || formatRange(event.start_at, event.end_at)}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {event.title
                    ? `${formatRange(event.start_at, event.end_at)} · `
                    : ""}
                  {event.media_count} {" 个项目"}{event.media_count === 1 ? "" : ""}
                </Typography>
              </CardContent>
            </CardActionArea>
          </Card>
        ))}
      </Box>

      {isLoading && (
        <Box textAlign="center" py={3}>
          <CircularProgress />
        </Box>
      )}
      {hasMore && !error && <Box ref={loaderRef} sx={{ height: 10 }} />}

      <Snackbar
        open={!!snackbar}
        autoHideDuration={4000}
        onClose={() => setSnackbar("")}
        message={snackbar}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      />
    </Container>
  );
}
