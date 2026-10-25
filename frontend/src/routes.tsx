import React, { Suspense, lazy } from "react";
import { Routes, Route, useLocation } from "react-router-dom";
import { Box, CircularProgress } from "@mui/material";
import IndexPage from "./pages/IndexPage";
import { Layout } from "./components/Layout";
import { WriteModeBoundary } from "./components/ReadOnlyBoundary";
import { MaintenanceShell } from "./components/MaintenanceShell";

const MediaDetailPage = lazy(() => import("./pages/MediaDetailPage"));
const TagDetailPage = lazy(() => import("./pages/TagDetailPage"));
const ImagesPage = lazy(() => import("./pages/ImagesPage"));
const VideosPage = lazy(() => import("./pages/VideoLibraryPage"));
const FilmPage = lazy(() => import("./pages/FilmPage"));
const RecognitionProgressPage = lazy(() => import("./pages/RecognitionProgressPage"));
const FavoritesPage = lazy(() => import("./pages/FavoritesPage"));
const PeoplePage = lazy(() => import("./pages/PeopleFinderPage"));
const FirstSeenPeoplePage = lazy(() => import("./pages/FirstSeenPeoplePage"));
const MergeHistoryPage = lazy(() => import("./pages/MergeHistoryPage"));
const FaceReviewPage = lazy(() => import('./pages/FaceReviewPage'));
const RecognitionParametersPage = lazy(() => import('./pages/RecognitionParametersPage'));
const PeopleManagePage = lazy(() => import("./pages/PeoplePage"));
const TagsPage = lazy(() => import("./pages/TagPage"));
const SearchPage = lazy(() => import("./pages/SearchResultPage"));
const BlurryPage = lazy(() => import("./pages/BlurryPage"));
const DuplicatesPage = lazy(() => import("./pages/DuplicatesPage"));
const MissingFilesPage = lazy(() => import("./pages/MissingFilesPage"));
const NopersonsPage = lazy(() => import("./pages/NopersonsPage"));
const UntaggedPage = lazy(() => import("./pages/UntaggedPage"));
const ShortVideosPage = lazy(() => import("./pages/ShortVideosPage"));
const LowResolutionPage = lazy(() => import("./pages/LowResolutionPage"));
const NoExifDatePage = lazy(() => import("./pages/NoExifDatePage"));
const BrokenMediaPage = lazy(() => import("./pages/BrokenMediaPage"));
const PersonDetailPage = lazy(() => import("./pages/PersonDetailPage"));
const MapPage = lazy(() => import("./pages/MapPage"));
const MapEditorPage = lazy(() => import("./pages/MapEditorPage"));
const ConfigurationPage = lazy(() => import("./pages/ConfigurationPage"));
const OrphanFacesPage = lazy(() => import("./pages/OrphanFaces"));
const HighlightsPage = lazy(() => import("./pages/HighlightsPage"));
const StatisticsPage = lazy(() => import("./pages/StatisticsPage"));
const AlbumsPage = lazy(() => import("./pages/AlbumsPage"));
const AlbumDetailPage = lazy(() => import("./pages/AlbumDetailPage"));
const EventsPage = lazy(() => import("./pages/EventsPage"));
const EventDetailPage = lazy(() => import("./pages/EventDetailPage"));
const PlacesPage = lazy(() => import("./pages/PlacesPage"));
const PlaceMediaPage = lazy(() => import("./pages/PlaceMediaPage"));

const RouteFallback = () => (
  <Box
    sx={{
      display: "flex",
      justifyContent: "center",
      alignItems: "center",
      minHeight: "50vh",
    }}
  >
    <CircularProgress />
  </Box>
);

export const AppRoutes = () => {
  const location = useLocation();
  const backgroundLocation = location.state?.backgroundLocation;

  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes location={backgroundLocation || location}>
        <Route path="/" element={<Layout />}>
          <Route index element={<PeoplePage />} />
          <Route path="/overview" element={<IndexPage />} />
          <Route path="/searchresults" element={<SearchPage />} />
          <Route path="/medium/:id" element={<MediaDetailPage />} />
          <Route path="/images" element={<ImagesPage />} />
          <Route path="/map" element={<MapPage />} />
          <Route
            path="/geotagger"
            element={
              <WriteModeBoundary description="系统处于只读模式时，地理标记工具已禁用。">
                <MapEditorPage />
              </WriteModeBoundary>
            }
          />
          <Route path="/tags" element={<TagsPage />} />
          <Route
            path="/orphanfaces"
            element={
              <WriteModeBoundary description="系统处于只读模式时，人脸分配工具已禁用。">
                <OrphanFacesPage />
              </WriteModeBoundary>
            }
          />
          <Route path="/videos" element={<VideosPage />} />
          <Route path="/recognition-progress" element={<RecognitionProgressPage />} />
          <Route path="/film" element={<WriteModeBoundary description="系统处于只读模式时，还原导出已禁用。"><FilmPage /></WriteModeBoundary>} />
          <Route path="/favorites" element={<FavoritesPage />} />
          <Route path="/people" element={<PeoplePage />} />
          <Route path="/first-appearance" element={<FirstSeenPeoplePage />} />
          <Route path="/merge-history" element={<WriteModeBoundary><MergeHistoryPage /></WriteModeBoundary>} />
          <Route path="/face-review" element={<WriteModeBoundary><FaceReviewPage/></WriteModeBoundary>}/>
          <Route path="/recognition-parameters" element={<RecognitionParametersPage/>}/>
          <Route path="/people/manage" element={<PeopleManagePage />} />
          <Route path="/person/:id" element={<PersonDetailPage />} />
          <Route path="/tag/:id" element={<TagDetailPage />} />
          <Route path="/highlights" element={<HighlightsPage />} />
          <Route path="/statistics" element={<StatisticsPage />} />
          <Route path="/albums" element={<AlbumsPage />} />
          <Route path="/album/:id" element={<AlbumDetailPage />} />
          <Route path="/events" element={<EventsPage />} />
          <Route path="/event/:id" element={<EventDetailPage />} />
          <Route path="/places" element={<PlacesPage />} />
          <Route path="/places/media" element={<PlaceMediaPage />} />
          <Route
            path="/blur"
            element={
              <MaintenanceShell>
                <WriteModeBoundary description="系统处于只读模式时，模糊图像审查已禁用。">
                  <BlurryPage />
                </WriteModeBoundary>
              </MaintenanceShell>
            }
          />
          <Route
            path="/duplicates"
            element={
              <MaintenanceShell>
                <WriteModeBoundary description="系统处于只读模式时，重复项审查操作已禁用。">
                  <DuplicatesPage />
                </WriteModeBoundary>
              </MaintenanceShell>
            }
          />
          <Route
            path="/configuration"
            element={
              <WriteModeBoundary description="系统处于只读模式时，无法查看或编辑配置设置。">
                <ConfigurationPage />
              </WriteModeBoundary>
            }
          />
          <Route
            path="/missing"
            element={
              <MaintenanceShell>
                <WriteModeBoundary description="系统处于只读模式时，缺失文件审查已禁用。">
                  <MissingFilesPage />
                </WriteModeBoundary>
              </MaintenanceShell>
            }
          />
          <Route
            path="/nopersons"
            element={
              <WriteModeBoundary description="系统处于只读模式时，无人物审查已禁用。">
                <NopersonsPage />
              </WriteModeBoundary>
            }
          />
          <Route
            path="/untagged"
            element={
              <MaintenanceShell>
                <WriteModeBoundary description="系统处于只读模式时，未标记媒体文件审查已禁用。">
                  <UntaggedPage />
                </WriteModeBoundary>
              </MaintenanceShell>
            }
          />
          <Route
            path="/shortvideos"
            element={
              <MaintenanceShell>
                <WriteModeBoundary description="系统处于只读模式时，短视频审查已禁用。">
                  <ShortVideosPage />
                </WriteModeBoundary>
              </MaintenanceShell>
            }
          />
          <Route
            path="/lowresolution"
            element={
              <MaintenanceShell>
                <WriteModeBoundary description="系统处于只读模式时，低分辨率媒体文件审查已禁用。">
                  <LowResolutionPage />
                </WriteModeBoundary>
              </MaintenanceShell>
            }
          />
          <Route
            path="/noexifdate"
            element={
              <MaintenanceShell>
                <WriteModeBoundary description="系统处于只读模式时，无EXIF日期审查已禁用。">
                  <NoExifDatePage />
                </WriteModeBoundary>
              </MaintenanceShell>
            }
          />
          <Route
            path="/broken"
            element={
              <MaintenanceShell>
                <WriteModeBoundary description="系统处于只读模式时，损坏媒体文件审查已禁用。">
                  <BrokenMediaPage />
                </WriteModeBoundary>
              </MaintenanceShell>
            }
          />
        </Route>
      </Routes>
      {backgroundLocation && (
        <Routes>
          <Route path="/medium/:id" element={<MediaDetailPage />} />
        </Routes>
      )}
    </Suspense>
  );
};
