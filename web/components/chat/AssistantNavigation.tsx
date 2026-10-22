import type { AssistantView } from "../AssistantPanel";
import { ASSISTANT_SIDEBAR_NAV } from "../../lib/productNavigation";
import { IconRail } from "../chromeIcons";

export type AssistantSidebarView = "chat" | AssistantView;

type Props = {
  assistantName: string;
  active: AssistantSidebarView;
  inboxBadge: number;
  overviewBadge: number;
  onNavigate: (id: AssistantSidebarView) => void;
};

export function AssistantNavigation({ assistantName, active, inboxBadge, overviewBadge, onNavigate }: Props) {
  return (
    <>
      <div className="assistant-domain-card">
        <span className="side-label">个人助理</span>
        <span className="workspace-switcher-name">
          <IconRail name="assistant" size={14} />
          {assistantName}
          <span className="assistant-domain-status">就绪</span>
        </span>
      </div>
      <nav className="workspace-nav" aria-label="个人助理功能">
        {ASSISTANT_SIDEBAR_NAV.map((item) => {
          const selected = active === item.id;
          const count = item.id === "inbox" ? inboxBadge : item.id === "overview" ? overviewBadge : 0;
          return (
            <button
              key={item.id}
              type="button"
              className={`workspace-nav-item${selected ? " on" : ""}`}
              aria-current={selected ? "page" : undefined}
              aria-label={`${item.label}${count > 0 ? `，需要处理 ${count}` : ""}`}
              onClick={() => onNavigate(item.id)}
            >
              <IconRail name={item.icon} size={14} />
              <span>{item.label}</span>
              {count > 0 ? (
                <span className="assistant-nav-badge" aria-hidden="true">
                  {count}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>
    </>
  );
}
