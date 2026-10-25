import React, { useMemo } from "react";
import { BrowserRouter as Router } from "react-router-dom";
import { ThemeProvider as MuiThemeProvider, CssBaseline, createTheme } from "@mui/material";
import { zhCN } from "@mui/material/locale";
import { useThemeContext } from "./ThemeContext";
import { getAlbumTheme } from "./albumTheme";
import { TaskEventsProvider } from "./TaskEventsContext";
import { SelectionProvider } from "./context/SelectionContext";
import { ScrollToTop } from "./components/ScrollToTop";
import { AppRoutes } from "./routes";
import { VideoLibraryProvider } from "./context/VideoLibraryContext";
import { TaskHistoryProvider } from "./context/TaskHistoryContext";

export default function App() {
  const { mode } = useThemeContext();
  const theme = useMemo(() => createTheme(getAlbumTheme(mode), zhCN), [mode]);

  return (
    <TaskEventsProvider>
      <MuiThemeProvider theme={theme}>
        <CssBaseline />
        <TaskHistoryProvider>
        <SelectionProvider>
          <VideoLibraryProvider>
          <Router>
            <ScrollToTop />
            <AppRoutes />
          </Router>
          </VideoLibraryProvider>
        </SelectionProvider>
        </TaskHistoryProvider>
      </MuiThemeProvider>
    </TaskEventsProvider>
  );
}
