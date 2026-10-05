/** 只留两套。浅色、深色各有两种观感：接驳偏暖，素墨偏冷。id 与 iOS JieboPalette 的 rawValue 一致。 */
export const PALETTES = [
  { id: "jiebo", name: "接驳", note: "暖白纸色 · 松绿强调" },
  { id: "night", name: "素墨", note: "冷白近黑 · 墨黑与赭金强调" },
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
export const DEFAULT_PALETTE: PaletteId = "jiebo";

/** 旧版九套配色按观感归到两套里：暖色系归接驳，中性、冷色系归素墨。 */
const LEGACY_PALETTES: Record<string, PaletteId> = {
  jiebo: "jiebo",
  paper: "jiebo",
  pine: "jiebo",
  sand: "jiebo",
  ink: "jiebo",
  clay: "jiebo",
  night: "night",
  neutral: "night",
  cool: "night",
};

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
  jiebo: {
    light: { bg: "#f3eee4", sidebar: "#ebe5d9", panel: "#fffcf8", text: "#1c1916", muted: "#5c574f", border: "#ddd5c7", accent: "#1a4f41", user: "#e2ebe4", fillFg: "#fffcf8" },
    dark: { bg: "#141512", sidebar: "#101210", panel: "#1b1d1a", text: "#ede8de", muted: "#b6b0a4", border: "#2c2f2b", accent: "#8fbfb0", user: "#22322c", fillFg: "#141512" },
  },
  night: {
    light: { bg: "#f7f7f8", sidebar: "#f1f1f3", panel: "#ffffff", text: "#161618", muted: "#5e5e66", border: "#e4e4e8", accent: "#161618", user: "#ececef", fillFg: "#f7f7f8" },
    dark: { bg: "#0c0d10", sidebar: "#090a0c", panel: "#131418", text: "#e8e8ea", muted: "#9a9aa0", border: "#23242a", accent: "#c4a36a", user: "#1a1c22", fillFg: "#0c0d10" },
  },
};

export function paletteSurfaces(id: string | null | undefined, kind: "light" | "dark"): SurfaceInk {
  return SURFACES[normalizePalette(id ?? null)][kind];
}

export function normalizePalette(value: string | null): PaletteId {
  return value && Object.prototype.hasOwnProperty.call(LEGACY_PALETTES, value) ? LEGACY_PALETTES[value] : DEFAULT_PALETTE;
}

export function normalizeAppearance(value: string | null): AppearanceId {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function readThemeChoice(): { palette: PaletteId; appearance: AppearanceId } {
  if (typeof window === "undefined") return { palette: DEFAULT_PALETTE, appearance: "system" };
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

/** 写在 <head> 里，首屏绘制前套上配色。画布 iframe 同源，用 storage 事件跟上切换。
 *  旧版启动脚本会把默认的 neutral 写进 storage，分不出是不是用户自己选的；rev 2 起统一迁到品牌配色一次。 */
export const THEME_BOOT = `(function(){
  var legacy=${JSON.stringify(LEGACY_PALETTES)};
  var fallback=${JSON.stringify(DEFAULT_PALETTE)};
  function paletteOf(value){return Object.prototype.hasOwnProperty.call(legacy,value)?legacy[value]:fallback}
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
  if(read("jiebo.theme.rev","")!=="2"){
    if(read("jiebo.theme","neutral")==="neutral") write("jiebo.theme", fallback);
    write("jiebo.theme.rev","2");
  }
  apply(read("jiebo.theme",fallback), read("jiebo.appearance","system"));
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function(){
    if(read("jiebo.appearance","system")!=="system") return;
    apply(read("jiebo.theme",fallback), "system");
  });
  window.addEventListener("storage", function(event){
    if(event.key!=="jiebo.theme"&&event.key!=="jiebo.appearance") return;
    apply(read("jiebo.theme",fallback), read("jiebo.appearance","system"));
  });
})();`;
