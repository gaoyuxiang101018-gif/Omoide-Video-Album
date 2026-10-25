import React, { useEffect, useRef, useState } from "react";
import {
  Container,
  Box,
  Typography,
  CircularProgress,
  Button,
  Stack,
  Snackbar,
  Alert,
  TextField,
  InputAdornment,
  IconButton,
  MenuItem,
} from "@mui/material";
import SearchIcon from "@mui/icons-material/Search";
import ClearIcon from "@mui/icons-material/Clear";
import Grid from "@mui/material/Grid";
import { usePagedList } from "../hooks/usePagedList";
import PersonCard from "../components/PersonCard";
import ConfirmDialog from "../components/ConfirmDialog";
import {
  PERSON_GRID_SIZES,
  PersonThumbSizeToggle,
  usePersonThumbSize,
} from "../components/PersonThumbSize";
import { PersonReadSimple } from "../types";
import config from "../config";
import { getPeople, PersonSort } from "../services/person";
import { useLocalStoragePreference } from "../hooks/useLocalStoragePreference";
import { deletePersonsBulk } from "../services/personActions";
import { useTaskCompletionVersion } from "../TaskEventsContext";
import { useListStore } from "../stores/useListStore";

const SORT_OPTIONS: { value: PersonSort; label: string }[] = [
  { value: "appearances_desc", label: "媒体最多" },
  { value: "appearances_asc", label: "媒体最少" },
  { value: "name_asc", label: "名称（A–Z）" },
  { value: "name_desc", label: "名称（Z–A）" },
  { value: "views_desc", label: "查看最多" },
  { value: "favorites", label: "收藏优先" },
  { value: "newest", label: "最新" },
  { value: "oldest", label: "最早" },
];
const SORT_VALUES = SORT_OPTIONS.map((option) => option.value);

export default function PeoplePage() {
  const [nameFilter, setNameFilter] = useState("");
  const [debouncedNameFilter, setDebouncedNameFilter] = useState("");
  const [thumbSize, setThumbSize] = usePersonThumbSize();
  const [sort, setSort] = useLocalStoragePreference<PersonSort>(
    "peopleSort",
    SORT_VALUES,
    "appearances_desc",
  );

  useEffect(() => {
    const handler = setTimeout(
      () => setDebouncedNameFilter(nameFilter.trim()),
      300,
    );
    return () => clearTimeout(handler);
  }, [nameFilter]);

  const refreshKey = useTaskCompletionVersion([
    "process_media",
    "cluster_persons",
  ]);

  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(
    new Set<number>(),
  );
  const [isDeleting, setIsDeleting] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [snackbar, setSnackbar] = useState<{
    open: boolean;
    message: string;
    severity: "success" | "error";
  }>({ open: false, message: "", severity: "success" });

  const listKey = `people-${sort}-${debouncedNameFilter}`;
  const {
    items: people,
    hasMore,
    isLoading: loading,
    error,
    loaderRef,
    reload,
    removeItems,
    updateItems,
  } = usePagedList<PersonReadSimple>(listKey, (cursor, signal) =>
    getPeople(cursor ?? undefined, debouncedNameFilter, sort, signal),
  );

  // People change through many other pages (merges, renames, face
  // assignment), so the list is never served from cache: drop it when the
  // page unmounts or the filter/sort changes, and reload it when a relevant
  // task completes.
  const clearList = useListStore((state) => state.clearList);
  useEffect(() => () => clearList(listKey), [clearList, listKey]);

  const lastRefreshKeyRef = useRef(refreshKey);
  useEffect(() => {
    if (lastRefreshKeyRef.current === refreshKey) return;
    lastRefreshKeyRef.current = refreshKey;
    reload();
  }, [refreshKey, reload]);

  useEffect(() => {
    setSelectedIds((previous) => {
      if (previous.size === 0) {
        return previous;
      }
      const available = new Set(people.map((person) => person.id));
      let changed = false;
      const next = new Set<number>();
      previous.forEach((id) => {
        if (available.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      });
      return changed ? next : previous;
    });
  }, [people]);

  if (!config.ENABLE_PEOPLE) {
    return (
      <Typography variant="h5" color="text.primary" gutterBottom>
        {" 人物功能已禁用！ "}</Typography>
    );
  }

  const handleSelectionModeToggle = () => {
    setSelectionMode((prev) => {
      if (prev) {
        setSelectedIds(new Set<number>());
        return false;
      }
      return true;
    });
  };

  const handleToggleSelect = (personId: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(personId)) {
        next.delete(personId);
      } else {
        next.add(personId);
      }
      return next;
    });
  };

  const handleDeleteSelected = () => {
    if (!selectionMode || selectedIds.size === 0) {
      return;
    }
    setConfirmDeleteOpen(true);
  };

  const handleConfirmDeleteSelected = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) {
      setConfirmDeleteOpen(false);
      return;
    }

    setIsDeleting(true);
    try {
      const result = await deletePersonsBulk(ids);
      const deletedSet = new Set(result.deleted_ids);
      const deletedCount = deletedSet.size;

      if (deletedCount > 0) {
        removeItems(deletedSet);
      }

      setSelectedIds((prev) => {
        if (deletedCount === 0) {
          return prev;
        }
        const next = new Set(prev);
        deletedSet.forEach((id) => next.delete(id));
        return next;
      });

      if (deletedCount > 0 && deletedCount === ids.length) {
        setSelectionMode(false);
        setSelectedIds(new Set<number>());
      }

      const parts: string[] = [];
      if (deletedCount > 0) {
        parts.push(
          `Deleted ${deletedCount} person${deletedCount === 1 ? "" : "s"}.`,
        );
      }
      if (result.skipped_ids.length > 0) {
        parts.push(
          `${result.skipped_ids.length} person${result.skipped_ids.length === 1 ? "" : "s"} skipped.`,
        );
      }
      const message = parts.join(" ") || "未删除任何人物。";
      setSnackbar({
        open: true,
        message,
        severity: deletedCount > 0 ? "success" : "error",
      });
    } catch (error) {
      console.error("Failed to delete selected people", error);
      setSnackbar({
        open: true,
        message: "删除所选人物失败",
        severity: "error",
      });
    } finally {
      setIsDeleting(false);
      setConfirmDeleteOpen(false);
    }
  };

  const handleFavoriteChange = (personId: number, isFavorite: boolean) =>
    updateItems((person) =>
      person.id === personId ? { ...person, is_favorite: isFavorite } : person,
    );

  const handleCloseSnackbar = () =>
    setSnackbar((prev) => ({ ...prev, open: false }));

  const selectedCount = selectedIds.size;

  return (
    <Container
      maxWidth={false}
      sx={{ pt: 4, pb: 6, bgcolor: "background.default", px: 4 }}
    >
      <Stack
        direction={{ xs: "column", sm: "row" }}
        spacing={2}
        justifyContent="space-between"
        alignItems={{ xs: "flex-start", sm: "center" }}
        sx={{ mb: 3 }}
      >
        <Typography variant="h5" color="text.primary">
          {" 人物 "}</Typography>
        <Stack
          direction="row"
          spacing={1.5}
          alignItems="center"
          useFlexGap
          sx={{ flexWrap: "wrap", rowGap: 1 }}
        >
          <TextField
            size="small"
            placeholder="按名称筛选..."
            value={nameFilter}
            onChange={(event) => setNameFilter(event.target.value)}
            sx={{ minWidth: 220 }}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" />
                  </InputAdornment>
                ),
                endAdornment: nameFilter ? (
                  <InputAdornment position="end">
                    <IconButton
                      size="small"
                      aria-label="清除筛选"
                      onClick={() => setNameFilter("")}
                      edge="end"
                    >
                      <ClearIcon fontSize="small" />
                    </IconButton>
                  </InputAdornment>
                ) : undefined,
              },
            }}
          />
          <TextField
            select
            size="small"
            label="排序方式"
            value={sort}
            onChange={(event) => setSort(event.target.value as PersonSort)}
            sx={{ minWidth: 170 }}
          >
            {SORT_OPTIONS.map((option) => (
              <MenuItem key={option.value} value={option.value}>
                {option.label}
              </MenuItem>
            ))}
          </TextField>
          <PersonThumbSizeToggle value={thumbSize} onChange={setThumbSize} />
          {!config.PRESENTATION_MODE && (
            <>
              {selectionMode && (
                <Typography variant="body2" color="text.secondary">
                  {selectedCount} {" 已选择 "}</Typography>
              )}
              <Button
                variant="outlined"
                size="small"
                onClick={handleSelectionModeToggle}
              >
                {selectionMode ? "取消选择" : "选择人物"}
              </Button>
              <Button
                variant="contained"
                color="error"
                size="small"
                onClick={handleDeleteSelected}
                disabled={!selectionMode || selectedCount === 0 || isDeleting}
              >
                {isDeleting ? "正在删除..." : "删除所选"}
              </Button>
            </>
          )}
        </Stack>
      </Stack>

      {error && (
        <Alert
          severity="error"
          sx={{ mb: 3 }}
          action={
            <Button
              color="inherit"
              size="small"
              onClick={reload}
            >
              {" 重试 "}</Button>
          }
        >
          {" 加载人物失败： "}{error}
        </Alert>
      )}

      <Grid container spacing={3} alignItems="stretch">
        {people.map((person) => (
          <Grid key={person.id} size={PERSON_GRID_SIZES[thumbSize]}>
            <PersonCard
              person={person}
              size={thumbSize}
              onFavoriteChange={handleFavoriteChange}
              selectable={selectionMode}
              selected={selectionMode && selectedIds.has(person.id)}
              onToggleSelect={handleToggleSelect}
            />
          </Grid>
        ))}
      </Grid>

      {!loading && !error && people.length === 0 && (
        <Typography color="text.secondary" sx={{ py: 4, textAlign: "center" }}>
          {debouncedNameFilter
            ? ("没有人物匹配“{0}”。".replace(/\{(\d+)\}/g, (_, i) => String([debouncedNameFilter][Number(i)])))
            : "未找到人物。"}
        </Typography>
      )}

      {loading && (
        <Box textAlign="center" py={2}>
          <CircularProgress color="secondary" />
        </Box>
      )}

      {!loading && hasMore && (
        <Box
          ref={loaderRef}
          textAlign="center"
          py={2}
          sx={{ color: "text.secondary" }}
        >
          {" 滚动加载更多... "}</Box>
      )}

      <ConfirmDialog
        open={confirmDeleteOpen}
        title="删除所选人物"
        message={("删除 {0} 个所选人物{1}？此操作无法撤销。".replace(/\{(\d+)\}/g, (_, i) => String([selectedCount, selectedCount === 1 ? "" : "s"][Number(i)])))}
        confirmLabel="Delete"
        loading={isDeleting}
        onConfirm={handleConfirmDeleteSelected}
        onClose={() => setConfirmDeleteOpen(false)}
      />

      <Snackbar
        open={snackbar.open}
        autoHideDuration={4000}
        onClose={handleCloseSnackbar}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert
          onClose={handleCloseSnackbar}
          severity={snackbar.severity}
          sx={{ width: "100%" }}
        >
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Container>
  );
}
