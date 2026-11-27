// 录音整理结果交付模块：
// - 个人路由（personal）：向可乐/小驳收件箱投递带出处摘要通知卡（使用稳定 deliveryKey 幂等去重，不传原音）
// - 项目路由（workspace）：生成带时间戳逐字稿与证据链摘要的 Markdown，经 submitDirectIngestBatch 归档入目标工作区（仅投 .md，绝不投 m4a）
import { postInbox } from "../assistant/inbox.ts";
import { buildDropTenantHost } from "../ingest/http.ts";
import { submitDirectIngestBatch } from "../ingest/queue.ts";
import type { Tenant } from "../tenants.ts";
import { formatDurationFrames } from "./canonical.ts";
import type { RecordingDeliveryReceipt, RecordingResultPayload, RecordingRoute } from "./types.ts";

function safeMarkdownFileName(title: string, sessionId: string): string {
  const datePrefix = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const clean = title
    .replace(/[/\\:*?"<>|.\r\n\t]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^_+/, "")
    .slice(0, 42);
  return `${datePrefix}_${clean || "录音整理"}_${sessionId.slice(0, 6)}.md`;
}

export function renderRecordingMarkdown(result: RecordingResultPayload): string {
  const lines: string[] = [
    `# ${result.title}`,
    "",
    `- 会话 ID：\`${result.sessionId}\`（版本 g${result.generation} / r${result.resultRevision}）`,
    `- 完整度：${result.coverage === "complete" ? "完整采集" : "部分内容（存在缺失区间）"}`,
    `- 转写来源：${result.transcriptSource}`,
    `- 生成时间：${new Date().toISOString()}`,
    "",
    "## 整理摘要",
    "",
    result.summary,
    "",
  ];

  if (result.missingRanges.length > 0) {
    lines.push("## 缺失区间说明", "");
    for (const gap of result.missingRanges) {
      lines.push(`- ${formatDurationFrames(gap.startFrame)} – ${formatDurationFrames(gap.endFrame)}：${gap.reason}`);
    }
    lines.push("");
  }

  if (result.claims.length > 0) {
    lines.push("## 关键结论（带原文时间戳）", "");
    for (const claim of result.claims) {
      const refs = claim.citations
        .map((c) => `${formatDurationFrames(c.startFrame)} (${c.segmentId})`)
        .join("、");
      lines.push(`- ${claim.text}（出处：${refs}）`);
    }
    lines.push("");
  }

  if (result.reminderCandidates.length > 0) {
    lines.push("## 提及的行动项（待人工确认，未自动建提醒）", "");
    for (const item of result.reminderCandidates) {
      const time = item.suggestedTimeText ? `（原文时间：${item.suggestedTimeText}）` : "";
      lines.push(`- ${item.text}${time}`);
    }
    lines.push("");
  }

  lines.push("## 带时间戳逐字稿", "");
  for (const seg of result.segments) {
    const stamp = formatDurationFrames(seg.startFrame);
    const speaker = seg.speakerLocalId ? ` [${seg.speakerLocalId}·待确认]` : "";
    lines.push(`- **${stamp}**${speaker}：${seg.text}`);
  }
  lines.push("");
  return lines.join("\n");
}

export async function deliverRecordingResult(input: {
  tenant: Tenant;
  route: RecordingRoute;
  result: RecordingResultPayload;
}): Promise<RecordingDeliveryReceipt> {
  const deliveryKey = input.result.delivery.deliveryKey;
  const coverageTag = input.result.coverage === "partial" ? "（部分内容）" : "";
  const claimsPreview = input.result.claims
    .slice(0, 3)
    .map((c) => {
      const firstRef = c.citations[0] ? formatDurationFrames(c.citations[0].startFrame) : "";
      return `• ${firstRef ? `[${firstRef}] ` : ""}${c.text}`;
    })
    .join("\n");

  const memoryNotice =
    input.result.memoryCandidates.length > 0
      ? `\n\n待你确认的记忆建议：${input.result.memoryCandidates.length} 条（请到录音详情页手动确认，不会自动写入）`
      : "";
  const reminderNotice =
    input.result.reminderCandidates.length > 0
      ? `\n提及的行动项：${input.result.reminderCandidates.length} 条（未自动创建提醒）`
      : "";

  let workspaceBatchId: string | undefined;
  let workspaceKey: string | undefined;

  if (input.route.kind === "workspace" && input.route.workspaceId) {
    const host = buildDropTenantHost({
      id: input.tenant.id,
      stateDir: input.tenant.stateDir,
      workspaceRoot: input.tenant.workspaceRoot,
      name: input.tenant.name,
    });
    const md = renderRecordingMarkdown(input.result);
    const fileName = safeMarkdownFileName(input.result.title, input.result.sessionId);
    const submitted = submitDirectIngestBatch(host, {
      workspaceKeyOrId: input.route.workspaceId,
      tokenId: "dt_recording_auto_delivery",
      submitterName: "长录音自动整理",
      note: `录音整理归档：${input.result.title}（session=${input.result.sessionId}）`,
      files: [{ fileName, data: Buffer.from(md, "utf8") }],
    });
    if (!submitted.ok) {
      return {
        status: "failed",
        deliveryKey,
        error: `归档到目标工作区失败：${submitted.error}`,
      };
    }
    workspaceBatchId = submitted.batchId;
    workspaceKey = submitted.workspaceKey;
  }

  const inboxBody = [
    input.result.summary,
    claimsPreview ? `\n要点出处：\n${claimsPreview}` : "",
    workspaceKey ? `\n已归档工作区：${workspaceKey}（批次 ${workspaceBatchId}）` : "",
    memoryNotice,
    reminderNotice,
  ]
    .filter(Boolean)
    .join("");

  const posted = postInbox(input.tenant, {
    kind: "brief",
    key: `recording:${deliveryKey}`,
    title: `录音整理完成${coverageTag}：${input.result.title}`,
    body: inboxBody,
    attention: input.result.memoryCandidates.length > 0 ? "suggestion" : "content",
  });

  return {
    status: "acknowledged",
    deliveryKey,
    targetReceipt: workspaceBatchId ? `kb:${workspaceBatchId}|inbox:${posted.item.id}` : `inbox:${posted.item.id}`,
    ackAt: new Date().toISOString(),
    workspaceBatchId,
    workspaceKey,
    inboxItemId: posted.item.id,
  };
}
