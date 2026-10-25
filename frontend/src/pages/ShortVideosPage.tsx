import { useMemo, useState } from "react";
import { Box, Slider, Typography } from "@mui/material";
import VideocamOffIcon from "@mui/icons-material/VideocamOff";

import { ReviewPage } from "../components/ReviewPage";
import { formatBytes } from "../formatUtils";
import { ShortVideoItem } from "../types";
import { useLocalStorageNumber } from "../hooks/useLocalStoragePreference";

const DEFAULT_MAX_DURATION = 10;

const formatDuration = (seconds: number) => {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toFixed(0).padStart(2, "0");
  return `${m}:${s}`;
};

export default function ShortVideosPage() {
  const [maxDuration, setMaxDuration] = useLocalStorageNumber(
    "reviewShortVideoMaxSeconds",
    DEFAULT_MAX_DURATION,
    { min: 1, max: 120 }
  );
  const [pendingDuration, setPendingDuration] = useState(maxDuration);
  const filters = useMemo(() => ({ max_duration: maxDuration }), [maxDuration]);

  return (
    <ReviewPage<ShortVideoItem>
      endpoint="/api/shortvideos"
      title="短视频"
      description="时长低于阈值的视频。适合查找可能不值得保留的意外录制、Boomerang 或动画片段。按从最短到最长排序。"
      filters={filters}
      mediaTypeFilter={false}
      controls={
        <Box sx={{ flex: 1 }}>
          <Typography variant="subtitle2" gutterBottom id="shortvideos-duration">
            {" 最长时长： "}<strong>{formatDuration(pendingDuration)}</strong>
          </Typography>
          <Slider
            aria-labelledby="shortvideos-duration"
            value={pendingDuration}
            onChange={(_, v) => setPendingDuration(v as number)}
            onChangeCommitted={(_, v) => setMaxDuration(v as number)}
            min={1}
            max={120}
            step={1}
            marks={[
              { value: 5, label: "5秒" },
              { value: 10, label: "10秒" },
              { value: 30, label: "30秒" },
              { value: 60, label: "1分" },
              { value: 120, label: "2分" },
            ]}
            valueLabelDisplay="auto"
            valueLabelFormat={(v) => formatDuration(v)}
            sx={{ maxWidth: 480 }}
          />
        </Box>
      }
      statsText={(total) =>
        `${total.toLocaleString()} video${total !== 1 ? "s" : ""} under ${formatDuration(maxDuration)}`
      }
      emptyIcon={<VideocamOffIcon />}
      emptyText={() => `No videos shorter than ${formatDuration(maxDuration)}.`}
      badge={(item) => ({ label: formatDuration(item.duration), color: "primary" })}
      caption={(item) =>
        `${formatBytes(item.size)}${
          item.width && item.height ? ` · ${item.width}×${item.height}` : ""
        }`
      }
    />
  );
}
