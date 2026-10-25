import { FormGroup, Grid, TextField, Typography } from "@mui/material";
import MediaDirectoriesSection from "./MediaDirectoriesSection";
import { CacheLocationNote } from "./CacheLocationNote";
import {
  ConfigSectionProps,
  ConfigUpdate,
  ShowSnackbar,
  SwitchSetting,
} from "./shared";

interface GeneralSectionProps extends ConfigSectionProps {
  onChange: ConfigUpdate;
  showSnackbar: ShowSnackbar;
  onAcknowledgeMediaDirRemoval: (normalizedPath: string) => void;
}

export default function GeneralSection({
  config,
  onValueChange,
  onChange,
  showSnackbar,
  onAcknowledgeMediaDirRemoval,
}: GeneralSectionProps) {
  const isBinary = !!config.general.is_binary;
  const canEditMediaDirs = !config.general.is_docker;

  const handleEnablePeopleToggle = (value: boolean) => {
    let infoMessage: string | null = null;
    onChange((prev) => {
      let next = {
        ...prev,
        general: { ...prev.general, enable_people: value },
      };
      if (!value && prev.processors.face_processor_active) {
        infoMessage =
          "由于人物功能已关闭，人脸处理器已禁用。";
        next = {
          ...next,
          processors: { ...prev.processors, face_processor_active: false },
        };
      }
      return next;
    });
    if (infoMessage) {
      showSnackbar(infoMessage, "info");
    }
  };

  return (
    <Grid container spacing={2}>
      <Grid size={{ xs: 12 }}><CacheLocationNote /></Grid>
      {!isBinary && (
        <>
          <Grid size={{ xs: 12, sm: 6 }}>
            <TextField
              label="端口"
              value={config.general.port}
              onChange={(e) =>
                onValueChange("general", "port", parseInt(e.target.value))
              }
              fullWidth
              margin="normal"
              type="number"
              helperText="API/UI 服务器的 HTTP 端口（手动运行时需要重启）"
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 6 }}>
            <TextField
              label="域名"
              value={config.general.domain}
              onChange={(e) =>
                onValueChange("general", "domain", e.target.value)
              }
              fullWidth
              margin="normal"
              helperText="用于生成链接和 API 调用的基础 URL"
            />
          </Grid>
        </>
      )}
      {canEditMediaDirs && (
        <MediaDirectoriesSection
          config={config}
          onChange={onChange}
          onAcknowledgeRemoval={onAcknowledgeMediaDirRemoval}
        />
      )}
      <Grid size={{ xs: 12 }}>
        <FormGroup>
          <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
            {" 只读（展示模式） "}</Typography>
          <Typography variant="body2" sx={{ ml: 0, mb: 1 }}>
            {" 仅通过 Docker 运行环境管理（例如 "}<code style={{ marginLeft: 4 }}>
              {" -e OMOIDE_GENERAL__PRESENTATION_MODE=true "}</code>
            {" ）。当前："}{" "}
            {config.general.presentation_mode ? "已启用" : "已禁用"}.
          </Typography>
          <SwitchSetting
            label="启用人物"
            checked={config.general.enable_people}
            onChange={handleEnablePeopleToggle}
            description="启用人脸检测、识别和人物自动归类功能。"
          />
          <SwitchSetting
            label="梗图模式"
            checked={config.general.meme_mode}
            onChange={(checked) =>
              onValueChange("general", "meme_mode", checked)
            }
            description="通过加载原始文件在网格中显示动画 GIF。"
          />
        </FormGroup>
      </Grid>
      <Grid size={{ xs: 12, sm: 6 }}>
        <TextField
          label="每个文件夹的缩略图数量"
          value={config.general.thumb_dir_folder_size}
          onChange={(e) =>
            onValueChange(
              "general",
              "thumb_dir_folder_size",
              parseInt(e.target.value)
            )
          }
          fullWidth
          margin="normal"
          type="number"
          helperText="每个子文件夹的最大缩略图数量（针对文件系统 inode 限制进行调整）"
        />
      </Grid>
      <Grid size={{ xs: 12, sm: 6 }}>
        <TextField
          label="关系图节点上限"
          value={config.general.person_relationship_max_nodes}
          onChange={(e) => {
            const parsed = parseInt(e.target.value, 10);
            const sanitized = Number.isFinite(parsed) ? Math.max(1, parsed) : 1;
            onValueChange("general", "person_relationship_max_nodes", sanitized);
          }}
          fullWidth
          margin="normal"
          type="number"
          helperText="渲染关系图时加载的最大人物数量"
        />
      </Grid>
    </Grid>
  );
}
