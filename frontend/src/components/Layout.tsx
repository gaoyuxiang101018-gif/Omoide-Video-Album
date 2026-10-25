import React from "react";
import { Box, CssBaseline } from "@mui/material";
import { Outlet } from "react-router-dom";
import { AlbumHeader as Header } from "./AlbumHeader";
import { LibrarySidebar as Sidebar } from "./LibrarySidebar";
import { TaskProgressStrip } from "./TaskProgressStrip";
import ProfileSetupDialog from "./ProfileSetupDialog";
import { SelectionActionBar } from "./SelectionActionBar";

export function Layout() {
  return (
    <Box sx={{ display: "flex", minHeight: "100vh" }}>
      <CssBaseline />
      <Sidebar />
      <Box sx={{ flexGrow: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <Header />
            <TaskProgressStrip />
        <Box component="main" sx={{ flexGrow: 1, p: 0, position: "relative" }}>
          <Outlet />
        </Box>
      </Box>
      <ProfileSetupDialog />
      <SelectionActionBar />
    </Box>
  );
}
