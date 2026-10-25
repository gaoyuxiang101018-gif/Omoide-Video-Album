import React, { useState } from "react";
import { Box, Button, Collapse, Divider, List, ListItemButton, ListItemIcon, ListItemText, Tooltip, Typography } from "@mui/material";
import { Link, useLocation } from "react-router-dom";
import FaceOutlinedIcon from "@mui/icons-material/FaceOutlined";
import PeopleOutlineIcon from "@mui/icons-material/PeopleOutline";
import EventAvailableOutlinedIcon from "@mui/icons-material/EventAvailableOutlined";
import HistoryOutlinedIcon from '@mui/icons-material/HistoryOutlined';
import MovieOutlinedIcon from "@mui/icons-material/MovieOutlined";
import AutoFixHighOutlinedIcon from "@mui/icons-material/AutoFixHighOutlined";
import AssignmentOutlinedIcon from "@mui/icons-material/AssignmentOutlined";
import PhotoOutlinedIcon from "@mui/icons-material/PhotoOutlined";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import PhotoAlbumOutlinedIcon from "@mui/icons-material/PhotoAlbumOutlined";
import FavoriteBorderIcon from "@mui/icons-material/FavoriteBorder";
import AddIcon from "@mui/icons-material/Add";
import SettingsOutlinedIcon from "@mui/icons-material/SettingsOutlined";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import config from "../config";
import { useVideoLibrary } from "../context/VideoLibraryContext";
import { AddFolderDialog } from "./AddFolderDialog";

export function LibrarySidebar({ variant = "permanent", onClose }: { variant?: "permanent" | "temporary"; onClose?: () => void }) {
  const location = useLocation(), [more, setMore] = useState(false), [adding, setAdding] = useState(false);
  const { videos, directories, loading, isInDirectory } = useVideoLibrary();
  const folder = new URLSearchParams(location.search).get("folder");
  const temporary = variant === "temporary";
  const nav = (label: string, to: string, icon: React.ReactNode, active: boolean) => <ListItemButton key={to} component={Link} to={to} selected={active} onClick={onClose} sx={{ minHeight: 37, py: 0.5, mb: 0.35, px: 1.5, color: active ? "primary.main" : "text.secondary", "&.Mui-selected": { bgcolor: "action.selected", color: "primary.main" } }}><ListItemIcon sx={{ minWidth: 31, color: "inherit", "& svg": { fontSize: 19 } }}>{icon}</ListItemIcon><ListItemText primary={label} primaryTypographyProps={{ fontSize: 12.5, fontWeight: active ? 600 : 500 }} /></ListItemButton>;
  const heading = (text: string) => <Typography variant="caption" sx={{ display: "block", px: 1.5, mt: 2.2, mb: 0.8, fontSize: 10.5, letterSpacing: 0.4, color: "text.secondary" }}>{text}</Typography>;
  return <Box component="aside" aria-label="相册导航" sx={{ width: temporary ? "100%" : 224, flexShrink: 0, height: temporary ? "100%" : "100dvh", position: temporary ? "static" : "sticky", top: 0, display: temporary ? "flex" : { xs: "none", md: "flex" }, flexDirection: "column", bgcolor: "background.paper", borderRight: temporary ? 0 : "1px solid", borderColor: "divider" }}>
    <Box component={Link} to="/people" onClick={onClose} sx={{ height: 72, px: 2.8, display: "flex", alignItems: "center", gap: 1.3, textDecoration: "none", color: "text.primary", flexShrink: 0 }}><Box sx={{ display: "grid", placeItems: "center", width: 32, height: 32, bgcolor: "primary.main", color: "white", borderRadius: 1.2 }}><FaceOutlinedIcon fontSize="small" /></Box><Box><Typography sx={{ fontSize: 18, fontWeight: 650, lineHeight: 1.25, letterSpacing: -0.5 }}>Omoide</Typography><Typography variant="caption" color="text.secondary" sx={{ fontSize: 10 }}>人物 · 视频 · 出现片段</Typography></Box></Box>
    <Divider />
    <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", px: 1.5, pb: 2 }}>
      <List disablePadding>
        {heading("找一个人")}
        {config.ENABLE_PEOPLE && nav("人物检索", "/people", <PeopleOutlineIcon />, location.pathname === "/" || location.pathname.startsWith("/people") || location.pathname.startsWith("/person/"))}
        {config.ENABLE_PEOPLE && nav("首次出现", "/first-appearance", <EventAvailableOutlinedIcon />, location.pathname === "/first-appearance")}
        {config.ENABLE_PEOPLE && !config.PRESENTATION_MODE && nav('合并记录', '/merge-history', <HistoryOutlinedIcon/>, location.pathname === '/merge-history')}
        {config.ENABLE_PEOPLE && !config.PRESENTATION_MODE && nav('纠错与限制', '/face-review', <HistoryOutlinedIcon/>, location.pathname === '/face-review')}
        {config.ENABLE_PEOPLE && nav('模型与参数', '/recognition-parameters', <SettingsOutlinedIcon/>, location.pathname === '/recognition-parameters')}
        {config.ENABLE_PEOPLE && !config.PRESENTATION_MODE && nav("待确认人脸", "/orphanfaces", <FaceOutlinedIcon />, location.pathname === "/orphanfaces")}
        {!config.PRESENTATION_MODE && nav("识别进度", "/recognition-progress", <AssignmentOutlinedIcon />, location.pathname === "/recognition-progress")}
        {heading("资料库")}
        {nav("全部视频", "/videos", <MovieOutlinedIcon />, location.pathname === "/videos" && !folder)}
        {!config.PRESENTATION_MODE && nav("视频类型与还原", "/film", <AutoFixHighOutlinedIcon />, location.pathname === "/film")}
        {nav("照片", "/images", <PhotoOutlinedIcon />, location.pathname === "/images")}
        {nav("相册", "/albums", <PhotoAlbumOutlinedIcon />, location.pathname.startsWith("/album"))}
        {nav("收藏", "/favorites", <FavoriteBorderIcon />, location.pathname === "/favorites")}
        {!!directories.length && heading("已添加文件夹")}
        {directories.map(dir => {
          const count = videos.filter(video => isInDirectory(video.path, dir.path)).length;
          const name = dir.path.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() || dir.path;
          return <Tooltip key={dir.path} title={dir.path} placement="right"><ListItemButton component={Link} to={`/videos?folder=${encodeURIComponent(dir.path)}`} onClick={onClose} selected={location.pathname === "/videos" && folder === dir.path} sx={{ minHeight: 38, px: 1.5, mb: 0.4 }}><ListItemIcon sx={{ minWidth: 31, color: "text.secondary" }}><FolderOutlinedIcon sx={{ fontSize: 19 }} /></ListItemIcon><ListItemText primary={name} primaryTypographyProps={{ noWrap: true, fontSize: 12 }} /><Typography variant="caption" color="text.secondary" sx={{ ml: 0.5 }}>{loading ? "…" : count}</Typography>{dir.read_only && <LockOutlinedIcon sx={{ fontSize: 11, ml: 0.7, color: "text.disabled" }} />}</ListItemButton></Tooltip>;
        })}
        {!config.PRESENTATION_MODE && <Button fullWidth startIcon={<AddIcon />} onClick={() => setAdding(true)} sx={{ justifyContent: "flex-start", mt: 0.6, px: 1.5, fontSize: 12 }}>添加文件夹</Button>}
        <ListItemButton onClick={() => setMore(value => !value)} sx={{ mt: 2, px: 1.5 }}><ListItemText primary="更多工具" primaryTypographyProps={{ fontSize: 11, color: "text.secondary" }} />{more ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}</ListItemButton>
        <Collapse in={more}><Box sx={{ pl: 1 }}>{[["总览", "/overview"], ["统计", "/statistics"], ["标签", "/tags"], ["事件", "/events"], ["地图", "/map"], ["地点", "/places"], ["精彩集锦", "/highlights"], ["维护", "/duplicates"]].filter(([, to]) => (!config.PRESENTATION_MODE || to !== "/duplicates") && (config.EVENTS_ENABLED || to !== "/events")).map(([label, to]) => nav(label, to, <ChevronRightIcon />, location.pathname === to))}</Box></Collapse>
      </List>
    </Box>
    <Divider /><Box sx={{ p: 1.5 }}>{!config.PRESENTATION_MODE && nav("设置", "/configuration", <SettingsOutlinedIcon />, location.pathname === "/configuration")}<Typography variant="caption" display="block" color="text.secondary" sx={{ px: 1.5, pt: 1, fontSize: 10 }}>本机相册 · v{config.APP_VERSION}</Typography></Box>
    <AddFolderDialog open={adding} onClose={() => setAdding(false)} />
  </Box>;
}
