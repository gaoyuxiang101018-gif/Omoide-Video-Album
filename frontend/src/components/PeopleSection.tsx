import { withMediaCacheScope } from "../urlUtils";
import React, { Suspense, useEffect, useState } from "react";
import {
  Alert,
  Autocomplete,
  Avatar,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Snackbar,
  TextField,
  Typography,
} from "@mui/material";
import { Person, Face } from "../types";
import PersonCard from "./PersonCard";
import config, { API } from "../config";
import { encodeFilePath } from "../urlUtils";
import {
  AddMediaAppearanceResult,
  searchPersonsByName,
} from "../services/personActions";

const DetectedFaces = React.lazy(() => import("./DetectedFaces"));

interface PeopleSectionProps {
  persons: Person[];
  orphans: Face[];
  onAssign: (faceIds: number[], personId: number) => Promise<void>;
  onCreateFace: (faceIds: number[], name?: string) => Promise<Person>;
  onDeleteFace: (faceIds: number[]) => Promise<void>;
  onDetachFace: (faceIds: number[]) => Promise<void>;
  onAttachMediaToPerson?: (
    personId: number
  ) => Promise<AddMediaAppearanceResult | void>;
}

const SectionLoader = () => (
  <Box
    sx={{
      display: "flex",
      justifyContent: "center",
      alignItems: "center",
      height: "200px",
    }}
  >
    <CircularProgress />
  </Box>
);

export function PeopleSection({
  persons,
  orphans,
  onAssign,
  onCreateFace,
  onDeleteFace,
  onDetachFace,
  onAttachMediaToPerson,
}: PeopleSectionProps) {
  const [attachDialogOpen, setAttachDialogOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [personOptions, setPersonOptions] = useState<Person[]>([]);
  const [selectedPerson, setSelectedPerson] = useState<Person | null>(null);
  const [isAttaching, setIsAttaching] = useState(false);
  const [snackbar, setSnackbar] = useState<{
    open: boolean;
    message: string;
    severity: "success" | "info" | "error";
  }>({ open: false, message: "", severity: "success" });

  useEffect(() => {
    if (!attachDialogOpen) {
      return;
    }
    const trimmed = searchTerm.trim();
    if (trimmed.length < 2) {
      setPersonOptions([]);
      return;
    }

    let active = true;
    const handle = window.setTimeout(() => {
      searchPersonsByName(trimmed)
        .then((results) => {
          if (active) {
            setPersonOptions(results);
          }
        })
        .catch((err) => {
          console.error("Failed to search persons:", err);
        });
    }, 300);

    return () => {
      active = false;
      window.clearTimeout(handle);
    };
  }, [attachDialogOpen, searchTerm]);

  const resetAttachDialog = () => {
    setAttachDialogOpen(false);
    setSearchTerm("");
    setPersonOptions([]);
    setSelectedPerson(null);
  };

  const handleAttachConfirm = async () => {
    if (!onAttachMediaToPerson || !selectedPerson) {
      return;
    }
    setIsAttaching(true);
    try {
      const result = await onAttachMediaToPerson(selectedPerson.id);
      if (result && result.added === false) {
        setSnackbar({
          open: true,
          message:
            "此媒体文件已关联到该人物，或已检测到匹配的人脸。",
          severity: "info",
        });
      } else {
        setSnackbar({
          open: true,
          message: "媒体文件已关联到人物。",
          severity: "success",
        });
      }
      resetAttachDialog();
    } catch (err) {
      console.error("Failed to attach media to person:", err);
      setSnackbar({
        open: true,
        message: "无法将媒体文件关联到人物。",
        severity: "error",
      });
    } finally {
      setIsAttaching(false);
    }
  };

  return (
    <>
      {!config.PRESENTATION_MODE && onAttachMediaToPerson && (
        <Box mb={2} sx={{ display: "flex", justifyContent: "flex-end" }}>
          <Button variant="outlined" onClick={() => setAttachDialogOpen(true)}>
            {" 将媒体关联到人物 "}</Button>
        </Box>
      )}

      {persons && persons.length > 0 && (
        <Box mb={4}>
          <Typography variant="h6" gutterBottom>
            {" 检测到的人物 "}</Typography>
          <Box sx={{ display: "flex", overflowX: "auto", gap: 2, py: 1 }}>
            {persons.map((p) => (
              <Box
                key={p.id}
                sx={{
                  width: "140px",
                  flexShrink: 0,
                }}
              >
                <PersonCard person={p} />
              </Box>
            ))}
          </Box>
        </Box>
      )}

      {/* Unassigned Faces Section */}
      {orphans.length > 0 && !config.PRESENTATION_MODE && (
        <Box mb={4}>
          <Suspense fallback={<SectionLoader />}>
            <DetectedFaces
              isProcessing={false}
              title="待确认人脸"
              faces={orphans}
              onAssign={onAssign}
              onDelete={onDeleteFace}
              onDetach={onDetachFace}
              onCreateMultiple={onCreateFace}
            />
          </Suspense>
        </Box>
      )}

      <Dialog
        open={attachDialogOpen}
        onClose={resetAttachDialog}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>{"将媒体关联到人物"}</DialogTitle>
        <DialogContent>
          <Autocomplete
            options={personOptions}
            value={selectedPerson}
            getOptionLabel={(option) => option.name || `Person ${option.id}`}
            isOptionEqualToValue={(option, value) => option.id === value.id}
            inputValue={searchTerm}
            onInputChange={(_, value) => setSearchTerm(value)}
            onChange={(_, value) => setSelectedPerson(value)}
            renderOption={(props, option) => {
              const thumbPath = option.profile_face?.thumbnail_path;
              const thumbUrl = thumbPath
                ? withMediaCacheScope(`${API}/thumbnails/${encodeFilePath(thumbPath)}`)
                : undefined;
              const initials =
                (option.name || `P${option.id}`)
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
                autoFocus
                label="搜索人物"
                helperText={
                  searchTerm.trim().length < 2
                    ? "输入至少两个字符进行搜索"
                    : undefined
                }
              />
            )}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={resetAttachDialog} disabled={isAttaching}>
            {" 取消 "}</Button>
          <Button
            variant="contained"
            onClick={handleAttachConfirm}
            disabled={!selectedPerson || isAttaching}
          >
            {isAttaching ? "正在关联..." : "关联"}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={snackbar.open}
        autoHideDuration={3500}
        onClose={() => setSnackbar((prev) => ({ ...prev, open: false }))}
      >
        <Alert
          severity={snackbar.severity}
          onClose={() => setSnackbar((prev) => ({ ...prev, open: false }))}
          sx={{ width: "100%" }}
        >
          {snackbar.message}
        </Alert>
      </Snackbar>
    </>
  );
}
