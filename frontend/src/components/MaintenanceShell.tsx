import React from "react";
import { Box, Tabs, Tab } from "@mui/material";
import { Link, useLocation } from "react-router-dom";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import BrokenImageIcon from "@mui/icons-material/BrokenImage";
import BlurOnIcon from "@mui/icons-material/BlurOn";
import LabelOffIcon from "@mui/icons-material/LabelOff";
import VideocamOffIcon from "@mui/icons-material/VideocamOff";
import PhotoSizeSelectSmallIcon from "@mui/icons-material/PhotoSizeSelectSmall";
import EventBusyIcon from "@mui/icons-material/EventBusy";
import ReportProblemIcon from "@mui/icons-material/ReportProblem";

export const MAINTENANCE_TABS = [
  { label: "重复项", to: "/duplicates", icon: <ContentCopyIcon fontSize="small" /> },
  { label: "缺失文件", to: "/missing", icon: <BrokenImageIcon fontSize="small" /> },
  { label: "模糊图片", to: "/blur", icon: <BlurOnIcon fontSize="small" /> },
  { label: "未标记媒体", to: "/untagged", icon: <LabelOffIcon fontSize="small" /> },
  { label: "短视频", to: "/shortvideos", icon: <VideocamOffIcon fontSize="small" /> },
  { label: "低分辨率", to: "/lowresolution", icon: <PhotoSizeSelectSmallIcon fontSize="small" /> },
  { label: "无 EXIF 日期", to: "/noexifdate", icon: <EventBusyIcon fontSize="small" /> },
  { label: "损坏的媒体", to: "/broken", icon: <ReportProblemIcon fontSize="small" /> },
];

export const MAINTENANCE_PATHS = MAINTENANCE_TABS.map((tab) => tab.to);

interface MaintenanceShellProps {
  children: React.ReactNode;
}

/** Tab bar shared by all maintenance/review pages so they read as one section. */
export function MaintenanceShell({ children }: MaintenanceShellProps) {
  const location = useLocation();

  return (
    <Box>
      <Tabs
        value={location.pathname}
        variant="scrollable"
        scrollButtons="auto"
        allowScrollButtonsMobile
        sx={{ borderBottom: 1, borderColor: "divider", px: { xs: 1, sm: 2 } }}
      >
        {MAINTENANCE_TABS.map((tab) => (
          <Tab
            key={tab.to}
            label={tab.label}
            icon={tab.icon}
            iconPosition="start"
            value={tab.to}
            component={Link}
            to={tab.to}
            sx={{ minHeight: 48, py: 1 }}
          />
        ))}
      </Tabs>
      {children}
    </Box>
  );
}
