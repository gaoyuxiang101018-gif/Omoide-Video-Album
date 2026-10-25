import {
  FormControl,
  FormHelperText,
  Grid,
  InputLabel,
  MenuItem,
  Select,
} from "@mui/material";
import { AppConfig } from "../../types";
import { ConfigSectionProps } from "./shared";

export default function DuplicatesSection({
  config,
  onValueChange,
}: ConfigSectionProps) {
  return (
    <Grid container spacing={2}>
      <Grid size={{ xs: 12, sm: 6 }}>
        <FormControl fullWidth margin="normal">
          <InputLabel id="dup-auto-handling-label">{"自动处理"}</InputLabel>
          <Select
            labelId="dup-auto-handling-label"
            value={config.duplicates.duplicate_auto_handling}
            label="自动处理"
            onChange={(e) =>
              onValueChange(
                "duplicates",
                "duplicate_auto_handling",
                e.target
                  .value as AppConfig["duplicates"]["duplicate_auto_handling"]
              )
            }
          >
            <MenuItem value="keep">{"保留（不自动执行任何操作）"}</MenuItem>
            <MenuItem value="remove">
              {" 移除（解决冲突而不删除文件） "}</MenuItem>
            <MenuItem value="blacklist">{"将重复项加入黑名单"}</MenuItem>
            <MenuItem value="delete">{"删除重复项"}</MenuItem>
          </Select>
          <FormHelperText>
            {" 发现重复项时自动执行的操作。“保留”是最安全的默认值。 "}</FormHelperText>
        </FormControl>
      </Grid>
      <Grid size={{ xs: 12, sm: 6 }}>
        <FormControl fullWidth margin="normal">
          <InputLabel id="dup-keep-rule-label">{"自动保留规则"}</InputLabel>
          <Select
            labelId="dup-keep-rule-label"
            value={config.duplicates.duplicate_auto_keep_rule}
            label="自动保留规则"
            onChange={(e) =>
              onValueChange(
                "duplicates",
                "duplicate_auto_keep_rule",
                e.target
                  .value as AppConfig["duplicates"]["duplicate_auto_keep_rule"]
              )
            }
          >
            <MenuItem value="biggest">{"文件大小最大"}</MenuItem>
            <MenuItem value="smallest">{"文件大小最小"}</MenuItem>
            <MenuItem value="highest_res">{"分辨率最高"}</MenuItem>
            <MenuItem value="lowest_res">{"分辨率最低"}</MenuItem>
            <MenuItem value="oldest">{"文件日期最早"}</MenuItem>
            <MenuItem value="newest">{"文件日期最新"}</MenuItem>
          </Select>
          <FormHelperText>
            {" 启用自动处理重复项时保留哪个文件。 "}</FormHelperText>
        </FormControl>
      </Grid>
    </Grid>
  );
}
