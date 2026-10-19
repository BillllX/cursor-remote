// 助理对话的标题行
import styles from "./AssistantChatHead.module.css";

type AssistantChatHeadProps = {
  assistantName: string;
  chooseSide: (pane: "chats" | "files" | "search" | "git" | "terminal" | "loop" | "assistant") => void;
  assistantBadge: number;
};

export function AssistantChatHead({
  assistantName,
  chooseSide,
  assistantBadge,
}: AssistantChatHeadProps) {
  return (
    <div className="assistant-chat-head">
      <span className={styles.title}>{assistantName}</span>
      <span className={styles.sub}>助理</span>
      <button
        type="button"
        className="pill assistant-today"
        aria-label={`打开助理总览、收件箱和通知${assistantBadge > 0 ? `，需要处理 ${assistantBadge}` : ""}`}
        onClick={() => chooseSide("assistant")}
      >
        助理
        {assistantBadge > 0 ? <span className="assistant-attention-badge" aria-hidden="true">{assistantBadge}</span> : null}
      </button>
    </div>
  );
}
