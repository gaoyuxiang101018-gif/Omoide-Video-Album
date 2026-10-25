import { withMediaCacheScope } from "../urlUtils";
import React, { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardActionArea,
  CardContent,
  CircularProgress,
  Container,
  Snackbar,
  Typography,
} from "@mui/material";
import PublicIcon from "@mui/icons-material/Public";
import TravelExploreIcon from "@mui/icons-material/TravelExplore";
import { Link } from "react-router-dom";
import config, { API } from "../config";
import { encodeFilePath } from "../urlUtils";
import { EmptyState } from "../components/EmptyState";
import { getPlaces, startGeocodePlaces } from "../services/features";
import { useTaskCompletionVersion } from "../TaskEventsContext";
import { PlaceCountry } from "../types";

export default function PlacesPage() {
  const [places, setPlaces] = useState<PlaceCountry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [snackbar, setSnackbar] = useState("");
  const refreshKey = useTaskCompletionVersion(["geocode_places"]);

  useEffect(() => {
    setIsLoading(true);
    getPlaces()
      .then(setPlaces)
      .catch((err) =>
        setError(err instanceof Error ? err.message : "加载位置失败")
      )
      .finally(() => setIsLoading(false));
  }, [refreshKey]);

  const handleGeocode = async () => {
    try {
      await startGeocodePlaces();
      setSnackbar("地理编码已开始 — 完成后此页面将刷新。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "启动任务失败");
    }
  };

  return (
    <Container maxWidth="xl" sx={{ minHeight: "100vh", py: 4 }}>
      <Box
        display="flex"
        justifyContent="space-between"
        alignItems="center"
        flexWrap="wrap"
        gap={1}
        mb={3}
      >
        <Box display="flex" alignItems="center" gap={1}>
          <PublicIcon color="primary" />
          <Typography variant="h5" fontWeight={700}>
            {" 地点 "}</Typography>
        </Box>
        {!config.PRESENTATION_MODE && (
          <Button
            variant="outlined"
            startIcon={<TravelExploreIcon />}
            onClick={handleGeocode}
          >
            {" 对新媒体进行地理编码 "}</Button>
        )}
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {isLoading ? (
        <Box textAlign="center" py={6}>
          <CircularProgress />
        </Box>
      ) : places.length === 0 ? (
        <EmptyState
          icon={<PublicIcon />}
          title="暂无位置"
          description={
            config.PRESENTATION_MODE
              ? undefined
              : "运行“对新媒体进行地理编码”，将 GPS 数据转换为可浏览的城市和国家（离线）。"
          }
        />
      ) : (
        places.map((country) => (
          <Box key={country.country} mb={4}>
            <Typography variant="subtitle1" fontWeight={700} mb={1.5}>
              {country.country} · {country.count.toLocaleString()} {" 项 "}</Typography>
            <Box
              sx={{
                display: "grid",
                gap: 2,
                gridTemplateColumns: {
                  xs: "repeat(2, 1fr)",
                  sm: "repeat(3, 1fr)",
                  md: "repeat(4, 1fr)",
                  lg: "repeat(6, 1fr)",
                },
              }}
            >
              {country.cities.map((city) => (
                <Card key={city.city} sx={{ borderRadius: 3 }}>
                  <CardActionArea
                    component={Link}
                    to={`/places/media?city=${encodeURIComponent(
                      city.city
                    )}&country=${encodeURIComponent(country.country)}`}
                  >
                    <Box
                      sx={{
                        aspectRatio: "1/1",
                        bgcolor: "action.hover",
                        overflow: "hidden",
                      }}
                    >
                      {city.cover_thumbnail && (
                        <Box
                          component="img"
                          src={withMediaCacheScope(`${API}/thumbnails/${encodeFilePath(
                            city.cover_thumbnail
                          )}`)}
                          alt={city.city}
                          loading="lazy"
                          sx={{
                            width: "100%",
                            height: "100%",
                            objectFit: "cover",
                          }}
                        />
                      )}
                    </Box>
                    <CardContent sx={{ py: 1 }}>
                      <Typography variant="subtitle2" fontWeight={700} noWrap>
                        {city.city}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {city.count.toLocaleString()} {" 个项目 "}{city.count === 1 ? "" : ""}
                      </Typography>
                    </CardContent>
                  </CardActionArea>
                </Card>
              ))}
            </Box>
          </Box>
        ))
      )}

      <Snackbar
        open={!!snackbar}
        autoHideDuration={4000}
        onClose={() => setSnackbar("")}
        message={snackbar}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      />
    </Container>
  );
}
