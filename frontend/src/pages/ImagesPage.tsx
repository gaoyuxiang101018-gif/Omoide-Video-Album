import React from "react";
import MediaListPage from "../components/MediaListPage";
import { getImages } from "../services/media";

export default function ImagesPage() {
  return (
    <MediaListPage
      listKeyPrefix="images"
      fetcher={getImages}
      emptyTitle="还没有照片"
      emptyDescription="添加文件夹并扫描后，照片会显示在这里。"
    />
  );
}
