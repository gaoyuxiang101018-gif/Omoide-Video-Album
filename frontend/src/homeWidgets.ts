export type HomeWidgetId =
  | "on_this_day"
  | "recent_media"
  | "favorites_strip"
  | "highlights_strip"
  | "albums_preview"
  | "statistics_snapshot";

export interface HomeWidgetDef {
  id: HomeWidgetId;
  label: string;
  description: string;
}

export const HOME_WIDGETS: HomeWidgetDef[] = [
  {
    id: "on_this_day",
    label: "往年今日",
    description: "往年的今天拍摄的媒体文件。",
  },
  {
    id: "recent_media",
    label: "最近媒体",
    description:
      "您的媒体文件库网格，支持网格/文件夹视图、相机和排序筛选。",
  },
  {
    id: "favorites_strip",
    label: "收藏",
    description: "您收藏的照片和视频条带。",
  },
  {
    id: "highlights_strip",
    label: "精彩集锦",
    description: "最近一年精选亮点。",
  },
  {
    id: "albums_preview",
    label: "相册",
    description: "快速跳转的相册封面行。",
  },
  {
    id: "statistics_snapshot",
    label: "统计",
    description: "资料库概览计数。",
  },
];

export const DEFAULT_HOME_WIDGET_ORDER: HomeWidgetId[] = HOME_WIDGETS.map(
  (w) => w.id
);

export const DEFAULT_ENABLED_WIDGETS: HomeWidgetId[] = [
  "on_this_day",
  "recent_media",
];

export const isHomeWidgetId = (value: string): value is HomeWidgetId =>
  HOME_WIDGETS.some((w) => w.id === value);

export interface HomeWidgetState {
  id: HomeWidgetId;
  enabled: boolean;
}

// Pre-migration per-browser storage. Widget settings now live in the
// library config; these are only consulted as a one-time fallback so
// users who already customized their layout don't see it reset to
// defaults the first time they load a build with this change.
const LEGACY_STORAGE_KEY = "home_widgets_v1";
const LEGACY_OTD_ENABLED_KEY = "otd_enabled";

const defaultEnabledFor = (id: HomeWidgetId): boolean => {
  if (id === "on_this_day") {
    const legacy = localStorage.getItem(LEGACY_OTD_ENABLED_KEY);
    if (legacy !== null) return legacy === "true";
  }
  return DEFAULT_ENABLED_WIDGETS.includes(id);
};

const fillMissing = (stored: HomeWidgetState[]): HomeWidgetState[] => {
  const seen = new Set(stored.map((s) => s.id));
  const missing = DEFAULT_HOME_WIDGET_ORDER.filter((id) => !seen.has(id)).map(
    (id) => ({ id, enabled: defaultEnabledFor(id) })
  );
  return [...stored, ...missing];
};

const legacyBrowserDefault = (): HomeWidgetState[] | null => {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const stored = parsed.filter(
      (entry): entry is HomeWidgetState =>
        entry &&
        typeof entry.id === "string" &&
        isHomeWidgetId(entry.id) &&
        typeof entry.enabled === "boolean"
    );
    return stored.length > 0 ? fillMissing(stored) : null;
  } catch {
    return null;
  }
};

const builtInDefault = (): HomeWidgetState[] =>
  DEFAULT_HOME_WIDGET_ORDER.map((id) => ({
    id,
    enabled: defaultEnabledFor(id),
  }));

/** Merges the saved library config's widget list with the built-in catalog,
 * appending any widgets shipped after the config was last saved so new
 * features aren't silently missing. */
export const mergeHomeWidgets = (
  stored: { id: string; enabled: boolean }[] | null | undefined
): HomeWidgetState[] => {
  const valid = (stored ?? []).filter(
    (entry): entry is HomeWidgetState =>
      !!entry && isHomeWidgetId(entry.id) && typeof entry.enabled === "boolean"
  );
  if (valid.length > 0) return fillMissing(valid);
  return legacyBrowserDefault() ?? builtInDefault();
};
