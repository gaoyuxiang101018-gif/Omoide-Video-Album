import { useMemo, useState } from "react";
import { Alert, Box, Button, Slider, Typography } from "@mui/material";
import BlurOnIcon from "@mui/icons-material/BlurOn";

import { ReviewPage } from "../components/ReviewPage";
import { formatBytes } from "../formatUtils";
import { startTask } from "../services/taskActions";
import { useTaskEvents } from "../TaskEventsContext";
import { BlurMediaItem } from "../types";
import { useLocalStorageNumber } from "../hooks/useLocalStoragePreference";

const DEFAULT_THRESHOLD = 100;

const scoreColor = (score: number) => {
  if (score < 30) return "error";
  if (score < 80) return "warning";
  return "default";
};

export default function BlurryPage() {
  const [threshold, setThreshold] = useLocalStorageNumber(
    "reviewBlurThreshold",
    DEFAULT_THRESHOLD,
    { min: 0, max: 500 }
  );
  const [pendingThreshold, setPendingThreshold] = useState(threshold);
  const [startError, setStartError] = useState<string | null>(null);
  const { activeTasks } = useTaskEvents();
  const blurTask = activeTasks.find((t) => t.task_type === "compute_blur_scores");
  const filters = useMemo(() => ({ threshold }), [threshold]);

  const handleStartScoring = async () => {
    try {
      setStartError(null);
      await startTask("compute_blur_scores");
    } catch (e) {
      setStartError(e instanceof Error ? e.message : "启动评分失败");
    }
  };

  return (
    <ReviewPage<BlurMediaItem>
      endpoint="/api/blur"
      title="模糊图片"
      description="显示拉普拉斯方差分数低于阈值的媒体。分数越低表示图像越模糊。分数在媒体处理期间或通过下方按钮计算。"
      filters={filters}
      banner={
        <>
          {blurTask && (
            <Alert severity="info" sx={{ mb: 2 }}>
              {" 正在评分… "}{blurTask.processed}/{blurTask.total}
              {blurTask.current_step ? ` (${blurTask.current_step})` : ""}
            </Alert>
          )}
          {startError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {startError}
            </Alert>
          )}
        </>
      }
      controls={
        <>
          <Box sx={{ flex: 1 }}>
            <Typography variant="subtitle2" gutterBottom id="blur-threshold">
              {" 模糊阈值： "}<strong>{pendingThreshold}</strong>
            </Typography>
            <Slider
              aria-labelledby="blur-threshold"
              value={pendingThreshold}
              onChange={(_, v) => setPendingThreshold(v as number)}
              onChangeCommitted={(_, v) => setThreshold(v as number)}
              min={0}
              max={500}
              step={5}
              marks={[
                { value: 30, label: "30" },
                { value: 100, label: "100" },
                { value: 200, label: "200" },
                { value: 500, label: "500" },
              ]}
              valueLabelDisplay="auto"
              sx={{ maxWidth: 480 }}
            />
          </Box>
          <Button
            variant="outlined"
            startIcon={<BlurOnIcon />}
            onClick={handleStartScoring}
            disabled={Boolean(blurTask)}
          >
            {" 为未评分的媒体评分 "}</Button>
        </>
      }
      rerunProcessors
      refreshOn={["compute_blur_scores"]}
      statsText={(total) => `${total.toLocaleString()} blurry items (threshold < ${threshold})`}
      emptyIcon={<BlurOnIcon />}
      emptyText={(total) =>
        `No scored media below the current threshold.${
          total === 0 ? ' Run "Score unscored media" to compute blur scores.' : ""
        }`
      }
      badge={(item) => ({
        label: item.laplacian_score.toFixed(1),
        color: scoreColor(item.laplacian_score),
      })}
      caption={(item) => `${formatBytes(item.size)}${item.duration != null ? " · video" : ""}`}
    />
  );
}
