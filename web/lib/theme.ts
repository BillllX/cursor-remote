export const PALETTES = [
  { id: "neutral", name: "中性" },
  { id: "paper", name: "纸墨" },
  { id: "sand", name: "暖砂" },
  { id: "pine", name: "松石" },
  { id: "cool", name: "冷墨" },
  { id: "ink", name: "墨砚" },
  { id: "night", name: "夜读" },
  { id: "clay", name: "陶土" },
] as const;

export type PaletteId = (typeof PALETTES)[number]["id"];

export const APPEARANCES = [
  { id: "system", name: "跟随系统" },
  { id: "light", name: "浅色" },
  { id: "dark", name: "深色" },
] as const;

export type AppearanceId = (typeof APPEARANCES)[number]["id"];

export const THEME_KEY = "jiebo.theme";
export const APPEARANCE_KEY = "jiebo.appearance";

const PALETTE_IDS = new Set<string>(PALETTES.map((item) => item.id));

export type SurfaceInk = {
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

/** 与 web/app/themes.css、iOS JieboSurfaces 同一组色值。 */
const SURFACES: Record<PaletteId, { light: SurfaceInk; dark: SurfaceInk }> = {
  neutral: {
    light: { bg: "#fafafa", sidebar: "#fafafa", panel: "#ffffff", text: "#171717", muted: "#6e6e6e", border: "#ececec", accent: "#171717", user: "#f4f4f5", fillFg: "#fafafa" },
    dark: { bg: "#141512", sidebar: "#101210", panel: "#1b1d1a", text: "#ede8de", muted: "#b6b0a4", border: "#2c2f2b", accent: "#8fbfb0", user: "#24332e", fillFg: "#141512" },
  },
  paper: {
    light: { bg: "#f3eee4", sidebar: "#efe9dd", panel: "#fffcfa", text: "#1c1916", muted: "#5c574f", border: "#d4cdbf", accent: "#1a4f41", user: "#e7e1d4", fillFg: "#fffcfa" },
    dark: { bg: "#1c1916", sidebar: "#161310", panel: "#221f1a", text: "#ede8de", muted: "#b6b0a4", border: "#3a352d", accent: "#8fbfb0", user: "#2a3a32", fillFg: "#1c1916" },
  },
  sand: {
    light: { bg: "#f7f4ee", sidebar: "#f3eee4", panel: "#fffdf8", text: "#2a2620", muted: "#6e655a", border: "#e2d9c8", accent: "#8a6a3c", user: "#ece4d2", fillFg: "#fffdf8" },
    dark: { bg: "#1a1814", sidebar: "#15120e", panel: "#221f1a", text: "#ede6d6", muted: "#b3a890", border: "#322d22", accent: "#c4a36a", user: "#2c2620", fillFg: "#1a1814" },
  },
  pine: {
    light: { bg: "#f5f2ec", sidebar: "#efece4", panel: "#ffffff", text: "#1c1916", muted: "#5c574f", border: "#d4cdbf", accent: "#1a4f41", user: "#e3ece6", fillFg: "#ffffff" },
    dark: { bg: "#0f1a16", sidebar: "#0c1612", panel: "#142019", text: "#e6efe9", muted: "#9db5a8", border: "#243029", accent: "#8fbfb0", user: "#1f3a2e", fillFg: "#0f1a16" },
  },
  cool: {
    light: { bg: "#f6f7f8", sidebar: "#f1f3f5", panel: "#ffffff", text: "#0f1720", muted: "#5a6373", border: "#e3e7ec", accent: "#1f4f66", user: "#eef1f5", fillFg: "#ffffff" },
    dark: { bg: "#0f1418", sidebar: "#0b0f13", panel: "#161b21", text: "#e6ebf0", muted: "#9aa3b0", border: "#232a32", accent: "#7aa5f8", user: "#1d2630", fillFg: "#0f1418" },
  },
  ink: {
    light: { bg: "#f4efe6", sidebar: "#ebe4d8", panel: "#fffcf7", text: "#1c1612", muted: "#6a6156", border: "#ddd2c4", accent: "#6b4e32", user: "#e6dccb", fillFg: "#fffcf7" },
    dark: { bg: "#121110", sidebar: "#0e0d0c", panel: "#1a1917", text: "#f3eee4", muted: "#b3a890", border: "#322c26", accent: "#c4a36a", user: "#2a2520", fillFg: "#121110" },
  },
  night: {
    light: { bg: "#f7f7f8", sidebar: "#f1f1f3", panel: "#ffffff", text: "#161618", muted: "#5e5e66", border: "#e4e4e8", accent: "#161618", user: "#ececef", fillFg: "#f7f7f8" },
    dark: { bg: "#0c0d10", sidebar: "#090a0c", panel: "#131418", text: "#e8e8ea", muted: "#9a9aa0", border: "#23242a", accent: "#c4a36a", user: "#1a1c22", fillFg: "#0c0d10" },
  },
  clay: {
    light: { bg: "#f6f1ea", sidebar: "#efe6dc", panel: "#fffdf9", text: "#241812", muted: "#6e5b4e", border: "#e0d2c4", accent: "#8a4632", user: "#eadfd2", fillFg: "#fffdf9" },
    dark: { bg: "#1a1411", sidebar: "#140f0d", panel: "#241c18", text: "#f3ebe4", muted: "#c4b0a2", border: "#3a2e28", accent: "#e09478", user: "#2e241e", fillFg: "#1a1411" },
  },
};

export function paletteSurfaces(id: string | null | undefined, kind: "light" | "dark"): SurfaceInk {
  return SURFACES[normalizePalette(id ?? null)][kind];
}

export function normalizePalette(value: string | null): PaletteId {
  return value && PALETTE_IDS.has(value) ? (value as PaletteId) : "neutral";
}

export function normalizeAppearance(value: string | null): AppearanceId {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function readThemeChoice(): { palette: PaletteId; appearance: AppearanceId } {
  if (typeof window === "undefined") return { palette: "neutral", appearance: "system" };
  return {
    palette: normalizePalette(localStorage.getItem(THEME_KEY)),
    appearance: normalizeAppearance(localStorage.getItem(APPEARANCE_KEY)),
  };
}

declare global {
  interface Window {
    __jieboApplyTheme?: (palette: string, appearance: string) => void;
  }
}

export function applyJieboTheme(palette: string, appearance: string) {
  if (typeof window === "undefined") return;
  if (window.__jieboApplyTheme) {
    window.__jieboApplyTheme(palette, appearance);
    return;
  }
  const nextPalette = normalizePalette(palette);
  const nextAppearance = normalizeAppearance(appearance);
  const theme =
    nextAppearance === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : nextAppearance;
  document.documentElement.dataset.palette = nextPalette;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

/** 写在 <head> 里，首屏绘制前套上配色。画布 iframe 同源，用 storage 事件跟上切换。 */
export const THEME_BOOT = `(function(){
  var ids=["neutral","paper","sand","pine","cool","ink","night","clay"];
  function paletteOf(value){return ids.indexOf(value)>=0?value:"neutral"}
  function appearanceOf(value){return value==="light"||value==="dark"||value==="system"?value:"system"}
  function read(key, fallback){try{return localStorage.getItem(key)||fallback}catch(e){return fallback}}
  function write(key, value){try{if(localStorage.getItem(key)!==value)localStorage.setItem(key,value)}catch(e){}}
  function resolved(appearance){
    if(appearance==="light"||appearance==="dark")return appearance;
    return window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";
  }
  function paint(){
    var bg=getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
    var meta=document.querySelector('meta[name="theme-color"]');
    if(meta&&bg)meta.setAttribute("content",bg);
  }
  function apply(palette, appearance){
    palette=paletteOf(palette);
    appearance=appearanceOf(appearance);
    var theme=resolved(appearance);
    var root=document.documentElement;
    root.dataset.palette=palette;
    root.dataset.theme=theme;
    root.style.colorScheme=theme;
    write("jiebo.theme", palette);
    write("jiebo.appearance", appearance);
    if(document.readyState==="loading") document.addEventListener("DOMContentLoaded", paint, {once:true});
    else paint();
  }
  window.__jieboApplyTheme=apply;
  apply(read("jiebo.theme","neutral"), read("jiebo.appearance","system"));
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function(){
    if(read("jiebo.appearance","system")!=="system") return;
    apply(read("jiebo.theme","neutral"), "system");
  });
  window.addEventListener("storage", function(event){
    if(event.key!=="jiebo.theme"&&event.key!=="jiebo.appearance") return;
    apply(read("jiebo.theme","neutral"), read("jiebo.appearance","system"));
  });
})();`;
