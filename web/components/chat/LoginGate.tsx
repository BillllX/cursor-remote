// 登录页（输入密码）
import { useRef } from "react";
import { friendlyError } from "../../lib/chat/format";
import { JieboMark as Mark } from "../JieboMark";
import styles from "./LoginGate.module.css";

export function LoginGate({
  connected,
  verifying,
  error,
  value,
  onChange,
  onSubmit,
}: {
  connected: boolean;
  verifying: boolean;
  error: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const composingRef = useRef(false);
  return (
    <div className="login-gate">
      <form
        className="login-card"
        onSubmit={(event) => {
          event.preventDefault();
          if (composingRef.current) return;
          onSubmit();
        }}
      >
        <Mark />
        <h1>接驳</h1>
        <p>网页说话，远端动手。先输入密码。</p>
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          className="side-input"
          value={value}
          placeholder="密码"
          onChange={(event) => onChange(event.target.value)}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            window.setTimeout(() => {
              composingRef.current = false;
            }, 0);
          }}
        />
        {error ? <div className="error-line">{friendlyError(error)}</div> : null}
        <button type="submit" className="login-btn" disabled={!value.trim()}>
          {verifying ? "正在验证…" : "进入"}
        </button>
        <div className={styles.status}>{connected ? "已连上服务器" : "正在连接服务器…"}</div>
      </form>
    </div>
  );
}
