import { createTheme } from "@mui/material";
import type { ThemeMode } from "./ThemeContext";

export const getAlbumTheme = (mode: ThemeMode) => {
  const dark = mode === "dark";
  return createTheme({
    palette: {
      mode,
      primary: { main: dark ? "#81A8FA" : "#3564CC" },
      secondary: { main: dark ? "#9DAABD" : "#65748B" },
      accent: { main: dark ? "#70C7B5" : "#298974" },
      background: { default: dark ? "#15181E" : "#F5F6F8", paper: dark ? "#1D2129" : "#FFFFFF" },
      text: { primary: dark ? "#E8ECF2" : "#242D3C", secondary: dark ? "#A3ADBC" : "#717D8E" },
      divider: dark ? "#303640" : "#E6E9EF",
      success: { main: dark ? "#70C7B5" : "#298974" },
    },
    shape: { borderRadius: 8 },
    typography: {
      fontFamily: '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif',
      fontSize: 13,
      h1: { fontSize: "2rem", fontWeight: 650 },
      h2: { fontSize: "1.7rem", fontWeight: 650 },
      h3: { fontSize: "1.5rem", fontWeight: 650 },
      h4: { fontSize: "1.4rem", fontWeight: 650 },
      h5: { fontSize: "1.2rem", fontWeight: 650 },
      h6: { fontSize: "1rem", fontWeight: 650 },
      button: { fontWeight: 550, textTransform: "none" },
    },
    components: {
      MuiCssBaseline: { styleOverrides: (theme) => ({
        "html, body, #root": { minHeight: "100%" },
        body: {
          "--color-primary": theme.palette.primary.main,
          "--color-paper": theme.palette.background.paper,
          "--color-bg": theme.palette.background.default,
          "--color-text": theme.palette.text.primary,
          "--color-accent": theme.palette.accent.main,
          "--overlay-active": dark ? "#FFFFFF18" : "#242D3C12",
        },
        "*": { scrollbarWidth: "thin", scrollbarColor: `${dark ? "#46505E" : "#CCD2DC"} transparent` },
        "*:focus-visible": { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 3 },
        "@media (prefers-reduced-motion: reduce)": { "*, *::before, *::after": { animationDuration: "0.01ms !important", transitionDuration: "0.01ms !important" } },
      }) },
      MuiPaper: { styleOverrides: { root: { backgroundImage: "none" } } },
      MuiButton: { defaultProps: { disableElevation: true, size: "small" }, styleOverrides: { root: { borderRadius: 7, minHeight: 34, paddingInline: 14 } } },
      MuiIconButton: { styleOverrides: { root: { borderRadius: 7 } } },
      MuiOutlinedInput: { styleOverrides: { root: { borderRadius: 7, backgroundImage: "none" }, notchedOutline: { borderColor: dark ? "#3B424F" : "#DEE3EB" } } },
      MuiChip: { styleOverrides: { root: { borderRadius: 5, fontWeight: 500 } } },
      MuiCard: { styleOverrides: { root: { boxShadow: "none", backgroundImage: "none" } } },
      MuiDialog: { styleOverrides: { paper: { borderRadius: 12 } } },
      MuiDialogTitle: { styleOverrides: { root: { fontWeight: 650, padding: "22px 24px 16px" } } },
      MuiDialogActions: { styleOverrides: { root: { padding: "14px 24px 22px" } } },
      MuiTooltip: { defaultProps: { arrow: true } },
      MuiListItemButton: { styleOverrides: { root: { borderRadius: 7 } } },
      MuiTab: { styleOverrides: { root: { minHeight: 46, textTransform: "none", fontWeight: 550 } } },
      MuiLinearProgress: { styleOverrides: { root: { borderRadius: 4, height: 5 } } },
    },
  });
};
