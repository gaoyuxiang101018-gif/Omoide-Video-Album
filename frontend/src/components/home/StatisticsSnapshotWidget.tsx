import React, { useEffect, useState } from "react";
import { Box, Typography } from "@mui/material";
import InsightsIcon from "@mui/icons-material/Insights";
import { getLibraryStats } from "../../services/features";
import { LibraryStats } from "../../types";
import { formatBytes } from "../../formatUtils";
import { HomeWidgetCard } from "./HomeWidgetCard";

/** Homepage widget: at-a-glance counts for the library. */
export function StatisticsSnapshotWidget() {
  const [stats, setStats] = useState<LibraryStats | null>(null);

  useEffect(() => {
    let alive = true;
    getLibraryStats()
      .then((data) => {
        if (alive) setStats(data);
      })
      .catch((err) => console.warn("Failed to load statistics:", err));
    return () => {
      alive = false;
    };
  }, []);

  if (!stats) return null;

  const tiles = [
    { label: "照片", value: stats.totals.images.toLocaleString() },
    { label: "视频", value: stats.totals.videos.toLocaleString() },
    { label: "收藏", value: stats.totals.favorites.toLocaleString() },
    { label: "存储", value: formatBytes(stats.totals.size_bytes) },
    { label: "人物", value: stats.totals.persons.toLocaleString() },
  ];

  return (
    <HomeWidgetCard
      icon={<InsightsIcon color="primary" fontSize="small" />}
      title="统计"
      viewAllTo="/statistics"
    >
      <Box sx={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
        {tiles.map((tile) => (
          <Box key={tile.label} sx={{ minWidth: 90 }}>
            <Typography variant="h6" fontWeight={700}>
              {tile.value}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {tile.label}
            </Typography>
          </Box>
        ))}
      </Box>
    </HomeWidgetCard>
  );
}
