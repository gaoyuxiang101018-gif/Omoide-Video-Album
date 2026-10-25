import {
  Alert,
  Box,
  FormControl,
  FormControlLabel,
  FormHelperText,
  Grid,
  InputLabel,
  MenuItem,
  Select,
  Switch,
  Tab,
  Tabs,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { AppConfig } from "../../types";
import {
  FacePresetKey,
  facePresetDescriptions,
  facePresets,
} from "./facePresets";
import { ConfigSectionProps, ConfigUpdate } from "./shared";

export type FaceSettingsMode = "presets" | "manual";

type FaceConfig = AppConfig["face_recognition"];
type NumericFaceKey = {
  [K in keyof FaceConfig]: FaceConfig[K] extends number ? K : never;
}[keyof FaceConfig];

interface NumericFieldDef {
  key: NumericFaceKey;
  label: string;
  helperText: string;
  parse: (raw: string) => number;
  inputProps?: { step?: number; min?: number; max?: number };
}

const float = (raw: string) => parseFloat(raw);
const int = (raw: string) => parseInt(raw, 10);

const DETECTION_FIELDS: NumericFieldDef[] = [
  {
    key: "face_recognition_min_confidence",
    label: "最小置信度",
    parse: float,
    helperText:
      "值越低 = 检测更多人脸（包括低质量），值越高 = 越严格",
  },
  {
    key: "existing_person_cosine_threshold",
    label: "已存在人物的余弦阈值",
    parse: float,
    helperText:
      "附加到已建立的人物时使用更严格的阈值",
  },
  {
    key: "existing_person_min_cosine_margin",
    label: "已存在人物的最小余弦差距",
    parse: float,
    inputProps: { step: 0.01 },
    helperText:
      "要求最佳匹配与次佳匹配之间存在差距，以避免歧义",
  },
  {
    key: "rerun_face_iou_dedupe_threshold",
    label: "重新运行人脸 IoU 去重阈值",
    parse: float,
    inputProps: { step: 0.01, min: 0, max: 1 },
    helperText:
      "重新运行人脸时，跳过与现有脸重叠超过此 IoU 的检测结果",
  },
  {
    key: "face_recognition_min_face_pixels",
    label: "最小人脸像素",
    parse: int,
    helperText: "可检测到的最小人脸面积（像素）",
  },
];

const SHARPNESS_FIELD: NumericFieldDef = {
  key: "face_sharpness_min_variance",
  label: "清晰度最小方差",
  parse: float,
  inputProps: { step: 1, min: 0 },
  helperText:
    "拉普拉斯方差阈值 — 值越低 = 接受更多模糊（可尝试 20–40）",
};

const PERSON_FIELDS: NumericFieldDef[] = [
  {
    key: "person_min_face_count",
    label: "每个人物的最小人脸数",
    parse: int,
    helperText: "自动创建新人物所需的人脸数量",
  },
  {
    key: "person_min_media_count",
    label: "每个人物的最小媒体数",
    parse: int,
    helperText:
      "集群成为人物前所需的不同媒体项目数量",
  },
  {
    key: "person_merge_search_k",
    label: "合并搜索候选",
    parse: int,
    helperText:
      "归类时与多少个已知人物进行比较以合并已知人物",
  },
  {
    key: "person_cluster_max_l2_radius",
    label: "人物集群最大 L2 半径",
    parse: float,
    inputProps: { step: 0.01 },
    helperText:
      "形成新人物时，围绕中心点允许的最大 L2 距离",
  },
  {
    key: "person_merge_percent_similarity",
    label: "人物合并相似度百分比阈值",
    parse: int,
    inputProps: { step: 1, min: 0, max: 100 },
    helperText:
      "归类后，当两个人物相似度百分比超过此阈值时合并",
  },
  {
    key: "cluster_batch_size",
    label: "归类批处理大小",
    parse: int,
    helperText: "每批处理的人脸数量（内存 vs. 速度）",
  },
];

/** Chinese Whispers settings (only shown for the binary build). */
const CHINESE_WHISPERS_FIELDS: NumericFieldDef[] = [
  {
    key: "cw_threshold",
    label: "Chinese Whispers 阈值",
    parse: float,
    helperText: "向量距离的阈值。值越小 = 匹配越严格",
  },
  {
    key: "cw_iterations",
    label: "Chinese Whispers 迭代次数",
    parse: int,
    helperText: "归类迭代次数。通常 20 次应足够。",
  },
  {
    key: "cw_k_neighbors",
    label: "Chinese Whispers K 最近邻",
    parse: int,
    helperText: "归类图的 K 最近邻。",
  },
];

/** HDBSCAN settings (only shown in Docker). The selection-method Select sits between these. */
const HDBSCAN_FIELDS: NumericFieldDef[] = [
  {
    key: "hdbscan_min_cluster_size",
    label: "HDBSCAN 最小集群大小",
    parse: int,
    helperText:
      "形成集群所需的最小人脸数；值越大合并更多集群（减少小身份）",
  },
  {
    key: "hdbscan_min_samples",
    label: "HDBSCAN 最小样本数",
    parse: int,
    helperText:
      "值越高 = 越保守（更多点被标记为噪声/异常值）",
  },
];

const HDBSCAN_EPSILON_FIELD: NumericFieldDef = {
  key: "hdbscan_cluster_selection_epsilon",
  label: "HDBSCAN 选择 Epsilon",
  parse: float,
  inputProps: { step: 0.01 },
  helperText:
    "额外分裂灵敏度；值越大产生更多、更小的集群",
};

interface FaceRecognitionSectionProps extends ConfigSectionProps {
  onChange: ConfigUpdate;
  /** Lifted to the page so the chosen sub-tab survives switching tabs. */
  mode: FaceSettingsMode;
  onModeChange: (mode: FaceSettingsMode) => void;
}

export default function FaceRecognitionSection({
  config,
  onValueChange,
  onChange,
  mode,
  onModeChange,
}: FaceRecognitionSectionProps) {
  const face = config.face_recognition;
  const activeFacePreset =
    face.preset === "custom" ? null : (face.preset as FacePresetKey);

  const applyFacePreset = (preset: FacePresetKey) => {
    onChange((prev) => ({
      ...prev,
      face_recognition: {
        ...prev.face_recognition,
        ...facePresets[preset],
        preset,
      },
    }));
    onModeChange("presets");
  };

  const setFaceValue = <K extends keyof FaceConfig>(
    key: K,
    value: FaceConfig[K]
  ) => {
    onChange((prev) => {
      if (
        typeof value === "number" &&
        (Number.isNaN(value) || value === Infinity || value === -Infinity)
      ) {
        return prev;
      }
      const nextFace = {
        ...prev.face_recognition,
        [key]: value,
      };
      if (key !== "preset") {
        nextFace.preset = "custom";
      }
      return { ...prev, face_recognition: nextFace };
    });
    if (key !== "preset") {
      onModeChange("manual");
    }
  };

  const renderNumericField = (field: NumericFieldDef) => (
    <Grid key={field.key} size={{ xs: 12, sm: 6 }}>
      <TextField
        label={field.label}
        value={face[field.key]}
        onChange={(e) => setFaceValue(field.key, field.parse(e.target.value))}
        fullWidth
        margin="normal"
        type="number"
        inputProps={field.inputProps}
        helperText={field.helperText}
      />
    </Grid>
  );

  return (
    <Box>
      <FormControl fullWidth margin="normal" sx={{ mt: 0, mb: 3 }}>
        <InputLabel id="face-detection-model-label">
          {" 人脸检测模型 "}</InputLabel>
        <Select
          labelId="face-detection-model-label"
          value={face.face_detection_model}
          label="人脸检测模型"
          onChange={(e) =>
            onValueChange(
              "face_recognition",
              "face_detection_model",
              e.target.value as FaceConfig["face_detection_model"]
            )
          }
        >
          <MenuItem value="buffalo_l">{"精确（buffalo_l）"}</MenuItem>
          <MenuItem value="buffalo_s">{"快速（buffalo_s）"}</MenuItem>
        </Select>
        <FormHelperText>
          {" 快速检测器发现人脸的速度约快 4 倍，但会遗漏更多小或部分隐藏的人脸。两者识别效果相同，因此现有的人物不受影响。 "}</FormHelperText>
      </FormControl>
      <Box sx={{ borderBottom: 1, borderColor: "divider", mb: 3 }}>
        <Tabs
          value={mode}
          onChange={(_, value: FaceSettingsMode) => onModeChange(value)}
          aria-label="人脸识别配置模式"
        >
          <Tab label="预设" value="presets" />
          <Tab label="手动" value="manual" />
        </Tabs>
      </Box>
      {mode === "presets" ? (
        <Box>
          <ToggleButtonGroup
            exclusive
            color="primary"
            value={activeFacePreset}
            onChange={(_, next: FacePresetKey | null) => {
              if (next) {
                applyFacePreset(next);
              }
            }}
            aria-label="人脸识别预设"
            sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}
          >
            <ToggleButton value="strict">{"严格"}</ToggleButton>
            <ToggleButton value="normal">{"正常"}</ToggleButton>
            <ToggleButton value="loose">{"宽松"}</ToggleButton>
          </ToggleButtonGroup>
          {face.preset === "custom" && (
            <Alert severity="info" sx={{ mt: 2 }}>
              {" 您当前正在使用自定义值。切换到手动以查看它们，或选择上方的预设以恢复默认值。 "}</Alert>
          )}
          {activeFacePreset && (
            <Typography variant="body2" sx={{ mt: 2 }}>
              {facePresetDescriptions[activeFacePreset]}
            </Typography>
          )}
          <Typography variant="caption" sx={{ mt: 2, display: "block" }}>
            {" 预设会同时调整检测严格度、人物分配和归类阈值。 "}</Typography>
        </Box>
      ) : (
        <Box>
          <Alert severity="warning" sx={{ mb: 2 }}>
            {" 更改任何字段都会将预设切换为自定义。 "}</Alert>
          <Grid container spacing={2}>
            {DETECTION_FIELDS.map(renderNumericField)}
            <Grid size={{ xs: 12 }}>
              <FormControlLabel
                control={
                  <Switch
                    checked={face.face_sharpness_filter_enabled}
                    onChange={(e) =>
                      setFaceValue(
                        "face_sharpness_filter_enabled",
                        e.target.checked
                      )
                    }
                  />
                }
                label="清晰度过滤"
              />
              <Typography variant="caption" display="block" color="text.secondary">
                {" 在嵌入之前跳过模糊或失焦的人脸裁剪。禁用后可检测柔焦照片（例如婴儿特写）中的人脸。 "}</Typography>
            </Grid>
            {face.face_sharpness_filter_enabled &&
              renderNumericField(SHARPNESS_FIELD)}
            {PERSON_FIELDS.map(renderNumericField)}
            {config.general.is_binary &&
              CHINESE_WHISPERS_FIELDS.map(renderNumericField)}
            {config.general.is_docker && (
              <>
                {HDBSCAN_FIELDS.map(renderNumericField)}
                <Grid size={{ xs: 12, sm: 6 }}>
                  <FormControl fullWidth margin="normal">
                    <InputLabel id="hdbscan-method-manual-label">
                      {" HDBSCAN 集群选择方法 "}</InputLabel>
                    <Select
                      labelId="hdbscan-method-manual-label"
                      value={face.hdbscan_cluster_selection_method}
                      label="HDBSCAN 集群选择方法"
                      onChange={(e) =>
                        setFaceValue(
                          "hdbscan_cluster_selection_method",
                          e.target.value as string
                        )
                      }
                    >
                      <MenuItem value="leaf">
                        {" leaf（更细、更精细的聚类） "}</MenuItem>
                      <MenuItem value="eom">
                        {" eom（更稳定、拆分更少） "}</MenuItem>
                    </Select>
                    <FormHelperText>
                      {" 控制聚类粒度；\"leaf\"会产生更细的划分。 "}</FormHelperText>
                  </FormControl>
                </Grid>
                {renderNumericField(HDBSCAN_EPSILON_FIELD)}
              </>
            )}
          </Grid>
        </Box>
      )}
    </Box>
  );
}
