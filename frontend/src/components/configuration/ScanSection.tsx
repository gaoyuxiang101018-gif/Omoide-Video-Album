import { useState } from "react";
import { FormGroup, Grid, TextField } from "@mui/material";
import { ConfigSectionProps, SwitchSetting } from "./shared";

/** "jpg, .HEIC ,png" -> [".jpg", ".heic", ".png"] */
const parseSuffixList = (raw: string): string[] =>
  raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0)
    .map((s) => (s.startsWith(".") ? s : "." + s));

export default function ScanSection({
  config,
  onValueChange,
}: ConfigSectionProps) {
  // Local text buffers for comma-separated fields — avoids cursor-jump caused
  // by the parse→join round-trip through config state on every keystroke.
  const [imageSuffixesText, setImageSuffixesText] = useState<string | null>(null);
  const [videoSuffixesText, setVideoSuffixesText] = useState<string | null>(null);

  return (
    <Grid container spacing={2}>
      <Grid size={{ xs: 12, sm: 6 }}>
        <TextField
          label="扫描间隔（分钟）"
          value={config.scan.scan_interval_minutes}
          onChange={(e) =>
            onValueChange(
              "scan",
              "scan_interval_minutes",
              parseInt(e.target.value)
            )
          }
          fullWidth
          margin="normal"
          type="number"
          helperText="自动扫描开启时查找新增/更改文件的频率"
        />
      </Grid>
      <Grid size={{ xs: 12 }}>
        <FormGroup>
          <SwitchSetting
            label="自动扫描"
            checked={config.scan.auto_scan}
            onChange={(checked) => onValueChange("scan", "auto_scan", checked)}
            description="定期在后台扫描媒体目录。"
          />
          <SwitchSetting
            label="扫描时自动清理"
            checked={config.scan.auto_clean_on_scan}
            onChange={(checked) =>
              onValueChange("scan", "auto_clean_on_scan", checked)
            }
            description="每次扫描后标记缺失文件，以便您稍后查看或自动移除。"
          />
          <SwitchSetting
            label="无需查看自动清理"
            checked={config.scan.auto_cleanup_without_review}
            onChange={(checked) =>
              onValueChange("scan", "auto_cleanup_without_review", checked)
            }
            description="启用后，缺失文件将在下方宽限期后自动删除。"
          />
          <TextField
            label="清理宽限期（小时）"
            type="number"
            value={config.scan.auto_cleanup_grace_hours}
            onChange={(e) =>
              onValueChange(
                "scan",
                "auto_cleanup_grace_hours",
                e.target.value === "" ? 0 : Math.max(0, Number(e.target.value))
              )
            }
            inputProps={{ min: 0 }}
            margin="normal"
            sx={{ ml: 6, maxWidth: 240 }}
            helperText="文件在自动清理移除前可保持缺失状态的小时数。"
          />
          <SwitchSetting
            label="扫描时自动归类"
            checked={config.scan.auto_cluster_on_scan}
            onChange={(checked) =>
              onValueChange("scan", "auto_cluster_on_scan", checked)
            }
            description="每次扫描后自动将新人脸归类到人物。"
          />
          <SwitchSetting
            label="自动旋转"
            checked={config.scan.auto_rotate}
            onChange={(checked) => onValueChange("scan", "auto_rotate", checked)}
            description="将 EXIF 方向应用于文件并规范化旋转。"
          />
          <SwitchSetting
            label="扫描时跳过缩略图"
            checked={config.scan.skip_thumbnails_on_scan}
            onChange={(checked) =>
              onValueChange("scan", "skip_thumbnails_on_scan", checked)
            }
            description="忽略名称类似缩略图的文件和文件夹（例如 thumb_* 或 thumbnails 文件夹）。"
          />
        </FormGroup>
      </Grid>
      <Grid size={{ xs: 12, sm: 6 }}>
        <TextField
          label="图像格式"
          value={imageSuffixesText ?? config.scan.IMAGE_SUFFIXES.join(", ")}
          onChange={(e) => setImageSuffixesText(e.target.value)}
          onBlur={(e) => {
            onValueChange(
              "scan",
              "IMAGE_SUFFIXES",
              parseSuffixList(e.target.value)
            );
            setImageSuffixesText(null);
          }}
          fullWidth
          margin="normal"
          helperText="逗号分隔的图像扩展名（例如 .jpg, .heic, .png）"
        />
      </Grid>
      <Grid size={{ xs: 12, sm: 6 }}>
        <TextField
          label="视频格式"
          value={videoSuffixesText ?? config.scan.VIDEO_SUFFIXES.join(", ")}
          onChange={(e) => setVideoSuffixesText(e.target.value)}
          onBlur={(e) => {
            onValueChange(
              "scan",
              "VIDEO_SUFFIXES",
              parseSuffixList(e.target.value)
            );
            setVideoSuffixesText(null);
          }}
          fullWidth
          margin="normal"
          helperText="逗号分隔的视频扩展名（例如 .mp4, .mov, .mkv）"
        />
      </Grid>
    </Grid>
  );
}
