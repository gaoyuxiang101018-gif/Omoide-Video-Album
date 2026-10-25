import { useState } from "react";
import {
  Box,
  Button,
  CircularProgress,
  FormControlLabel,
  Paper,
  Stack,
  Switch,
  Typography,
} from "@mui/material";
import { runProcessor } from "../../services/taskActions";
import { AppConfig } from "../../types";
import { ConfigUpdate, ShowSnackbar } from "./shared";

interface ProcessorRow {
  processorName: string;
  label: string;
  description: string;
  enabled: boolean;
  disabled?: boolean;
  onToggle: (v: boolean) => void;
}

interface ProcessorsSectionProps {
  config: AppConfig;
  onChange: ConfigUpdate;
  showSnackbar: ShowSnackbar;
}

export default function ProcessorsSection({
  config,
  onChange,
  showSnackbar,
}: ProcessorsSectionProps) {
  const [runningProcessor, setRunningProcessor] = useState<string | null>(null);

  const handleRunProcessor = async (name: string, force: boolean) => {
    setRunningProcessor(name);
    try {
      await runProcessor(name, force);
      showSnackbar(
        `Started processor "${name}"${force ? " (reprocessing all)" : ""}.`,
        "success"
      );
    } catch {
      showSnackbar(`Failed to start processor "${name}".`, "error");
    } finally {
      setRunningProcessor(null);
    }
  };

  const handleProcessorToggle = (
    key: keyof AppConfig["processors"],
    value: boolean
  ) => {
    let infoMessage: string | null = null;
    onChange((prev) => {
      let next = {
        ...prev,
        processors: { ...prev.processors, [key]: value },
      };
      if (key === "image_embedding_processor_active" && !value) {
        const disabled: string[] = [];
        if (prev.tagging.auto_tagging) {
          disabled.push("自动标签");
          next = {
            ...next,
            tagging: { ...prev.tagging, auto_tagging: false },
          };
        }
        if (disabled.length > 0) {
          infoMessage = `Disabled ${disabled.join(", ")} because image embeddings are turned off.`;
        }
      }
      return next;
    });
    if (infoMessage) {
      showSnackbar(infoMessage, "info");
    }
  };

  const handleAutoTaggingToggle = (value: boolean) => {
    if (!config.processors.image_embedding_processor_active && value) {
      showSnackbar(
        "在开启自动标签之前，请先启用图像特征处理器。",
        "info"
      );
      return;
    }
    onChange((prev) => ({
      ...prev,
      tagging: { ...prev.tagging, auto_tagging: value },
    }));
  };

  const handleFaceProcessorToggle = (value: boolean) => {
    if (value && !config.general.enable_people) {
      showSnackbar(
        "在开启人脸处理器之前，请先启用人物功能。",
        "info"
      );
      return;
    }
    handleProcessorToggle("face_processor_active", value);
  };

  const rows: ProcessorRow[] = [
    {
      processorName: "exif",
      label: "EXIF 处理器",
      description:
        "提取日期、相机、GPS 和其他元数据，用于搜索和地图。",
      enabled: config.processors.exif_processor_active,
      onToggle: (v) => handleProcessorToggle("exif_processor_active", v),
    },
    {
      processorName: "faces",
      label: "人脸处理器",
      description: ("检测图像中的人脸并准备用于识别。{0}".replace(/\{(\d+)\}/g, (_, i) => String([!config.general.enable_people ? " Enable People to turn this on." : ""][Number(i)]))),
      enabled: config.processors.face_processor_active,
      disabled: !config.general.enable_people,
      onToggle: handleFaceProcessorToggle,
    },
    {
      processorName: "embedding_extractor",
      label: "图像特征处理器",
      description:
        "生成 CLIP 嵌入，用于搜索、相似度和相关内容。",
      enabled: config.processors.image_embedding_processor_active,
      onToggle: (v) =>
        handleProcessorToggle("image_embedding_processor_active", v),
    },
    {
      processorName: "auto_tagger",
      label: "自动标签",
      description:
        "基于 CLIP 嵌入推荐标签。需要图像特征。",
      enabled: config.tagging.auto_tagging,
      disabled: !config.processors.image_embedding_processor_active,
      onToggle: handleAutoTaggingToggle,
    },
    {
      processorName: "blur",
      label: "模糊检测器",
      description:
        "为每张图像评估清晰度（拉普拉斯方差）以识别模糊照片。",
      enabled: config.processors.blur_processor_active,
      onToggle: (v) => handleProcessorToggle("blur_processor_active", v),
    },
  ];

  return (
    <Stack spacing={2}>
      {rows.map((proc) => {
        const isRunning = runningProcessor === proc.processorName;
        return (
          <Paper key={proc.processorName} variant="outlined" sx={{ p: 2 }}>
            <Box
              sx={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: 2,
              }}
            >
              <Box sx={{ flex: 1 }}>
                <FormControlLabel
                  control={
                    <Switch
                      checked={proc.enabled}
                      onChange={(e) => proc.onToggle(e.target.checked)}
                      disabled={proc.disabled}
                    />
                  }
                  label={proc.label}
                />
                <Typography
                  variant="caption"
                  sx={{ ml: 6, mt: -0.5, display: "block", color: "text.secondary" }}
                >
                  {proc.description}
                </Typography>
              </Box>
              <Box sx={{ display: "flex", gap: 1, flexShrink: 0, mt: 0.5 }}>
                <Button
                  size="small"
                  variant="outlined"
                  disabled={isRunning}
                  onClick={() => handleRunProcessor(proc.processorName, false)}
                  aria-label={isRunning ? ("运行 {0}".replace(/\{(\d+)\}/g, (_, i) => String([proc.label][Number(i)]))) : undefined}
                >
                  {isRunning ? <CircularProgress size={16} /> : "运行"}
                </Button>
                <Button
                  size="small"
                  variant="outlined"
                  color="warning"
                  disabled={isRunning}
                  onClick={() => handleRunProcessor(proc.processorName, true)}
                >
                  {" 全部重新运行 "}</Button>
              </Box>
            </Box>
          </Paper>
        );
      })}
    </Stack>
  );
}
