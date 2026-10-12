// 侧栏底部：使用统计、连接状态与设置面板
import type { Dispatch, SetStateAction } from "react";
import { workspaceLabel } from "../../../lib/chat/workspace";
import type { AppearanceId, PaletteId } from "../../../lib/theme";
import { SettingsPanel } from "../SettingsPanel";

type SideFootProps = {
  isAdmin: boolean;
  openAdminStats: () => void;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  cwd: string;
  connected: boolean;
  unlocked: boolean;
  busy: boolean;
  workspaceRoot: string;
  assistantName: string;
  settingsOpen: boolean;
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
  logout: () => void;
};

export function SideFoot({
  isAdmin,
  openAdminStats,
  setSettingsOpen,
  cwd,
  connected,
  unlocked,
  busy,
  workspaceRoot,
  assistantName,
  settingsOpen,
  themeChoice,
  setThemeChoice,
  logout,
}: SideFootProps) {
  return (
    <div className="side-foot">
      {isAdmin ? (
        <button type="button" className="side-foot-btn" onClick={openAdminStats}>
          查看使用统计
        </button>
      ) : null}
      <button
        type="button"
        className="side-foot-btn"
        onClick={() => setSettingsOpen((open) => !open)}
        title={cwd || "工作目录"}
      >
        <span className={`dot ${connected && unlocked ? (busy ? "busy" : "on") : "off"}`} />
        <span className="side-foot-cwd">
          {connected
            ? !unlocked
              ? "正在登录…"
              : busy
                ? "服务器正在干活"
                : workspaceLabel(cwd || workspaceRoot, workspaceRoot, assistantName)
            : "没连上"}
        </span>
      </button>
      {settingsOpen ? (
        <SettingsPanel
          themeChoice={themeChoice}
          setThemeChoice={setThemeChoice}
          cwd={cwd}
          workspaceRoot={workspaceRoot}
          logout={logout}
        />
      ) : null}
    </div>
  );
}
