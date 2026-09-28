export type Color =
  | "gray"
  | "purple"
  | "green"
  | "yellow"
  | "cyan"
  | "pink"
  | "blue"
  | "orange"
  | "red";

export type CategoryPalette = Readonly<Record<Color, string>>;

export interface CanvasPalette {
  readonly foreground: string;
  readonly foregroundSecondary: string;
  readonly foregroundTertiary: string;
  readonly foregroundQuaternary: string;
  readonly editor: string;
  readonly chrome: string;
  readonly sidebar: string;
  readonly elevated: string;
  readonly fillPrimary: string;
  readonly fillSecondary: string;
  readonly fillTertiary: string;
  readonly fillQuaternary: string;
  readonly strokePrimary: string;
  readonly strokeSecondary: string;
  readonly strokeTertiary: string;
  readonly strokeFocused: string;
  readonly accent: string;
  readonly buttonBackground: string;
  readonly buttonForeground: string;
  readonly buttonHoverBackground: string;
  readonly link: string;
  readonly diffInsertedLine: string;
  readonly diffRemovedLine: string;
  readonly diffStripAdded: string;
  readonly diffStripRemoved: string;
}

export interface CanvasTokens {
  bg: {
    editor: string;
    chrome: string;
    elevated: string;
  };
  text: {
    primary: string;
    secondary: string;
    tertiary: string;
    quaternary: string;
    link: string;
    onAccent: string;
  };
  stroke: {
    primary: string;
    secondary: string;
    tertiary: string;
    focused: string;
  };
  fill: {
    primary: string;
    secondary: string;
    tertiary: string;
    quaternary: string;
  };
  accent: {
    primary: string;
    control: string;
    controlHover: string;
  };
  diff: {
    insertedLine: string;
    removedLine: string;
    stripAdded: string;
    stripRemoved: string;
  };
  category: CategoryPalette;
}

export interface CanvasHostThemeOverrides {
  readonly primary?: string;
  readonly editorBackground?: string;
  readonly editorForeground?: string;
}

export const canvasPaletteDark: CanvasPalette = {
  foreground: "#e8e8e8",
  foregroundSecondary: "#b4b4b4",
  foregroundTertiary: "#8a8a8a",
  foregroundQuaternary: "#6e6e6e",
  editor: "#181818",
  chrome: "#101010",
  sidebar: "#101010",
  elevated: "#1c1c1c",
  fillPrimary: "rgba(232,232,232,0.12)",
  fillSecondary: "rgba(232,232,232,0.08)",
  fillTertiary: "rgba(232,232,232,0.05)",
  fillQuaternary: "rgba(232,232,232,0.03)",
  strokePrimary: "#3a3a3a",
  strokeSecondary: "#2e2e2e",
  strokeTertiary: "#262626",
  strokeFocused: "#88c0ff",
  accent: "#88c0ff",
  buttonBackground: "#3d7eff",
  buttonForeground: "#141414",
  buttonHoverBackground: "#5a90ff",
  link: "#88c0ff",
  diffInsertedLine: "rgba(74,222,128,0.14)",
  diffRemovedLine: "rgba(248,113,113,0.14)",
  diffStripAdded: "#4ade80",
  diffStripRemoved: "#f87171",
};

export const canvasPaletteLight: CanvasPalette = {
  foreground: "#141414",
  foregroundSecondary: "#4a4a4a",
  foregroundTertiary: "#6e6e6e",
  foregroundQuaternary: "#8a8a8a",
  editor: "#f4f4f4",
  chrome: "#ececec",
  sidebar: "#e8e8e8",
  elevated: "#ffffff",
  fillPrimary: "rgba(20,20,20,0.12)",
  fillSecondary: "rgba(20,20,20,0.08)",
  fillTertiary: "rgba(20,20,20,0.05)",
  fillQuaternary: "rgba(20,20,20,0.03)",
  strokePrimary: "#d0d0d0",
  strokeSecondary: "#dedede",
  strokeTertiary: "#e8e8e8",
  strokeFocused: "#3d7eff",
  accent: "#3d7eff",
  buttonBackground: "#3d7eff",
  buttonForeground: "#ffffff",
  buttonHoverBackground: "#2f6ae6",
  link: "#3d7eff",
  diffInsertedLine: "rgba(22,163,74,0.12)",
  diffRemovedLine: "rgba(220,38,38,0.12)",
  diffStripAdded: "#16a34a",
  diffStripRemoved: "#dc2626",
};

export const categoryPaletteDark: CategoryPalette = {
  gray: "#8a8a8a",
  purple: "#c4b5fd",
  green: "#4ade80",
  yellow: "#fbbf24",
  cyan: "#67e8f9",
  pink: "#f9a8d4",
  blue: "#88c0ff",
  orange: "#fb923c",
  red: "#f87171",
};

export const categoryPaletteLight: CategoryPalette = {
  gray: "#6e6e6e",
  purple: "#7c3aed",
  green: "#16a34a",
  yellow: "#ca8a04",
  cyan: "#0891b2",
  pink: "#db2777",
  blue: "#2563eb",
  orange: "#ea580c",
  red: "#dc2626",
};

export const colorPalette = categoryPaletteDark;

export const usageColorSequence: readonly Color[] = [
  "gray",
  "purple",
  "green",
  "yellow",
  "pink",
  "blue",
  "orange",
  "cyan",
  "red",
];

export const chartColorSequence: readonly string[] = [
  "#88c0ff",
  "#4ade80",
  "#c4b5fd",
  "#fb923c",
  "#67e8f9",
  "#f9a8d4",
  "#fbbf24",
  "#f87171",
  "#a3a3a3",
];

export function tokensFromPalette(palette: CanvasPalette, category: CategoryPalette): CanvasTokens {
  return {
    bg: {
      editor: palette.editor,
      chrome: palette.chrome,
      elevated: palette.elevated,
    },
    text: {
      primary: palette.foreground,
      secondary: palette.foregroundSecondary,
      tertiary: palette.foregroundTertiary,
      quaternary: palette.foregroundQuaternary,
      link: palette.link,
      onAccent: palette.buttonForeground,
    },
    stroke: {
      primary: palette.strokePrimary,
      secondary: palette.strokeSecondary,
      tertiary: palette.strokeTertiary,
      focused: palette.strokeFocused,
    },
    fill: {
      primary: palette.fillPrimary,
      secondary: palette.fillSecondary,
      tertiary: palette.fillTertiary,
      quaternary: palette.fillQuaternary,
    },
    accent: {
      primary: palette.accent,
      control: palette.buttonBackground,
      controlHover: palette.buttonHoverBackground,
    },
    diff: {
      insertedLine: palette.diffInsertedLine,
      removedLine: palette.diffRemovedLine,
      stripAdded: palette.diffStripAdded,
      stripRemoved: palette.diffStripRemoved,
    },
    category,
  };
}

export const canvasTokens = tokensFromPalette(canvasPaletteDark, categoryPaletteDark);
export const canvasTokensLight = tokensFromPalette(canvasPaletteLight, categoryPaletteLight);

export function applyWorkbenchSurfaces(
  palette: CanvasPalette,
  surfaces: Pick<CanvasHostThemeOverrides, "editorBackground" | "editorForeground">,
): CanvasPalette {
  return {
    ...palette,
    editor: surfaces.editorBackground || palette.editor,
    elevated: surfaces.editorBackground || palette.elevated,
    foreground: surfaces.editorForeground || palette.foreground,
  };
}

export type JieboCanvasSurfaces = {
  bg: string;
  sidebar: string;
  panel: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
  user: string;
  fillFg: string;
};

/** 把应用配色铺进画布宿主。分类色（图表绿/红/黄）保持语义，不跟配色漂移。 */
export function applyJieboSurfaces(palette: CanvasPalette, surfaces: JieboCanvasSurfaces): CanvasPalette {
  return {
    ...palette,
    foreground: surfaces.text,
    foregroundSecondary: surfaces.muted,
    foregroundTertiary: surfaces.muted,
    foregroundQuaternary: surfaces.border,
    editor: surfaces.bg,
    chrome: surfaces.sidebar,
    sidebar: surfaces.sidebar,
    elevated: surfaces.panel,
    strokePrimary: surfaces.border,
    strokeSecondary: surfaces.border,
    strokeTertiary: surfaces.border,
    strokeFocused: surfaces.accent,
    accent: surfaces.accent,
    buttonBackground: surfaces.accent,
    buttonForeground: surfaces.fillFg,
    buttonHoverBackground: surfaces.accent,
    link: surfaces.accent,
    fillSecondary: surfaces.user,
  };
}

export function applyPrimaryColor(palette: CanvasPalette, primary: string): CanvasPalette {
  if (!/^#([0-9a-f]{6}|[0-9a-f]{3})$/i.test(primary)) return palette;
  return {
    ...palette,
    accent: primary,
    buttonBackground: primary,
    strokeFocused: primary,
    link: primary,
  };
}

export function buildHostTokens(
  kind: string,
  overrides?: CanvasHostThemeOverrides & { surfaces?: JieboCanvasSurfaces },
) {
  const light = kind === "light" || kind === "hc-light";
  let palette = light ? canvasPaletteLight : canvasPaletteDark;
  const category = light ? categoryPaletteLight : categoryPaletteDark;
  if (overrides?.surfaces) palette = applyJieboSurfaces(palette, overrides.surfaces);
  if (overrides?.editorBackground || overrides?.editorForeground) {
    palette = applyWorkbenchSurfaces(palette, overrides);
  }
  if (overrides?.primary) palette = applyPrimaryColor(palette, overrides.primary);
  return { tokens: tokensFromPalette(palette, category), palette };
}

export const canvasTypography = {
  h1: { fontSize: "24px", lineHeight: "30px", fontWeight: 590 },
  h2: { fontSize: "18px", lineHeight: "24px", fontWeight: 590 },
  h3: { fontSize: "16px", lineHeight: "22px", fontWeight: 590 },
  body: { fontSize: "14px", lineHeight: "20px", fontWeight: 400 },
  small: { fontSize: "12px", lineHeight: "16px", fontWeight: 400 },
} as const;

export const canvasSpacing = {
  "0.5": 2,
  "1": 4,
  "1.5": 6,
  "2": 8,
  "2.5": 10,
  "3": 12,
  "3.5": 14,
  "4": 16,
  "4.5": 18,
  "5": 20,
  "6": 24,
  "7": 28,
  "8": 32,
  "9": 36,
  "10": 40,
} as const;

export const canvasRadius = {
  none: 0,
  xs: 2,
  sm: 4,
  md: 6,
  lg: 8,
  xl: 12,
  full: 9999,
} as const;
