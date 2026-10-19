import { SESSION_TOOLS, WORKSPACE_NAV, type WorkspaceNavId } from "../../lib/productNavigation";
import { IconRail } from "../chromeIcons";

type Props = {
  workspaceName: string;
  workspacePath: string;
  active: WorkspaceNavId;
  loopLive: boolean;
  activeSessionTool?: "loop" | "terminal";
  managementDisabled: boolean;
  managementHint: string;
  onSwitchWorkspace: () => void;
  onNavigate: (id: WorkspaceNavId) => void;
  onSessionTool: (id: "loop" | "terminal") => void;
};

export function WorkspaceNavigation({
  workspaceName,
  workspacePath,
  active,
  loopLive,
  activeSessionTool,
  managementDisabled,
  managementHint,
  onSwitchWorkspace,
  onNavigate,
  onSessionTool,
}: Props) {
  return (
    <>
      <button
        type="button"
        className="workspace-switcher"
        title={workspacePath}
        aria-label={`切换工作区，当前为 ${workspaceName}`}
        onClick={onSwitchWorkspace}
      >
        <span className="side-label">当前工作区</span>
        <span className="workspace-switcher-name">
          <IconRail name="workspace" size={14} />
          {workspaceName}
          <span aria-hidden="true">⌄</span>
        </span>
      </button>
      <nav className="workspace-nav" aria-label="工作区功能">
        {WORKSPACE_NAV.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`workspace-nav-item${active === item.id ? " on" : ""}`}
            aria-current={active === item.id ? "page" : undefined}
            aria-label={item.label}
            disabled={item.id === "management" && managementDisabled}
            title={item.id === "management" && managementDisabled ? managementHint : undefined}
            onClick={() => onNavigate(item.id)}
          >
            <IconRail name={item.icon} size={14} />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
      <div className="session-tools" role="toolbar" aria-label="当前会话工具">
        <span className="side-label">当前会话工具</span>
        <div className="session-tools-row">
          {SESSION_TOOLS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`workspace-nav-item${activeSessionTool === item.id ? " on" : ""}`}
              aria-label={item.id === "loop" && loopLive ? `${item.label}，运行中` : item.label}
              aria-pressed={activeSessionTool === item.id}
              onClick={() => onSessionTool(item.id)}
            >
              <span className="side-tool-icon">
                <IconRail name={item.icon} size={14} />
                {item.id === "loop" && loopLive ? <span className="loop-live" aria-label="运行中" /> : null}
              </span>
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
