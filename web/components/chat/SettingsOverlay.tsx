"use client";

// 独立账户与设置浮窗（外观配色、浏览器通知推送、记忆备份导出导入、使用统计与账户管理）
import { useCallback, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { buildAssistantOpMessage, type BuildAssistantOpMessage } from "@shared/assistantOp";
import type { AssistantResultMessage, AssistantState, ClientMessage } from "@shared/protocol";
import { registerAssistantPush } from "../../lib/assistantPush";
import { type AppearanceId, APPEARANCES, type PaletteId, PALETTES, readThemeChoice } from "../../lib/theme";
import MemoryCenterImportPane from "../assistant/MemoryCenterImportPane";

type SettingsTab = "theme" | "notify" | "backup" | "account";

type SettingsOverlayProps = {
  open: boolean;
  onClose: () => void;
  dialogRef?: RefObject<HTMLDivElement | null>;
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
  isAdmin: boolean;
  openAdminStats: () => void;
  logout: () => void;
  assistantState: AssistantState | null;
  send: (message: ClientMessage) => void;
  basePath: string;
  lastAssistantResult: AssistantResultMessage | null;
  assistantResultTick: number;
  setNotice: Dispatch<SetStateAction<string>>;
};

export function SettingsOverlay({
  open,
  onClose,
  dialogRef,
  themeChoice,
  setThemeChoice,
  cwd,
  workspaceRoot,
  isAdmin,
  openAdminStats,
  logout,
  assistantState,
  send,
  basePath,
  lastAssistantResult,
  assistantResultTick,
  setNotice,
}: SettingsOverlayProps) {
  const [tab, setTab] = useState<SettingsTab>("theme");
  const [pushBusy, setPushBusy] = useState(false);
  const [localMsg, setLocalMsg] = useState("");

  const op = useCallback(
    (...params: Parameters<BuildAssistantOpMessage>) => {
      send(buildAssistantOpMessage(...params));
    },
    [send],
  ) as BuildAssistantOpMessage;

  if (!open) return null;

  async function enablePush() {
    if (!assistantState?.pushKey) {
      setLocalMsg("服务器还没准备好推送密钥，稍后再试。");
      return;
    }
    setPushBusy(true);
    setLocalMsg("");
    try {
      const subscription = await registerAssistantPush(assistantState.pushKey, basePath);
      op("push_subscribe", { subscription });
      setLocalMsg("已开启浏览器推送通知。");
      setNotice("已开启浏览器推送通知。");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "开启通知失败";
      setLocalMsg(msg);
    } finally {
      setPushBusy(false);
    }
  }

  return (
    <div className="search-overlay workspace-modal-overlay open" onClick={onClose}>
      <div
        ref={dialogRef}
        className="search-box management-box workspace-modal-box"
        role="dialog"
        aria-modal="true"
        aria-label="账户与设置"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="workspace-modal-head">
          <div className="workspace-modal-heading">
            <div className="workspace-modal-title-row">
              <span className="loop-title workspace-modal-title">账户与设置</span>
            </div>
            <div className="workspace-modal-sub">
              外观配色、通知推送、记忆全量备份与账户管理
            </div>
          </div>
          <div className="workspace-modal-actions">
            {isAdmin ? (
              <button
                type="button"
                className="workspace-modal-btn"
                onClick={() => {
                  onClose();
                  openAdminStats();
                }}
              >
                使用统计与账单
              </button>
            ) : null}
            <button
              type="button"
              className="files-browser-close workspace-modal-close"
              aria-label="关闭设置"
              title="关闭 (Esc)"
              onClick={onClose}
            >
              ×
            </button>
          </div>
        </div>

        <div className="assistant-tabs" role="tablist" aria-label="设置分类">
          {(
            [
              ["theme", "外观与配色"],
              ["notify", "通知与推送"],
              ["backup", "记忆导出与导入"],
              ["account", "账户与安全"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={`pill${tab === id ? " on" : ""}`}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="workspace-modal-body">
          {tab === "theme" ? (
            <section className="workspace-modal-section" aria-label="外观与配色">
              <div className="theme-settings">
                <div className="theme-label">外观模式</div>
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
                <div className="theme-label" style={{ marginTop: 12 }}>
                  主题色卡
                </div>
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
            </section>
          ) : null}

          {tab === "notify" ? (
            <section className="workspace-modal-section" aria-label="浏览器通知推送">
              <div className="side-label">浏览器推送通知</div>
              <p className="loop-meta">
                开启后将推送待批事项、委派完成结果、个人提醒与每日简报。普通流式进度与记忆写入不会打扰。
              </p>
              {localMsg ? <p className="loop-meta">{localMsg}</p> : null}
              <div className="workspace-manage-actions" style={{ marginTop: 8 }}>
                <button
                  type="button"
                  className="new-chat primary"
                  disabled={pushBusy}
                  onClick={() => void enablePush()}
                >
                  {pushBusy ? "正在开启…" : "开启浏览器通知"}
                </button>
                <button
                  type="button"
                  className="new-chat"
                  onClick={() => {
                    op("push_test");
                    setLocalMsg("已发送测试通知，请留意系统通知栏。");
                  }}
                >
                  发送测试通知
                </button>
              </div>
            </section>
          ) : null}

          {tab === "backup" ? (
            <section className="workspace-modal-section" aria-label="记忆导出与导入备份">
              <div className="side-label">全量与工作区记忆快照备份</div>
              <MemoryCenterImportPane
                op={op}
                lastResult={lastAssistantResult}
                resultTick={assistantResultTick}
                onNotice={(msg) => {
                  setLocalMsg(msg);
                  setNotice(msg);
                }}
                overviewScopes={[]}
              />
            </section>
          ) : null}

          {tab === "account" ? (
            <section className="workspace-modal-section" aria-label="账户与安全">
              <div className="side-label">当前工作区路径</div>
              <div className="loop-meta" style={{ wordBreak: "break-all" }}>
                {cwd || workspaceRoot || "工作区"}
              </div>
              <div className="workspace-manage-actions" style={{ marginTop: 12 }}>
                {isAdmin ? (
                  <button
                    type="button"
                    className="new-chat"
                    onClick={() => {
                      onClose();
                      openAdminStats();
                    }}
                  >
                    查看使用统计与账单
                  </button>
                ) : null}
                <button
                  type="button"
                  className="new-chat danger-btn"
                  onClick={() => {
                    onClose();
                    logout();
                  }}
                >
                  退出登录
                </button>
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
