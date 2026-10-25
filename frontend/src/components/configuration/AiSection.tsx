import { Alert, Grid, TextField } from "@mui/material";
import { ConfigSectionProps } from "./shared";

export default function AiSection({ config, onValueChange }: ConfigSectionProps) {
  return (
    <Grid container spacing={2}>
      <Grid size={{ xs: 12, sm: 6 }}>
        <TextField
          label="Clip 模型"
          value={`${config.ai.clip_model} (${config.ai.clip_model_embedding_size}-d)`}
          fullWidth
          margin="normal"
          InputProps={{ readOnly: true }}
          helperText="Clip 模型已锁定。请在环境变量中设置 OMOIDE_AI__CLIP_MODEL 以更改。"
        />
      </Grid>
      <Grid size={{ xs: 12, sm: 6 }}>
        <TextField
          label="最小搜索距离"
          value={config.ai.min_search_dist}
          onChange={(e) =>
            onValueChange("ai", "min_search_dist", parseFloat(e.target.value))
          }
          fullWidth
          margin="normal"
          type="number"
          helperText="值越高 = 搜索相似度越严格（结果更少、更准确）"
        />
      </Grid>
      <Grid size={{ xs: 12, sm: 6 }}>
        <TextField
          label="最小相似度距离"
          value={config.ai.min_similarity_dist}
          onChange={(e) =>
            onValueChange(
              "ai",
              "min_similarity_dist",
              parseFloat(e.target.value)
            )
          }
          fullWidth
          margin="normal"
          type="number"
          helperText="值越高 = 需要更强的匹配才能将媒体文件视为相似"
        />
      </Grid>
      <Grid size={{ xs: 12 }}>
        <Alert severity="info" sx={{ mt: 1 }}>
          {" 人物自动归类控制现在位于人脸识别预设和手动调整下。 "}</Alert>
      </Grid>
    </Grid>
  );
}
