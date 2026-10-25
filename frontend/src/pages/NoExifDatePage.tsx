import EventBusyIcon from "@mui/icons-material/EventBusy";

import { ReviewPage } from "../components/ReviewPage";
import { formatBytes } from "../formatUtils";
import { ReviewMediaItem } from "../types";

export default function NoExifDatePage() {
  return (
    <ReviewPage<ReviewMediaItem>
      endpoint="/api/noexifdate"
      title="无 EXIF 日期"
      description="EXIF 元数据中没有拍摄时间戳的媒体。这些通常是截图、下载的图片、WhatsApp 转发的内容或元数据被剥离的文件。它们会在时间线视图中出现在错误的位置。"
      statsText={(total) =>
        `${total.toLocaleString()} item${total !== 1 ? "s" : ""} without EXIF date`
      }
      emptyIcon={<EventBusyIcon />}
      emptyText={() => "所有媒体的 EXIF 元数据中都有拍摄日期。"}
      badge={(item) => (item.duration != null ? { label: "视频" } : undefined)}
      caption={(item) =>
        `${formatBytes(item.size)}${
          item.width && item.height ? ` · ${item.width}×${item.height}` : ""
        }`
      }
    />
  );
}
