import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Divider,
  FormHelperText,
  Grid,
  IconButton,
  List,
  ListItem,
  ListItemIcon,
  ListItemSecondaryAction,
  ListItemText,
  Paper,
  Radio,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/Delete";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import { ProfilesController } from "./useProfiles";

interface ProfilesSectionProps {
  isDocker: boolean;
  profilesCtl: ProfilesController;
}

export default function ProfilesSection({
  isDocker,
  profilesCtl,
}: ProfilesSectionProps) {
  const {
    profiles,
    profileError,
    profileHealth,
    hasActiveTasks,
    selectedProfilePath,
    setSelectedProfilePath,
    isSwitchingProfile,
    creatingProfile,
    newProfileName,
    setNewProfileName,
    newProfilePath,
    setNewProfilePath,
  } = profilesCtl;

  return (
    <Grid container spacing={2}>
      {isDocker ? (
        <Grid size={{ xs: 12 }}>
          <Alert severity="info">
            {" 此环境中无法使用资料库。 "}</Alert>
        </Grid>
      ) : profileError ? (
        <Grid size={{ xs: 12 }}>
          <Alert severity="error">{profileError}</Alert>
        </Grid>
      ) : profiles ? (
        <>
          {/* Active profile card */}
          <Grid size={{ xs: 12 }}>
            <Paper variant="outlined" sx={{ p: 2 }}>
              <Typography variant="h6" sx={{ mb: 1 }}>
                {" 当前资料库 "}</Typography>
              <Typography
                variant="body2"
                sx={{ color: "text.secondary", fontFamily: "monospace" }}
              >
                {profiles.active_path}
              </Typography>
              {profileHealth &&
                (!profileHealth.active_exists || !profileHealth.has_db) && (
                  <Alert severity="warning" sx={{ mt: 2 }}>
                    {" 当前资料库似乎缺失或为空。如果您移动了它，请选择新位置并点击保存以重新关联。 "}<Button
                      size="small"
                      sx={{ ml: 2 }}
                      variant="outlined"
                      onClick={profilesCtl.pickRelocatePath}
                    >
                      {" 选择目录… "}</Button>
                  </Alert>
                )}
            </Paper>
          </Grid>

          {hasActiveTasks && (
            <Grid size={{ xs: 12 }}>
              <Alert severity="warning">
                {" 处理正在进行中。任务完成前资料库操作已禁用。 "}</Alert>
            </Grid>
          )}

          {/* Two-column layout: list on left, create on right */}
          <Grid size={{ xs: 12, md: 7 }}>
            <Paper variant="outlined" sx={{ p: 2 }}>
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  mb: 1,
                }}
              >
                <Typography variant="h6">{"所有资料库"}</Typography>
                <Button
                  size="small"
                  variant="outlined"
                  onClick={profilesCtl.addExisting}
                  disabled={hasActiveTasks}
                >
                  {" 添加现有… "}</Button>
              </Box>
              <Divider />
              <List dense sx={{ mt: 1 }}>
                {(profiles.profiles ?? []).map((p) => (
                  <ListItem key={p.path} disableGutters>
                    <ListItemIcon>
                      <Radio
                        edge="start"
                        checked={selectedProfilePath === p.path}
                        onChange={() => setSelectedProfilePath(p.path)}
                        disabled={hasActiveTasks || isSwitchingProfile}
                        inputProps={{ "aria-label": ("选择资料库 {0}".replace(/\{(\d+)\}/g, (_, i) => String([p.name][Number(i)]))) }}
                      />
                    </ListItemIcon>
                    <ListItemText
                      primary={p.name}
                      secondary={p.path}
                      secondaryTypographyProps={{
                        sx: { fontFamily: "monospace" },
                      }}
                    />
                    <ListItemSecondaryAction>
                      <IconButton
                        edge="end"
                        aria-label={("移除资料库 {0}".replace(/\{(\d+)\}/g, (_, i) => String([p.name][Number(i)])))}
                        onClick={() => profilesCtl.removeProfile(p.path)}
                        disabled={
                          p.path === profiles.active_path ||
                          hasActiveTasks ||
                          isSwitchingProfile
                        }
                      >
                        <DeleteIcon />
                      </IconButton>
                    </ListItemSecondaryAction>
                  </ListItem>
                ))}
              </List>
              {selectedProfilePath &&
                selectedProfilePath !== profiles.active_path && (
                  <Typography
                    variant="caption"
                    sx={{
                      mt: 1,
                      display: "block",
                      color: "text.secondary",
                    }}
                  >
                    {" 点击下方保存后，所选资料库将变为当前资料库。 "}</Typography>
                )}
            </Paper>
          </Grid>

          <Grid size={{ xs: 12, md: 5 }}>
            <Paper variant="outlined" sx={{ p: 2 }}>
              <Typography variant="h6" sx={{ mb: 1 }}>
                {" 创建新资料库 "}</Typography>
              <Stack direction="column" spacing={1.5}>
                <TextField
                  label="名称"
                  value={newProfileName}
                  onChange={(e) => setNewProfileName(e.target.value)}
                  fullWidth
                />
                <Box sx={{ display: "flex", gap: 1 }}>
                  <TextField
                    label="目录"
                    value={newProfilePath}
                    onChange={(e) => setNewProfilePath(e.target.value)}
                    fullWidth
                  />
                  <IconButton
                    aria-label="浏览资料库目录"
                    onClick={profilesCtl.pickNewProfilePath}
                    disabled={hasActiveTasks}
                  >
                    <FolderOpenIcon />
                  </IconButton>
                </Box>
                <Box sx={{ display: "flex", justifyContent: "flex-end" }}>
                  <Button
                    variant="contained"
                    color="primary"
                    startIcon={!creatingProfile ? <AddIcon /> : undefined}
                    onClick={profilesCtl.createProfile}
                    disabled={
                      !newProfilePath || creatingProfile || hasActiveTasks
                    }
                    sx={{ minWidth: 120 }}
                  >
                    {creatingProfile ? (
                      <CircularProgress size={18} color="inherit" />
                    ) : (
                      "创建"
                    )}
                  </Button>
                </Box>
                <FormHelperText>
                  {" 目标目录必须为空或不存在。 "}</FormHelperText>
              </Stack>
            </Paper>
          </Grid>
        </>
      ) : (
        <Grid size={{ xs: 12 }}>
          <Alert severity="info">
            {" 尚未注册任何资料库。请在下方创建或添加一个。 "}</Alert>
        </Grid>
      )}
    </Grid>
  );
}
