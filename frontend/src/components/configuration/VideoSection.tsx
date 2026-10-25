import { FormGroup, Grid, TextField } from "@mui/material";
import { ConfigSectionProps, SwitchSetting } from "./shared";

export default function VideoSection({
  config,
  onValueChange,
}: ConfigSectionProps) {
  return (
    <Grid container spacing={2}>
      <Grid size={{ xs: 12, sm: 6 }}>
        <TextField
          label="每个视频的最大帧数"
          value={config.video.max_frames_per_video}
          onChange={(e) =>
            onValueChange(
              "video",
              "max_frames_per_video",
              parseInt(e.target.value)
            )
          }
          fullWidth
          margin="normal"
          type="number"
          helperText="场景检测失败时的回退帧采样数量"
        />
      </Grid>
      <Grid size={{ xs: 12 }}>
        <FormGroup>
          <SwitchSetting
            label="自动场景检测"
            checked={config.video.auto_scene_detection}
            onChange={(checked) =>
              onValueChange("video", "auto_scene_detection", checked)
            }
            description="检测场景变化并使用这些帧作为缩略图和搜索。"
          />
        </FormGroup>
      </Grid>
    </Grid>
  );
}
