// 侧栏底部的设置面板（外观、配色、退出登录）
import type { Dispatch, SetStateAction } from "react";
import { type AppearanceId, APPEARANCES, type PaletteId, PALETTES, readThemeChoice } from "../../lib/theme";
import styles from "./SettingsPanel.module.css";

type SettingsPanelProps = {
  themeChoice: {
    palette: PaletteId;
    appearance: AppearanceId;
  } | null;
  setThemeChoice: Dispatch<
    SetStateAction<{
      palette: PaletteId;
      appearance: AppearanceId;
    } | null>
  >;
  cwd: string;
  workspaceRoot: string;
  logout: () => void;
};

export function SettingsPanel({ themeChoice, setThemeChoice, cwd, workspaceRoot, logout }: SettingsPanelProps) {
  return (
    <div className="side-settings">
      <div className="theme-settings">
        <div className="theme-label">外观</div>
        <div className="theme-seg" role="group" aria-label="外观">
          {APPEARANCES.map((item) => (
            <button
              key={item.id}
              type="button"
              className={themeChoice?.appearance === item.id ? "on" : ""}
              aria-pressed={themeChoice?.appearance === item.id}
              onClick={() =>
                setThemeChoice((current) => ({
                  palette: current?.palette || readThemeChoice().palette,
                  appearance: item.id,
                }))
              }
            >
              {item.name}
            </button>
          ))}
        </div>
        <div className="theme-label">配色</div>
        <div className="theme-list" role="radiogroup" aria-label="配色">
          {PALETTES.map((item) => (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={themeChoice?.palette === item.id}
              aria-label={`${item.name}，${item.note}`}
              className={`theme-card${themeChoice?.palette === item.id ? " on" : ""}`}
              onClick={() =>
                setThemeChoice((current) => ({
                  palette: item.id,
                  appearance: current?.appearance || readThemeChoice().appearance,
                }))
              }
            >
              <span className="theme-card-preview" aria-hidden>
                {(["light", "dark"] as const).map((kind) => (
                  <span
                    key={kind}
                    className={`theme-mini${themeChoice && themeChoice.appearance !== "system" && themeChoice.appearance !== kind ? " idle" : ""}`}
                    data-palette={item.id}
                    data-theme={kind}
                  >
                    <span className="theme-mini-side">
                      <span className="theme-mini-line" />
                      <span className="theme-mini-line" />
                      <span className="theme-mini-line" />
                    </span>
                    <span className="theme-mini-main">
                      <span className="theme-mini-line text" style={{ width: "80%" }} />
                      <span className="theme-mini-line" style={{ width: "60%" }} />
                      <span className="theme-mini-bubble" />
                      <span className="theme-mini-composer">
                        <span className="theme-mini-send" />
                      </span>
                    </span>
                  </span>
                ))}
              </span>
              <span className="theme-card-meta">
                <b>{item.name}</b>
                <span>{item.note}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className={styles.workspacePath} title={cwd}>
        {cwd || workspaceRoot || "工作区"}
      </div>
      <button type="button" className="logout-btn" onClick={logout}>
        退出登录
      </button>
    </div>
  );
}
