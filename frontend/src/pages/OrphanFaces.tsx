import { withMediaCacheScope } from "../urlUtils";
import { useState, useEffect, useCallback } from "react";
import {
  Container,
  Box,
  Typography,
  CircularProgress,
  Dialog,
  DialogTitle,
  DialogContent,
  TextField,
  DialogActions,
  Button,
  Stack,
  Paper,
  Autocomplete,
  Avatar,
  Alert,
  Snackbar,
} from "@mui/material";
import { useNavigate } from "react-router-dom";
import { useListStore } from "../stores/useListStore";
import { usePagedList } from "../hooks/usePagedList";
import { isAbortError } from "../services/api";
import { getOrphanFaces } from "../services/face";
import {
  assignFace,
  createPersonFromFaces,
  deleteFace,
} from "../services/faceActions";
import { searchPersonsByName } from "../services/personActions";
import { FaceRead, Person } from "../types";
import { FaceGrid } from "../components/FaceGrid"; // Import our DUMB grid component
import ConfirmDialog from "../components/ConfirmDialog";
import { API } from "../config";
import { encodeFilePath } from "../urlUtils";

export default function OrphanFacesPage() {
  const navigate = useNavigate();
  const listKey = "orphan-faces";

  // --- State Management ---
  const {
    items: orphans,
    hasMore,
    isLoading,
    error,
    loaderRef,
    reload,
    removeItems,
  } = usePagedList<FaceRead>(listKey, (cursor, signal) =>
    getOrphanFaces(cursor, signal)
  );

  // Faces get assigned elsewhere, so a cached list is refetched on every visit
  // (usePagedList itself only loads lists that aren't cached).
  useEffect(() => {
    const cached = useListStore.getState().lists[listKey];
    if (cached && !cached.isLoading) reload();
  }, [listKey, reload]);

  // All UI state is now managed directly by the page
  const [isProcessing, setIsProcessing] = useState(false);
  const [selectedFaceIds, setSelectedFaceIds] = useState<number[]>([]);

  // State for dialogs
  const [assignDialogOpen, setAssignDialogOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [newPersonName, setNewPersonName] = useState("");
  const [personOptions, setPersonOptions] = useState<Person[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [snackbar, setSnackbar] = useState<{
    open: boolean;
    message: string;
    severity: "success" | "error";
  }>({ open: false, message: "", severity: "success" });

  const showMessage = (
    message: string,
    severity: "success" | "error" = "success"
  ) => {
    setSnackbar({ open: true, message, severity });
  };

  // --- Action Handlers ---
  const handleBulkDelete = async () => {
    const faceIds = [...selectedFaceIds];
    setIsProcessing(true);
    try {
      await deleteFace(faceIds);
      removeItems(faceIds);
      setSelectedFaceIds([]);
      showMessage(
        `Deleted ${faceIds.length} face${faceIds.length === 1 ? "" : "s"}.`
      );
    } catch (err) {
      console.error("Failed to delete faces:", err);
      showMessage("删除人脸失败。", "error");
    } finally {
      setIsProcessing(false);
      setConfirmDeleteOpen(false);
    }
  };

  const handleBulkCreate = async () => {
    if (!newPersonName.trim()) return;
    const faceIds = [...selectedFaceIds];
    setIsProcessing(true);
    try {
      const newPerson = await createPersonFromFaces(faceIds, newPersonName);
      if (!newPerson?.id) {
        throw new Error("获取新建人物的 ID 失败。");
      }
      removeItems(faceIds);
      setSelectedFaceIds([]);
      setCreateDialogOpen(false);
      navigate(`/person/${newPerson.id}`, { state: { forceRefresh: true } });
    } catch (err) {
      console.error("Failed to create and navigate to new person:", err);
      showMessage("创建新人物失败。", "error");
    } finally {
      setIsProcessing(false);
    }
  };

  const openAssignDialog = () => {
    setSearchTerm("");
    setPersonOptions([]);
    setAssignDialogOpen(true);
  };

  useEffect(() => {
    if (!assignDialogOpen) {
      return;
    }
    const trimmed = searchTerm.trim();
    if (trimmed.length < 2) {
      setPersonOptions([]);
      return;
    }
    const controller = new AbortController();
    const handle = window.setTimeout(() => {
      searchPersonsByName(trimmed, controller.signal)
        .then(setPersonOptions)
        .catch((err) => {
          if (isAbortError(err)) return;
          console.error("Failed to search persons:", err);
        });
    }, 300);
    return () => {
      controller.abort();
      window.clearTimeout(handle);
    };
  }, [assignDialogOpen, searchTerm]);

  const handleConfirmAssign = async (person: Person | null) => {
    if (!person) return;
    const faceIds = [...selectedFaceIds];
    setIsProcessing(true);
    try {
      await assignFace(faceIds, person.id);
      removeItems(faceIds);
      setSelectedFaceIds([]);
      setAssignDialogOpen(false);
      setSearchTerm("");
      setPersonOptions([]);
      showMessage(
        `Assigned ${faceIds.length} face${faceIds.length === 1 ? "" : "s"} to ${
          person.name || `Person ${person.id}`
        }.`
      );
    } catch (err) {
      console.error("Failed to assign faces:", err);
      showMessage("分配人脸失败。", "error");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleRetry = reload;

  const handleToggleSelect = useCallback((faceId: number) => {
    setSelectedFaceIds((prev) =>
      prev.includes(faceId)
        ? prev.filter((id) => id !== faceId)
        : [...prev, faceId]
    );
  }, []);

  const handleSelectAll = () => {
    if (selectedFaceIds.length < orphans.length) {
      setSelectedFaceIds(orphans.map((f) => f.id));
    } else {
      setSelectedFaceIds([]);
    }
  };

  if (isLoading && orphans.length === 0) {
    return (
      <Box
        display="flex"
        justifyContent="center"
        alignItems="center"
        height="calc(100vh - 64px)"
      >
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Container maxWidth="xl" sx={{ pt: 4, pb: 7 }}>
      {/* The header and toolbar are now part of the page's main layout flow */}
      <Box sx={{ display: "flex", alignItems: "center", mb: 2, gap: 2 }}>
        <Typography variant="h4" sx={{ flexGrow: 1 }}>
          {" 待确认人脸 "}</Typography>
        <Button
          size="small"
          onClick={handleSelectAll}
          disabled={orphans.length === 0}
        >
          {selectedFaceIds.length < orphans.length
            ? "全选"
            : "取消全选"}
        </Button>
      </Box>

      {selectedFaceIds.length > 0 && (
        <Paper elevation={2} sx={{ p: 1, mb: 2, bgcolor: "action.selected" }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography sx={{ ml: 1 }} variant="subtitle1">
              {selectedFaceIds.length} {" 已选择 "}</Typography>
            <Box sx={{ flexGrow: 1 }} />
            <Button
              variant="contained"
              size="small"
              disabled={isProcessing}
              onClick={openAssignDialog}
            >
              {" 分配到... "}</Button>
            <Button
              variant="contained"
              size="small"
              disabled={isProcessing}
              onClick={() => setCreateDialogOpen(true)}
            >
              {" 创建... "}</Button>
            <Button
              variant="outlined"
              color="error"
              size="small"
              disabled={isProcessing}
              onClick={() => setConfirmDeleteOpen(true)}
            >
              {" 删除 "}</Button>
            {isProcessing && <CircularProgress size={20} />}
          </Stack>
        </Paper>
      )}

      {error && (
        <Alert
          severity="error"
          sx={{ mb: 2 }}
          action={
            <Button color="inherit" size="small" onClick={handleRetry}>
              {" 重试 "}</Button>
          }
        >
          {" 加载待确认人脸失败： "}{error}
        </Alert>
      )}

      {orphans.length === 0 && !isLoading ? (
        !error && (
          <Typography align="center" sx={{ py: 4 }}>
            {" 未找到待确认人脸。 "}</Typography>
        )
      ) : (
        <FaceGrid
          faces={orphans}
          selectedFaceIds={selectedFaceIds}
          onToggleSelect={handleToggleSelect}
        />
      )}

      {/* The loader and sentinel are at the page level */}
      {isLoading && orphans.length > 0 && (
        <Box textAlign="center" py={4}>
          <CircularProgress />
        </Box>
      )}
      {hasMore && !error && <Box ref={loaderRef} sx={{ height: "50px" }} />}

      {/* --- Dialogs --- */}
      {/* Assign Dialog */}
      <Dialog
        open={assignDialogOpen}
        onClose={() => setAssignDialogOpen(false)}
        fullWidth
      >
        <DialogTitle>{"分配 "}{selectedFaceIds.length} {" 人脸到..."}</DialogTitle>
        <DialogContent>
          <Autocomplete
            options={personOptions}
            getOptionLabel={(o) => o.name || "Unknown"}
            inputValue={searchTerm}
            onInputChange={(_, value) => setSearchTerm(value)}
            onChange={(_, val) => handleConfirmAssign(val)}
            renderOption={(props, option) => {
              const thumbPath = option.profile_face?.thumbnail_path;
              const thumbUrl = thumbPath
                ? withMediaCacheScope(`${API}/thumbnails/${encodeFilePath(thumbPath)}`)
                : undefined;
              const initials = (option.name || "?")
                .trim()
                .split(/\s+/)
                .filter(Boolean)
                .map((part) => part[0]?.toUpperCase())
                .join("")
                .slice(0, 2) || "?";
              return (
                <Box
                  component="li"
                  {...props}
                  sx={{ display: "flex", alignItems: "center", gap: 1.5, py: 0.5 }}
                >
                  <Avatar src={thumbUrl} alt={option.name || ("人物 {0}".replace(/\{(\d+)\}/g, (_, i) => String([option.id][Number(i)])))}>
                    {thumbUrl ? null : initials}
                  </Avatar>
                  <Box sx={{ minWidth: 0 }}>
                    <Typography noWrap>{option.name || ("人物 {0}".replace(/\{(\d+)\}/g, (_, i) => String([option.id][Number(i)])))}</Typography>
                    {option.appearance_count ? (
                      <Typography variant="caption" color="text.secondary" noWrap>
                        {option.appearance_count} {" 媒体文件 "}</Typography>
                    ) : null}
                  </Box>
                </Box>
              );
            }}
            renderInput={(params) => (
              <TextField
                {...params}
                label="搜索人物"
                autoFocus
                helperText={
                  searchTerm.length < 2
                    ? "输入至少两个字符进行搜索"
                    : undefined
                }
              />
            )}
          />
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setAssignDialogOpen(false);
              setSearchTerm("");
              setPersonOptions([]);
            }}
          >
            {" 取消 "}</Button>
        </DialogActions>
      </Dialog>
      {/* Create Dialog */}
      <Dialog
        open={createDialogOpen}
        onClose={() => setCreateDialogOpen(false)}
      >
        <DialogTitle>{"创建新人物"}</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            label="人物名称"
            type="text"
            fullWidth
            variant="standard"
            value={newPersonName}
            onChange={(e) => setNewPersonName(e.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateDialogOpen(false)}>{"取消"}</Button>
          <Button onClick={handleBulkCreate} disabled={isProcessing}>
            {" 创建 "}</Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog
        open={confirmDeleteOpen}
        title="删除人脸"
        message={("确定要删除 {0} 张人脸{1}吗？此操作无法撤销。".replace(/\{(\d+)\}/g, (_, i) => String([selectedFaceIds.length, selectedFaceIds.length === 1 ? "" : "s"][Number(i)])))}
        confirmLabel="Delete"
        loading={isProcessing}
        onConfirm={handleBulkDelete}
        onClose={() => setConfirmDeleteOpen(false)}
      />

      <Snackbar
        open={snackbar.open}
        autoHideDuration={4000}
        onClose={() => setSnackbar((prev) => ({ ...prev, open: false }))}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert
          severity={snackbar.severity}
          onClose={() => setSnackbar((prev) => ({ ...prev, open: false }))}
          sx={{ width: "100%" }}
        >
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Container>
  );
}
