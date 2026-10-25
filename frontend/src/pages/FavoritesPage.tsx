import React from "react";
import MediaListPage from "../components/MediaListPage";
import { getFavorites } from "../services/media";

export default function FavoritesPage() {
  return (
    <MediaListPage
      listKeyPrefix="favorites"
      fetcher={getFavorites}
      emptyTitle="还没有收藏"
      emptyDescription="点击照片或视频上的爱心，即可加入收藏。"
    />
  );
}
