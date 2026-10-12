// 助理对话的标题行
import styles from "./AssistantChatHead.module.css";

type AssistantChatHeadProps = {
  assistantName: string;
  wideIDE: boolean;
  sidePane: "search" | "assistant" | "chats" | "files" | "git" | "terminal" | "loop";
  chooseSide: (pane: "chats" | "files" | "search" | "git" | "terminal" | "loop" | "assistant") => void;
  assistantBadge: number;
};

export function AssistantChatHead({
  assistantName,
  wideIDE,
  sidePane,
  chooseSide,
  assistantBadge,
}: AssistantChatHeadProps) {
  return (
    <div className="assistant-chat-head">
      <span className={styles.title}>{assistantName}</span>
      <span className={styles.sub}>助理</span>
      <button
        type="button"
        className={`pill assistant-today${wideIDE && sidePane === "assistant" ? " on" : ""}`}
        aria-label="打开今日、收件箱和记忆"
        onClick={() => chooseSide("assistant")}
      >
        今日
        {assistantBadge > 0 ? <span className="loop-live" /> : null}
      </button>
    </div>
  );
}
