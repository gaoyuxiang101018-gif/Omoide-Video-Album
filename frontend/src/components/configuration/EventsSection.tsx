import { FormGroup, Grid, TextField } from "@mui/material";
import { ConfigSectionProps, SwitchSetting } from "./shared";

export default function EventsSection({
  config,
  onValueChange,
}: ConfigSectionProps) {
  return (
    <Grid container spacing={2}>
      <Grid size={{ xs: 12 }}>
        <FormGroup>
          <SwitchSetting
            label="启用事件标签页"
            checked={config.events.events_enabled}
            onChange={(checked) =>
              onValueChange("events", "events_enabled", checked)
            }
            description="显示事件标签页，并允许将资料库归类为旅行和时刻。"
          />
          <SwitchSetting
            label="重建时保留已重命名的事件"
            checked={config.events.preserve_renamed_on_rebuild}
            onChange={(checked) =>
              onValueChange("events", "preserve_renamed_on_rebuild", checked)
            }
            description={
              "再次运行“重建事件”时，尝试通过媒体重叠将已重命名的事件匹配到其新集群，并保留自定义标题。关闭时，重建将始终清除所有标题。"
            }
          />
        </FormGroup>
      </Grid>
      <Grid size={{ xs: 12, sm: 6 }}>
        <TextField
          label="事件间隔（小时）"
          value={config.events.event_gap_hours}
          onChange={(e) =>
            onValueChange(
              "events",
              "event_gap_hours",
              parseFloat(e.target.value)
            )
          }
          fullWidth
          margin="normal"
          type="number"
          helperText="当连续媒体文件间隔超过此值时，开始新事件"
        />
      </Grid>
      <Grid size={{ xs: 12, sm: 6 }}>
        <TextField
          label="每个事件的最小媒体数"
          value={config.events.event_min_media}
          onChange={(e) =>
            onValueChange(
              "events",
              "event_min_media",
              parseInt(e.target.value, 10)
            )
          }
          fullWidth
          margin="normal"
          type="number"
          helperText="小于此值的集群将作为噪声丢弃"
        />
      </Grid>
    </Grid>
  );
}
