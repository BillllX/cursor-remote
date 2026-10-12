// 管理面板里的 Cursor 账单
import type { CursorBill } from "@shared/protocol";
import { fmtCount, fmtCycle, fmtPct, fmtUsd, onDemandText } from "../../lib/chat/format";

export function CursorBillPanel({ bill, ready }: { bill: CursorBill | null; ready: boolean }) {
  if (!bill) {
    return (
      <div className="admin-row">
        <span>账单</span>
        <span>{ready ? "这台网关还没有账单数据。" : "正在查询…"}</span>
      </div>
    );
  }
  const cycle = [fmtCycle(bill.cycleStart), fmtCycle(bill.cycleEnd)].filter(Boolean).join(" – ");
  const hasIncluded = typeof bill.includedPercent === "number";
  return (
    <>
      {bill.plan ? (
        <div className="admin-row">
          <span>方案</span>
          <span>{bill.plan}</span>
        </div>
      ) : null}
      {cycle ? (
        <div className="admin-row">
          <span>账期</span>
          <span>
            {cycle}
            {bill.cycleEnd ? " 重置" : ""}
          </span>
        </div>
      ) : null}
      {typeof bill.spendCents === "number" ? (
        <div className="admin-row">
          <span>本 Key 花费</span>
          <span>{fmtUsd(bill.spendCents)}</span>
        </div>
      ) : null}
      {hasIncluded ? (
        <div className="admin-summary">
          <div>
            <strong>{fmtPct(bill.includedPercent ?? 0)}</strong>
            <span>套餐内</span>
          </div>
          <div>
            <strong>{fmtPct(bill.autoPercent ?? 0)}</strong>
            <span>Auto</span>
          </div>
          <div>
            <strong>{fmtPct(bill.apiPercent ?? 0)}</strong>
            <span>API</span>
          </div>
        </div>
      ) : null}
      {bill.onDemand && bill.onDemand.kind !== "unavailable" ? (
        <div className="admin-row">
          <span>按需</span>
          <span>{onDemandText(bill.onDemand)}</span>
        </div>
      ) : null}
      {typeof bill.inputTokens === "number" ? (
        <div className="admin-row">
          <span>输入 / 输出</span>
          <span>
            {fmtCount(bill.inputTokens)} / {fmtCount(bill.outputTokens ?? 0)} token
          </span>
        </div>
      ) : null}
      {bill.models?.map((row) => (
        <div key={row.name} className="admin-row">
          <span>{row.name}</span>
          <span>{fmtUsd(row.spendCents)}</span>
        </div>
      ))}
      {bill.error ? <p className="admin-note">{bill.error}</p> : null}
    </>
  );
}
