// 使用统计弹层（管理员）
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { AdminTenantStats, CursorBill } from "@shared/protocol";
import { fmtClock, fmtCount, fmtDuration, fmtRelative, fmtTokens } from "../../lib/chat/format";
import { CursorBillPanel } from "./CursorBillPanel";
import styles from "./AdminOverlay.module.css";

type AdminOverlayProps = {
  setAdminOpen: Dispatch<SetStateAction<boolean>>;
  adminTrap: RefObject<HTMLDivElement | null>;
  openAdminStats: () => void;
  adminStats: AdminTenantStats[];
  cursorBill: CursorBill | null;
  adminStatsAt: number | null;
};

export function AdminOverlay({
  setAdminOpen,
  adminTrap,
  openAdminStats,
  adminStats,
  cursorBill,
  adminStatsAt,
}: AdminOverlayProps) {
  return (
    <div className="search-overlay open" onClick={() => setAdminOpen(false)}>
      <div
        ref={adminTrap}
        className="search-box admin-box"
        role="dialog"
        aria-modal="true"
        aria-label="使用统计"
        onClick={(event) => event.stopPropagation()}
      >
        <div className={styles.head}>
          <div className="loop-title">使用统计</div>
          <div className={styles.headActions}>
            <button type="button" className="logout-btn" onClick={openAdminStats}>
              刷新
            </button>
            <button type="button" className="logout-btn" onClick={() => setAdminOpen(false)}>
              关闭
            </button>
          </div>
        </div>
        {adminStats.length || cursorBill ? (
          <div className="admin-body">
            <div className={styles.section}>
              <div className={styles.sectionLabel}>
                Cursor 账单{cursorBill ? ` · ${fmtClock(cursorBill.fetchedAt)}` : ""}
              </div>
              <CursorBillPanel bill={cursorBill} ready={adminStatsAt != null} />
            </div>
            <div className={styles.section}>
              <div className={styles.sectionLabel}>
                各账号估算消耗{adminStatsAt ? ` · ${fmtClock(adminStatsAt)} 更新` : ""}
              </div>
              <div className="admin-summary">
                <div>
                  <strong>{fmtTokens(adminStats.reduce((sum, row) => sum + row.estTokens, 0))}</strong>
                  <span>估算 token</span>
                </div>
                <div>
                  <strong>{fmtCount(adminStats.reduce((sum, row) => sum + row.turns, 0))}</strong>
                  <span>消息</span>
                </div>
                <div>
                  <strong>{fmtCount(adminStats.reduce((sum, row) => sum + row.runs, 0))}</strong>
                  <span>运行</span>
                </div>
                <div>
                  <strong>{fmtDuration(adminStats.reduce((sum, row) => sum + row.runMs, 0))}</strong>
                  <span>运行时长</span>
                </div>
              </div>
            </div>
            {adminStats.map((row) => (
              <div key={row.id} className={styles.section}>
                <div className={styles.sectionLabel}>
                  <span className={`admin-online${row.online > 0 ? " on" : ""}`} />
                  {row.name}
                  {row.admin ? <span className={styles.badge}>管理员</span> : null}
                  {row.online > 0 ? <span className="admin-online-count">{row.online} 在线</span> : null}
                </div>
                <div className="admin-row">
                  <span>会话</span>
                  <span>{row.chats}</span>
                </div>
                <div className="admin-row">
                  <span>消息 / 运行 / 工具</span>
                  <span>
                    {fmtCount(row.turns)} / {fmtCount(row.runs)} / {fmtCount(row.toolCalls)}
                  </span>
                </div>
                <div className="admin-row">
                  <span>运行时长</span>
                  <span>{fmtDuration(row.runMs)}</span>
                </div>
                <div className="admin-row">
                  <span>输入 / 输出</span>
                  <span>
                    {fmtCount(row.inChars)} / {fmtCount(row.outChars)} 字符
                  </span>
                </div>
                <div className="admin-row">
                  <span>估算 token</span>
                  <span>{fmtTokens(row.estTokens)}</span>
                </div>
                {row.modelInTokens || row.modelOutTokens ? (
                  <div className="admin-row">
                    <span>第三方模型 token（实计）</span>
                    <span>
                      入 {fmtTokens(row.modelInTokens ?? 0)} / 出 {fmtTokens(row.modelOutTokens ?? 0)}
                      {row.modelCacheTokens ? ` / 缓存 ${fmtTokens(row.modelCacheTokens)}` : ""}
                    </span>
                  </div>
                ) : null}
                <div className="admin-row">
                  <span>最后活跃</span>
                  <span>{fmtRelative(row.lastActiveAt)}</span>
                </div>
              </div>
            ))}
            <p className="admin-note">
              上面是这台服务器 CURSOR_API_KEY 的官方账单，和 Cursor CLI 的 /usage 同一口径。下面各账号的 token
              仍是按字符估算（英文 ≈4 字符/token；中文实际更高），只用来看相对消耗。
            </p>
          </div>
        ) : (
          <div className="terminal-empty">
            <div>暂无数据</div>
            <div className="loop-meta">连上服务器后自动拉取。</div>
          </div>
        )}
      </div>
    </div>
  );
}
