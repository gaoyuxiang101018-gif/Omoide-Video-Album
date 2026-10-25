import React, { useEffect, useState } from "react";
import { Badge, Box, Button, Drawer, IconButton, InputAdornment, Stack, TextField, Tooltip, Typography } from "@mui/material";
import MenuIcon from "@mui/icons-material/Menu";
import SearchIcon from "@mui/icons-material/Search";
import AssignmentOutlinedIcon from "@mui/icons-material/AssignmentOutlined";
import CloseIcon from "@mui/icons-material/Close";
import { useNavigate } from "react-router-dom";
import { useTaskEvents } from "../TaskEventsContext";
import { LibrarySidebar } from "./LibrarySidebar";
import { BinaryNavigationControls } from "./BinaryNavigationControls";
import ThemeToggleButton from "./ThemeToggleButton";
import TaskManager from "./TasksPanel";
import config from "../config";
import { AutoGroupingStatus } from "./AutoGroupingStatus";

export function AlbumHeader() {
  const [menu, setMenu] = useState(false), [tasks, setTasks] = useState(false), [query, setQuery] = useState("");
  const { activeTasks } = useTaskEvents();
  const navigate = useNavigate();
  const active = activeTasks.filter(task => task.status === "running" || task.status === "pending").length;
  useEffect(() => {
    const open = () => setTasks(true);
    window.addEventListener("omoide-open-tasks", open);
    return () => window.removeEventListener("omoide-open-tasks", open);
  }, []);
  return <>
    <Box component="header" sx={{ height: 72, position: "sticky", top: 0, zIndex: 1100, bgcolor: "background.paper", borderBottom: "1px solid", borderColor: "divider", px: { xs: 1.5, md: 3 }, display: "flex", alignItems: "center", gap: 1.5 }}>
      <IconButton aria-label="打开导航" onClick={() => setMenu(true)} sx={{ display: { md: "none" } }}><MenuIcon /></IconButton>
      <BinaryNavigationControls variant="inline" />
      <Box component="form" onSubmit={event => { event.preventDefault(); navigate(`/people?q=${encodeURIComponent(query.trim())}`); }} sx={{ maxWidth: 360, flex: 1 }}><TextField value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索人物姓名或编号" size="small" fullWidth inputProps={{ "aria-label": "全局搜索人物" }} slotProps={{ input: { startAdornment: <InputAdornment position="start"><SearchIcon sx={{ fontSize: 18 }} /></InputAdornment> } }} /></Box>
      <Box sx={{ flex: 1, display: { xs: "none", sm: "block" } }} />
      {!config.PRESENTATION_MODE && <AutoGroupingStatus />}
      <Box sx={{ display: { xs: "none", sm: "block" } }}><ThemeToggleButton /></Box>
      {!config.PRESENTATION_MODE && <Tooltip title="查看扫描、识别和人物归类进度"><Button variant={active ? "contained" : "outlined"} aria-label="任务与进度" onClick={() => setTasks(true)} sx={{ whiteSpace: "nowrap", borderColor: active ? undefined : "divider", minWidth: { xs: 36, sm: 116 }, px: { xs: 1, sm: 1.5 }, gap: 1 }}><Badge badgeContent={active} color="error"><AssignmentOutlinedIcon sx={{ fontSize: 18 }} /></Badge><Box component="span" sx={{ display: { xs: "none", sm: "inline" } }}>任务与进度</Box></Button></Tooltip>}
    </Box>
    <Drawer open={menu} onClose={() => setMenu(false)} sx={{ "& .MuiDrawer-paper": { width: 248, maxWidth: "90vw" } }}><LibrarySidebar variant="temporary" onClose={() => setMenu(false)} /></Drawer>
    <Drawer anchor="right" open={tasks} onClose={() => setTasks(false)} sx={{ "& .MuiDrawer-paper": { width: { xs: "100%", sm: 370 }, maxWidth: "100vw", p: 2.5 } }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" mb={2}><Typography variant="h6">任务与进度</Typography><IconButton aria-label="关闭任务面板" onClick={() => setTasks(false)}><CloseIcon /></IconButton></Stack><Button variant="outlined" sx={{mb:2}} onClick={()=>{setTasks(false);navigate('/recognition-progress');}}>完整识别进度与历史</Button><TaskManager isActive={tasks} />
    </Drawer>
  </>;
}
