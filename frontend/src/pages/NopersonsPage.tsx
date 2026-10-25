import { useMemo, useState } from "react";
import { FormControl, InputLabel, MenuItem, Select } from "@mui/material";
import PersonOffIcon from "@mui/icons-material/PersonOff";

import { ReviewPage } from "../components/ReviewPage";
import { formatBytes } from "../formatUtils";
import { NoPersonsMediaItem } from "../types";

type Scope = "processed" | "all";

export default function NopersonsPage() {
  const [scope, setScope] = useState<Scope>("processed");
  const filters = useMemo(() => ({ scope }), [scope]);

  return (
    <ReviewPage<NoPersonsMediaItem>
      endpoint="/api/nopersons"
      title="未检测到人物"
      description={
        <>
          {" 已运行人脸检测但未识别出任何人的媒体。使用此视图审核并整理未识别的内容，或切换到"}{" "}
          <strong>{"所有未关联"}</strong> {" 以查看所有未关联任何人的项目，无论处理状态如何。点击任意缩略图可打开完整媒体视图。 "}</>
      }
      filters={filters}
      controls={
        <FormControl size="small" sx={{ minWidth: 200 }}>
          <InputLabel id="nopersons-scope">{"范围"}</InputLabel>
          <Select
            labelId="nopersons-scope"
            label="范围"
            value={scope}
            onChange={(e) => setScope(e.target.value as Scope)}
          >
            <MenuItem value="processed">{"已处理 — 未找到人物"}</MenuItem>
            <MenuItem value="all">{"所有未关联任何人的项"}</MenuItem>
          </Select>
        </FormControl>
      }
      rerunProcessors
      refreshOn={["process_media", "cluster_persons", "run_processor_for_media"]}
      statsText={(total) => `${total.toLocaleString()} item${total !== 1 ? "s" : ""}`}
      emptyIcon={<PersonOffIcon />}
      emptyText={() =>
        scope === "processed"
          ? "没有已处理但未包含人物的媒体。运行人脸检测以填充此视图。"
          : "所有媒体都至少关联了一个人物。"
      }
      badge={(item) => (item.duration != null ? { label: "视频" } : undefined)}
      caption={(item) => formatBytes(item.size)}
    />
  );
}
