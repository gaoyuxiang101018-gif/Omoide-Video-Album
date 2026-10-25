import LabelOffIcon from "@mui/icons-material/LabelOff";

import { ReviewPage } from "../components/ReviewPage";
import { formatBytes } from "../formatUtils";
import { ReviewMediaItem } from "../types";

export default function UntaggedPage() {
  return (
    <ReviewPage<ReviewMediaItem>
      endpoint="/api/untagged"
      title="未标记媒体"
      description="未分配任何标签的媒体文件。使用此视图识别仍需分类的项目。单击任意缩略图以打开完整媒体文件视图并添加标签。"
      statsText={(total) =>
        `${total.toLocaleString()} untagged item${total !== 1 ? "s" : ""}`
      }
      emptyIcon={<LabelOffIcon />}
      emptyText={() => "所有媒体文件都至少分配了一个标签。"}
      badge={(item) => (item.duration != null ? { label: "视频" } : undefined)}
      caption={(item) => formatBytes(item.size)}
    />
  );
}
