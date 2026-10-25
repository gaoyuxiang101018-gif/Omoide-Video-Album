import { withMediaCacheScope } from "../urlUtils";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  FormControlLabel,
  Paper,
  Snackbar,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
  Checkbox,
} from "@mui/material";
import FilterAltIcon from "@mui/icons-material/FilterAlt";
import DoneAllIcon from "@mui/icons-material/DoneAll";
import UndoIcon from "@mui/icons-material/Undo";
import SelectAllIcon from "@mui/icons-material/SelectAll";
import ClearAllIcon from "@mui/icons-material/ClearAll";

import { MissingMediaItem, MissingSummaryEntry } from "../types";
import { API } from "../config";
import { encodeFilePath } from "../urlUtils";
import {
  confirmMissing,
  getMissingMedia,
  resetMissingFlags,
} from "../services/missing";
import { usePagedList } from "../hooks/usePagedList";
import { useIdSelection } from "../hooks/useIdSelection";
import { useTaskCompletionVersion, useTaskEvents } from "../TaskEventsContext";
import ConfirmDialog from "../components/ConfirmDialog";
import { FeedbackSeverity } from "../components/BulkResolveToolbar";
import { formatBytes } from "../formatUtils";

const parseUtcDate = (iso: string) => new Date(iso.endsWith("Z") ? iso : `${iso}Z`);

const formatDuration = (iso: string | null) => {
  if (!iso) return "unknown";
  const date = parseUtcDate(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0) return date.toLocaleString();
  const diffHours = Math.floor(diffMs / 3_600_000);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  const diffWeeks = Math.floor(diffDays / 7);
  if (diffWeeks < 8) return `${diffWeeks}w ago`;
  return date.toLocaleDateString();
};

const buildThumbUrl = (item: MissingMediaItem) => {
  const thumb = item.thumbnail_path
    ? encodeFilePath(item.thumbnail_path)
    : `${item.id}.jpg`;
  return withMediaCacheScope(`${API}/thumbnails/${thumb}`);
};

type MissingBulkKind = "confirm-selected" | "confirm-all" | "reset-all";

const MissingFilesPage: React.FC = () => {
  const [summary, setSummary] = useState<MissingSummaryEntry[]>([]);
  const [isActionLoading, setIsActionLoading] = useState(false);
  const [pendingBulk, setPendingBulk] = useState<MissingBulkKind | null>(null);
  const [snackbar, setSnackbar] = useState<{
    open: boolean;
    message: string;
    severity: FeedbackSeverity;
  }>({ open: false, message: "", severity: "success" });

  const [pathFilter, setPathFilter] = useState("");
  const [includeConfirmed, setIncludeConfirmed] = useState(false);
  // Typing in the path filter only reloads once the user pauses.
  const [debouncedPath, setDebouncedPath] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedPath(pathFilter.trim()), 300);
    return () => clearTimeout(t);
  }, [pathFilter]);

  const { activeTasks } = useTaskEvents();
  const cleanupTask = activeTasks.find(
    (task) => task.task_type === "clean_missing_files"
  );

  const list = usePagedList<MissingMediaItem>(
    `missing:${includeConfirmed}:${debouncedPath}`,
    async (cursor, signal) => {
      const response = await getMissingMedia(
        {
          cursor,
          pathPrefix: debouncedPath || undefined,
          includeConfirmed,
        },
        signal
      );
      if (cursor === null) setSummary(response.summary);
      return response;
    },
    { infiniteScroll: false, refetchOnMount: true }
  );
  const { items, isLoading, error, hasMore, loadMore, reload: reloadList } = list;
  const totalMissing = list.total ?? 0;
  const selection = useIdSelection<number>();
  const { selectedIds, toggle: toggleSelection, clear: clearSelection } = selection;

  const reload = useCallback(() => {
    clearSelection();
    reloadList();
  }, [clearSelection, reloadList]);

  // A finished cleanup task changes which files are missing.
  const refreshKey = useTaskCompletionVersion(["clean_missing_files"]);
  const seenRefreshKey = useRef(refreshKey);
  useEffect(() => {
    if (seenRefreshKey.current === refreshKey) return;
    seenRefreshKey.current = refreshKey;
    reload();
  }, [refreshKey, reload]);

  // New filters mean a new list; the old selection no longer applies.
  useEffect(() => clearSelection(), [includeConfirmed, debouncedPath, clearSelection]);

  const selectAllVisible = () => selection.selectAll(items.map((item) => item.id));

  const removeLocalItems = (ids: number[], removed: number) => {
    list.removeItems(ids, removed);
    selection.deselect(ids);
  };

  const showFeedback = (message: string, severity: FeedbackSeverity) =>
    setSnackbar({ open: true, message, severity });

  const performConfirmSelected = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setIsActionLoading(true);
    try {
      const { deleted } = await confirmMissing({ media_ids: ids });
      showFeedback(
        deleted > 0 ? `Removed ${deleted} media record(s)` : "没有匹配的项目",
        deleted > 0 ? "success" : "warning"
      );
      if (deleted > 0) {
        removeLocalItems(ids, deleted);
      }
      setPendingBulk(null);
    } catch (err) {
      showFeedback(
        err instanceof Error ? err.message : "确认缺失媒体失败",
        "error"
      );
      setPendingBulk(null);
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleResetSelected = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setIsActionLoading(true);
    try {
      const { cleared } = await resetMissingFlags({ media_ids: ids });
      showFeedback(
        cleared > 0
          ? `Cleared missing status for ${cleared} item(s)`
          : "没有匹配的项目",
        cleared > 0 ? "success" : "warning"
      );
      if (cleared > 0) {
        removeLocalItems(ids, cleared);
      }
    } catch (err) {
      showFeedback(
        err instanceof Error ? err.message : "重置缺失状态失败",
        "error"
      );
    } finally {
      setIsActionLoading(false);
    }
  };

  const performConfirmAllFiltered = async () => {
    setIsActionLoading(true);
    try {
      const { deleted } = await confirmMissing({
        select_all: true,
        path_prefix: pathFilter.trim() || undefined,
        include_confirmed: includeConfirmed,
      });
      showFeedback(
        deleted > 0
          ? `Removed ${deleted} filtered media record(s)`
          : "没有匹配的项目",
        deleted > 0 ? "success" : "warning"
      );
      setPendingBulk(null);
      reload();
    } catch (err) {
      showFeedback(
        err instanceof Error ? err.message : "确认已筛选媒体失败",
        "error"
      );
      setPendingBulk(null);
    } finally {
      setIsActionLoading(false);
    }
  };

  const performResetAllFiltered = async () => {
    setIsActionLoading(true);
    try {
      const { cleared } = await resetMissingFlags({
        select_all: true,
        path_prefix: pathFilter.trim() || undefined,
        include_confirmed: includeConfirmed,
      });
      showFeedback(
        cleared > 0
          ? `Cleared missing status for ${cleared} item(s)`
          : "没有匹配的项目",
        cleared > 0 ? "success" : "warning"
      );
      setPendingBulk(null);
      reload();
    } catch (err) {
      showFeedback(
        err instanceof Error ? err.message : "重置已筛选媒体失败",
        "error"
      );
      setPendingBulk(null);
    } finally {
      setIsActionLoading(false);
    }
  };

  const selectedCount = selectedIds.size;

  const bulkCopy =
    pendingBulk === "confirm-selected"
      ? {
          title: "移除记录",
          message: ("从资料库中移除缺失文件的 {0} 条记录。此操作无法撤销。".replace(/\{(\d+)\}/g, (_, i) => String([selectedCount][Number(i)]))),
          confirmLabel: "移除记录",
        }
      : pendingBulk === "confirm-all"
      ? {
          title: "移除所有已筛选记录",
          message: ("从资料库中移除符合当前筛选条件的所有 {0} 个缺失项目。此操作无法撤销。".replace(/\{(\d+)\}/g, (_, i) => String([totalMissing.toLocaleString()][Number(i)]))),
          confirmLabel: "移除记录",
        }
      : pendingBulk === "reset-all"
      ? {
          title: "清除缺失状态",
          message: "清除符合当前筛选条件的所有项目的缺失状态。它们将被重新视为已找到。",
          confirmLabel: "清除状态",
        }
      : null;

  const handleBulkConfirm = () => {
    if (pendingBulk === "confirm-selected") performConfirmSelected();
    else if (pendingBulk === "confirm-all") performConfirmAllFiltered();
    else if (pendingBulk === "reset-all") performResetAllFiltered();
  };

  return (
    <Box sx={{ p: 3, maxWidth: "1400px", mx: "auto" }}>
      <Typography variant="h4" gutterBottom>
        {" 缺失媒体审核 "}</Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 2 }}>
        {" 在从资料库中移除文件当前缺失的项目之前进行审核。文件恢复后，可使用批量操作确认删除或清除项目。 "}</Typography>

      {cleanupTask && (
        <Alert severity="info" sx={{ mb: 2 }}>
          {" 清理任务进行中（已处理 "}{cleanupTask.processed}/
          {cleanupTask.total}{"）。此列表将在完成后自动刷新。 "}</Alert>
      )}

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
        <Stack
          direction={{ xs: "column", md: "row" }}
          spacing={2}
          alignItems={{ xs: "flex-start", md: "center" }}
          justifyContent="space-between"
        >
          <Stack direction="row" spacing={2} alignItems="center">
            <Typography variant="h6">{totalMissing} {" 个文件已标记"}</Typography>
            <FormControlLabel
              control={
                <Switch
                  checked={includeConfirmed}
                  onChange={(e) => setIncludeConfirmed(e.target.checked)}
                  color="primary"
                />
              }
              label="包含已确认项"
            />
          </Stack>
          <Stack
            direction={{ xs: "column", sm: "row" }}
            spacing={1.5}
            alignItems={{ xs: "stretch", sm: "center" }}
          >
            <TextField
              size="small"
              label="路径筛选"
              value={pathFilter}
              onChange={(e) => setPathFilter(e.target.value)}
              placeholder="输入目录前缀"
              InputProps={{
                endAdornment: <FilterAltIcon color="action" fontSize="small" />,
              }}
              sx={{ minWidth: 260 }}
            />
            <Button
              variant="outlined"
              startIcon={<SelectAllIcon />}
              onClick={selectAllVisible}
              disabled={items.length === 0}
            >
              {" 选择可见项 "}</Button>
            <Button
              variant="text"
              startIcon={<ClearAllIcon />}
              onClick={clearSelection}
              disabled={selectedCount === 0}
            >
              {" 清除选择 "}</Button>
          </Stack>
        </Stack>
        {summary.length > 0 && (
          <>
            <Divider sx={{ my: 2 }} />
            <Typography variant="subtitle2" gutterBottom>
              {" 缺失文件最多的文件夹 "}</Typography>
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              {summary.map((entry) => (
                <Chip
                  key={entry.folder}
                  label={`${entry.folder} (${entry.count})`}
                  onClick={() => setPathFilter(entry.folder)}
                />
              ))}
            </Stack>
          </>
        )}
      </Paper>

      <Paper variant="outlined" sx={{ mb: 3 }}>
        <Stack
          direction={{ xs: "column", md: "row" }}
          spacing={1.5}
          alignItems={{ xs: "stretch", md: "center" }}
          justifyContent="space-between"
          sx={{ p: 2 }}
        >
          <Typography variant="subtitle1">
            {" 已选择： "}{selectedCount} / {items.length}
          </Typography>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
            <Button
              variant="contained"
              color="error"
              startIcon={<DoneAllIcon />}
              onClick={() => setPendingBulk("confirm-selected")}
              disabled={selectedCount === 0 || isActionLoading}
            >
              {" 确认所选 "}</Button>
            <Button
              variant="outlined"
              startIcon={<UndoIcon />}
              onClick={handleResetSelected}
              disabled={selectedCount === 0 || isActionLoading}
            >
              {" 将所选标记为已找到 "}</Button>
            <Divider
              flexItem
              orientation="vertical"
              sx={{ display: { xs: "none", sm: "block" } }}
            />
            <Button
              variant="text"
              color="error"
              onClick={() => setPendingBulk("confirm-all")}
              disabled={isActionLoading || totalMissing === 0}
            >
              {" 确认所有已筛选项 "}</Button>
            <Button
              variant="text"
              onClick={() => setPendingBulk("reset-all")}
              disabled={isActionLoading || totalMissing === 0}
            >
              {" 清除所有已筛选项 "}</Button>
          </Stack>
        </Stack>
        <Divider />
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell padding="checkbox">
                  <Checkbox
                    indeterminate={
                      selectedCount > 0 && selectedCount < items.length
                    }
                    checked={items.length > 0 && selectedCount === items.length}
                    onChange={() => {
                      if (selectedCount === items.length) {
                        clearSelection();
                      } else {
                        selectAllVisible();
                      }
                    }}
                  />
                </TableCell>
                <TableCell>{"预览"}</TableCell>
                <TableCell>{"文件"}</TableCell>
                <TableCell>{"文件夹"}</TableCell>
                <TableCell align="right">{"大小"}</TableCell>
                <TableCell>{"缺失起始时间"}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {items.map((item) => {
                const selected = selectedIds.has(item.id);
                return (
                  <TableRow key={item.id} hover selected={selected}>
                    <TableCell padding="checkbox">
                      <Checkbox
                        checked={selected}
                        onChange={() => toggleSelection(item.id)}
                      />
                    </TableCell>
                    <TableCell>
                      <Box
                        sx={{
                          width: 56,
                          height: 56,
                          borderRadius: 1,
                          overflow: "hidden",
                          bgcolor: "action.hover",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <Box
                          component="img"
                          src={buildThumbUrl(item)}
                          alt={item.filename}
                          loading="lazy"
                          sx={{
                            width: "100%",
                            height: "100%",
                            objectFit: "cover",
                            display: "block",
                          }}
                          onError={(e) => {
                            e.currentTarget.style.visibility = "hidden";
                          }}
                        />
                      </Box>
                    </TableCell>
                    <TableCell sx={{ fontFamily: "monospace" }}>
                      {item.filename}
                    </TableCell>
                    <TableCell sx={{ fontFamily: "monospace" }}>
                      {item.parent_directory}
                    </TableCell>
                    <TableCell align="right">
                      {formatBytes(item.size)}
                    </TableCell>
                    <TableCell>
                      {item.missing_since
                        ? `${formatDuration(item.missing_since)} (${parseUtcDate(item.missing_since).toLocaleString()})`
                        : "未知"}
                    </TableCell>
                  </TableRow>
                );
              })}
              {!isLoading && items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} align="center" sx={{ py: 4 }}>
                    {" 没有缺失文件符合当前筛选条件。 "}</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
        {isLoading && (
          <Box sx={{ display: "flex", justifyContent: "center", py: 3 }}>
            <CircularProgress size={24} />
          </Box>
        )}
        {!isLoading && hasMore && (
          <Box sx={{ display: "flex", justifyContent: "center", py: 2 }}>
            <Button
              onClick={loadMore}
              disabled={!hasMore}
            >
              {" 加载更多 "}</Button>
          </Box>
        )}
      </Paper>

      <ConfirmDialog
        open={Boolean(pendingBulk)}
        title={bulkCopy?.title ?? ""}
        message={bulkCopy?.message ?? ""}
        confirmLabel={bulkCopy?.confirmLabel}
        confirmColor={pendingBulk === "reset-all" ? "primary" : "error"}
        loading={isActionLoading}
        onConfirm={handleBulkConfirm}
        onClose={() => setPendingBulk(null)}
      />

      <Snackbar
        open={snackbar.open}
        autoHideDuration={5000}
        onClose={() => setSnackbar((prev) => ({ ...prev, open: false }))}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert
          onClose={() => setSnackbar((prev) => ({ ...prev, open: false }))}
          severity={snackbar.severity}
          sx={{ width: "100%" }}
        >
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Box>
  );
};

export default MissingFilesPage;
