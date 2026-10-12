// 回合长时间没有进展时的提示条
import { useEffect, useState } from "react";
import styles from "./StallHint.module.css";

/// 一轮跑着却没有新进展时分级提示：4 秒后说“仍在处理”，15 秒后给出停止按钮。
/// 进展时间存在 ref 里不会触发渲染，所以每秒自己读一次。
export function StallHint({ lastProgress, onStop }: { lastProgress: () => number | undefined; onStop: () => void }) {
  const [mountedAt] = useState(() => Date.now());
  const [now, setNow] = useState(mountedAt);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const idle = Math.max(0, now - (lastProgress() ?? mountedAt));
  if (idle < 4_000) return null;
  const long = idle >= 15_000;
  return (
    <div className={long ? `${styles.hint} ${styles.long}` : styles.hint}>
      <span role="status">{long ? "还在处理，暂时没有新进展" : "仍在处理…"}</span>
      {long ? (
        <>
          <span className={styles.time} aria-hidden="true">
            {Math.round(idle / 1000)} 秒
          </span>
          <button type="button" className={styles.stop} onClick={onStop}>
            停止
          </button>
        </>
      ) : null}
    </div>
  );
}
