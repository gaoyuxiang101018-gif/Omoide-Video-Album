import { useState } from "react";
import { FormGroup, Grid, TextField } from "@mui/material";
import { ConfigSectionProps, SwitchSetting } from "./shared";

export default function TaggingSection({
  config,
  onValueChange,
}: ConfigSectionProps) {
  // Local text buffer — avoids cursor-jump from the split→join round-trip.
  const [customTagsText, setCustomTagsText] = useState<string | null>(null);

  return (
    <Grid container spacing={2}>
      <Grid size={{ xs: 12 }}>
        <TextField
          label="自定义标签"
          value={customTagsText ?? config.tagging.custom_tags.join(",")}
          onChange={(e) => setCustomTagsText(e.target.value)}
          onBlur={(e) => {
            onValueChange("tagging", "custom_tags", e.target.value.split(","));
            setCustomTagsText(null);
          }}
          fullWidth
          margin="normal"
          helperText="逗号分隔的标签列表"
        />
      </Grid>
      <Grid size={{ xs: 12 }}>
        <FormGroup>
          <SwitchSetting
            label="自动打标签"
            checked={config.tagging.auto_tagging}
            onChange={(checked) =>
              onValueChange("tagging", "auto_tagging", checked)
            }
            description="使用 CLIP 模型为媒体生成描述性标签。"
          />
          <SwitchSetting
            label="使用默认标签"
            checked={config.tagging.use_default_tags}
            onChange={(checked) =>
              onValueChange("tagging", "use_default_tags", checked)
            }
            description="在您的自定义列表旁包含一组精选的常用标签。"
          />
        </FormGroup>
      </Grid>
    </Grid>
  );
}
