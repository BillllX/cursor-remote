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
