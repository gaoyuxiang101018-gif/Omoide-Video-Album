import { withMediaCacheScope } from "../urlUtils";
import {
  Avatar,
  Box,
  Button,
  CircularProgress,
  Container,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Snackbar from "@mui/material/Snackbar";
import { PersonContentTabs } from "../components/PersonContentTabs";
import { PersonHero } from "../components/PersonHero";
import ConfirmDialog from "../components/ConfirmDialog";
import { usePersonDetailPage } from "../hooks/usePersonDetailPage";
import { API } from "../config";
import { encodeFilePath } from "../urlUtils";
import { pickDirectory } from "../services/config";
import { exportPersonMedia } from "../services/personActions";
import { getTask } from "../services/task";
import { getTaskFailures } from "../services/taskActions";
import { Task } from "../types";

const EXPORT_POLL_INTERVAL_MS = 1500;

const getInitials = (name?: string) => {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
  }
  return parts[0]?.slice(0, 2).toUpperCase() || "?";
};

export default function PersonDetailPage() {
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportDestination, setExportDestination] = useState<string | null>(null);
  const [exportingMedia, setExportingMedia] = useState(false);
  const [exportTask, setExportTask] = useState<Task | null>(null);
  const {
    person,
    loading,
    saving,
    mergeOpen,
    setMergeOpen,
    mergeTarget,
    setMergeTarget,
    searchTerm,
    setSearchTerm,
    candidates,
    similarPersons,
    suggestedFaces,
    relationshipGraph,
    canExportMedia,
    relationshipDepth,
    isLoadingRelationships,
    hasLoadedRelationships,
    filterPeople,
    setFilterPeople,
    filterTags,
    setFilterTags,
    mediaListKey,
    detectedFacesList,
    hasMoreFaces,
    loadingMoreFaces,
    snackbar,
    setSnackbar,
    confirmDelete,
    setConfirmDelete,
    loadSimilar,
    loadRelationshipGraph,
    refreshSuggestedFaces,
    loadMoreDetectedFaces,
    mergeSelectedSimilar,
    autoMergeSimilar,
    isMergingSimilar,
    handleAssignWrapper,
    handleDeleteWrapper,
    handleDetachWrapper,
    handleDetachMediaWrapper,
    handleCreateWrapper,
    handleAutoSelectProfileFace,
    handleProfileAssignmentWrapper,
    handlePersonUpdate,
    handleDeletePerson,
    handleTagAddedToPerson,
    onSave,
    handleConfirmMerge,
    isAutoSelectingProfile,
    isLoadingSuggestedFaces,
    suggestedFacesLimit,
    setSuggestedFacesLimit,
    facesSortBy,
    handleFacesSortChange,
    fetchFacesForMedia,
  } = usePersonDetailPage();

  const selectExportDestination = async () => {
    try {
      const selectedDirectory = await pickDirectory();
      if (!selectedDirectory) return;
      setExportDestination(selectedDirectory);
      setExportDialogOpen(true);
    } catch (error) {
      console.error("Failed to select export folder:", error);
      setSnackbar({
        open: true,
        message: "选择导出文件夹失败",
        severity: "error",
      });
    }
  };

  // The export runs as a background task; poll it to report the outcome.
  useEffect(() => {
    if (!exportTask || !["pending", "running"].includes(exportTask.status)) {
      return;
    }
    let cancelled = false;
    const timeoutId = window.setTimeout(async () => {
      try {
        const updated = await getTask(exportTask.id);
        if (cancelled) return;
        if (["pending", "running"].includes(updated.status)) {
          setExportTask(updated);
          return;
        }
        setExportTask(null);
        if (updated.status !== "completed") {
          setSnackbar({
            open: true,
            message: ("媒体导出{0}。".replace(/\{(\d+)\}/g, (_, i) => String([updated.status][Number(i)]))),
            severity: updated.status === "failed" ? "error" : "info",
          });
          return;
        }
        const skipped = (await getTaskFailures(updated.id)).length;
        if (cancelled) return;
        const exported = updated.processed - skipped;
        setSnackbar({
          open: true,
          message: ("已导出 {0} 个媒体文件{1}{2}。".replace(/\{(\d+)\}/g, (_, i) => String([exported, exported === 1 ? "" : "s", skipped ? `; skipped ${skipped}` : ""][Number(i)]))),
          severity: skipped && exported === 0 ? "error" : "success",
        });
      } catch (error) {
        if (cancelled) return;
        console.error("Failed to fetch export task status:", error);
        setExportTask(null);
      }
    }, EXPORT_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [exportTask, setSnackbar]);

  const exportMedia = async (mode: "copy" | "move") => {
    if (!exportDestination) return;
    setExportingMedia(true);
    try {
      const task = await exportPersonMedia(
        person?.id ?? 0,
        exportDestination,
        mode,
      );
      setExportTask(task);
      setSnackbar({
        open: true,
        message: ("{0} 个媒体在后台处理；进度显示在任务中。".replace(/\{(\d+)\}/g, (_, i) => String([mode === "copy" ? "Copying" : "Moving"][Number(i)]))),
        severity: "info",
      });
      setExportDialogOpen(false);
      setExportDestination(null);
    } catch (error) {
      console.error(`Failed to ${mode} person media:`, error);
      setSnackbar({
        open: true,
        message:
          error instanceof Error ? error.message : ("{0}媒体失败".replace(/\{(\d+)\}/g, (_, i) => String([mode][Number(i)]))),
        severity: "error",
      });
    } finally {
      setExportingMedia(false);
    }
  };

  if (loading || !person) {
    return (
      <Box
        sx={{
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          height: "100vh",
        }}
      >
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Container maxWidth="xl" sx={{ pt: 2, pb: 6 }}>
      <PersonHero
        person={person}
        onSave={onSave}
        saving={saving}
        onMerge={() => setMergeOpen(true)}
        onDelete={() => setConfirmDelete(true)}
        onRefreshSimilar={loadSimilar}
        onAutoSelectProfile={handleAutoSelectProfileFace}
        autoSelectingProfile={isAutoSelectingProfile}
        onExportMedia={selectExportDestination}
        canExportMedia={canExportMedia}
        exportingMedia={exportingMedia || exportTask !== null}
      />

      <PersonContentTabs
        person={person}
        onTagUpdate={handlePersonUpdate}
        onTagAdded={handleTagAddedToPerson}
        detectedFacesList={detectedFacesList}
        hasMoreFaces={hasMoreFaces}
        loadingMoreFaces={loadingMoreFaces}
        loadMoreDetectedFaces={loadMoreDetectedFaces}
        handleProfileAssignmentWrapper={handleProfileAssignmentWrapper}
        handleAssignWrapper={handleAssignWrapper}
        handleDeleteWrapper={handleDeleteWrapper}
        handleDetachWrapper={handleDetachWrapper}
        onLoadSimilar={loadSimilar}
        suggestedFaces={suggestedFaces}
        similarPersons={similarPersons}
        onRefreshSuggestions={refreshSuggestedFaces}
        handleCreateWrapper={handleCreateWrapper}
        onMergeSelectedSimilar={mergeSelectedSimilar}
        onAutoMergeSimilar={autoMergeSimilar}
        isMergingSimilar={isMergingSimilar}
        isLoadingSuggestedFaces={isLoadingSuggestedFaces}
        suggestedFacesLimit={suggestedFacesLimit}
        onSuggestedFacesLimitChange={setSuggestedFacesLimit}
        filterPeople={filterPeople}
        onFilterPeopleChange={(people) => setFilterPeople(people)}
        filterTags={filterTags}
        onFilterTagsChange={(tags) => setFilterTags(tags)}
        mediaListKey={mediaListKey}
        relationshipGraph={relationshipGraph}
        relationshipDepth={relationshipDepth}
        isLoadingRelationships={isLoadingRelationships}
        hasLoadedRelationships={hasLoadedRelationships}
        onLoadRelationships={(depth) => loadRelationshipGraph(depth)}
        onDetachMedia={handleDetachMediaWrapper}
        facesSortBy={facesSortBy}
        onFacesSortChange={handleFacesSortChange}
        onFetchFacesForMedia={fetchFacesForMedia}
      />

      <Snackbar
        open={snackbar.open}
        autoHideDuration={3000}
        onClose={() => setSnackbar({ ...snackbar, open: false })}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert
          severity={snackbar.severity}
          sx={{ width: "100%" }}
          onClose={() => setSnackbar({ ...snackbar, open: false })}
        >
          {snackbar.message}
        </Alert>
      </Snackbar>

      {/* Confirm Delete Dialog */}
      <ConfirmDialog
        open={confirmDelete}
        title="确认删除"
        message="确定要删除此人物吗？"
        confirmLabel="Delete"
        onConfirm={handleDeletePerson}
        onClose={() => setConfirmDelete(false)}
      />

      <Dialog
        open={exportDialogOpen}
        onClose={exportingMedia ? undefined : () => setExportDialogOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>{"导出媒体到文件夹"}</DialogTitle>
        <DialogContent>
          <Typography>
            {person.appearance_count} {" 媒体文件 "}{person.appearance_count === 1 ? "" : ""} {" 包含此人物的内容将导出到： "}</Typography>
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ mt: 1, overflowWrap: "anywhere" }}
          >
            {exportDestination}
          </Typography>
          <Typography color="text.secondary" sx={{ mt: 2 }}>
            {" 复制会将原始文件保留在当前文件夹中。移动会重新定位文件并更新资料库中的路径。现有文件永远不会被覆盖。 "}</Typography>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => setExportDialogOpen(false)}
            disabled={exportingMedia}
          >
            {" 取消 "}</Button>
          <Button
            variant="outlined"
            onClick={() => exportMedia("copy")}
            disabled={exportingMedia}
          >
            {" 复制 "}</Button>
          <Button
            color="warning"
            variant="contained"
            onClick={() => exportMedia("move")}
            disabled={exportingMedia}
            startIcon={exportingMedia ? <CircularProgress size={16} /> : undefined}
          >
            {" 移动 "}</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={mergeTarget !== null} onClose={() => setMergeTarget(null)}>
        <DialogTitle>{"确认合并"}</DialogTitle>
        <DialogContent>
          <Typography>
            {/* Display both names for clarity */}
            {" 确定要将“"}{person.name}{"”合并到“ "}{mergeTarget?.name}"?
          </Typography>
          <Typography color="text.secondary" sx={{ mt: 1 }}>
            {" 此操作无法撤销。 "}</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setMergeTarget(null)}>{"取消"}</Button>
          <Button
            onClick={handleConfirmMerge}
            color="primary"
            variant="contained"
          >
            {" 确认合并 "}</Button>
        </DialogActions>
      </Dialog>

      {/* Merge Dialog */}
      <Dialog open={mergeOpen} onClose={() => setMergeOpen(false)}>
        <DialogTitle>将“{person.name||`未命名人物 ${person.id}`}”合并到…</DialogTitle>
        <DialogContent>
          <TextField
            label="筛选人物名称（可不填）"
            fullWidth
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            sx={{ mb: 2 }}
          />
          <Stack spacing={1}>
            {candidates.map((candidate) => (
              <Box
                key={candidate.id}
                onClick={() =>
                  setMergeTarget({
                    id: candidate.id,
                    name: candidate.name || `未命名人物 ${candidate.id}`,
                  })
                }
                sx={{
                  p: 1,
                  bgcolor: "background.paper",
                  borderRadius: 1,
                  cursor: "pointer",
                  "&:hover": {
                    bgcolor: "primary.dark",
                    color: "primary.contrastText",
                  },
                }}
              >
                <Stack direction="row" spacing={2} alignItems="center">
                  <Avatar
                    src={
                      candidate.profile_face?.thumbnail_path
                        ? withMediaCacheScope(`${API}/thumbnails/${encodeFilePath(
                            candidate.profile_face.thumbnail_path
                          )}`)
                        : undefined
                    }
                    alt={candidate.name ?? ("人物 {0}".replace(/\{(\d+)\}/g, (_, i) => String([candidate.id][Number(i)])))}
                  >
                    {getInitials(candidate.name)}
                  </Avatar>
                  <Box sx={{ minWidth: 0 }}>
                    <Typography noWrap sx={{ color: "inherit" }}>
                      {candidate.name || `未命名人物 ${candidate.id}`}
                    </Typography>
                    {candidate.appearance_count ? (
                      <Typography
                        variant="caption"
                        noWrap
                        sx={{ color: "inherit", opacity: 0.75 }}
                      >
                        {candidate.appearance_count} {" 媒体文件 "}</Typography>
                    ) : null}
                  </Box>
                </Stack>
              </Box>
            ))}
            {searchTerm && candidates.length === 0 && (
              <Typography color="text.secondary">{"无匹配项"}</Typography>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setMergeOpen(false)}>{"取消"}</Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
}
