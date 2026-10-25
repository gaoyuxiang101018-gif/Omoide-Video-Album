import { ToggleButton, ToggleButtonGroup, Tooltip } from "@mui/material";
import PhotoSizeSelectSmallIcon from "@mui/icons-material/PhotoSizeSelectSmall";
import PhotoSizeSelectLargeIcon from "@mui/icons-material/PhotoSizeSelectLarge";
import CropSquareIcon from "@mui/icons-material/CropSquare";
import { useLocalStoragePreference } from "../hooks/useLocalStoragePreference";

export type PersonThumbSize = "small" | "medium" | "large";

const STORAGE_KEY = "peopleThumbSize";
const SIZES: readonly PersonThumbSize[] = ["small", "medium", "large"];

/** Grid column spans per breakpoint (12-column grid) for each thumbnail size. */
export const PERSON_GRID_SIZES: Record<
  PersonThumbSize,
  { xs: number; sm: number; md: number; lg: number }
> = {
  small: { xs: 4, sm: 3, md: 1.5, lg: 1 },
  medium: { xs: 6, sm: 4, md: 2, lg: 1.5 },
  large: { xs: 12, sm: 6, md: 3, lg: 2.4 },
};

/** Per-browser view preference for person card size (not a library setting). */
export function usePersonThumbSize() {
  return useLocalStoragePreference<PersonThumbSize>(
    STORAGE_KEY,
    SIZES,
    "medium"
  );
}

interface PersonThumbSizeToggleProps {
  value: PersonThumbSize;
  onChange: (size: PersonThumbSize) => void;
}

export function PersonThumbSizeToggle({
  value,
  onChange,
}: PersonThumbSizeToggleProps) {
  return (
    <ToggleButtonGroup
      exclusive
      size="small"
      value={value}
      onChange={(_, next: PersonThumbSize | null) => {
        if (next) onChange(next);
      }}
      aria-label="缩略图大小"
    >
      <ToggleButton value="small" aria-label="小缩略图">
        <Tooltip title="小缩略图">
          <PhotoSizeSelectSmallIcon fontSize="small" />
        </Tooltip>
      </ToggleButton>
      <ToggleButton value="medium" aria-label="中缩略图">
        <Tooltip title="中缩略图">
          <CropSquareIcon fontSize="small" />
        </Tooltip>
      </ToggleButton>
      <ToggleButton value="large" aria-label="大缩略图">
        <Tooltip title="大缩略图">
          <PhotoSizeSelectLargeIcon fontSize="small" />
        </Tooltip>
      </ToggleButton>
    </ToggleButtonGroup>
  );
}
