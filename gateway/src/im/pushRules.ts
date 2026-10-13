// IM 推送规则（纯函数）：什么时候发、发什么。真正发送走 assistant/apns.ts 的 sendApns(channel "im")
import type { ImFileBody, ImLinkBody, ImLocationBody, ImTextBody, ImVoiceBody } from "../../../shared/protocol.ts";
import type { ApnsMessage, BadgeParts } from "../assistant/apns.ts";
import { imCollapseId, imThreadId } from "./ids.ts";
import type { StoredMessage } from "./store.ts";

export const PREVIEW_CHARS = 60;
/** 每个收件人记最近这么多条推过 alert 的消息；撤回窗口只有 2 分钟，10 分钟足够 */
export const PUSHED_PER_USER = 500;
export const PUSHED_TTL_MS = 10 * 60_000;

/**
 * 推过 alert 的消息（只在内存，重启忘掉可以接受）：撤回时只有在这里的才发同 collapse-id 的替换通知，
 * 免得「前台收到、后来退后台再被撤回」凭空冒出一条通知
 */
export class RecentPushes {
  private readonly byUser = new Map<string, Map<string, number>>();
  private readonly limit: number;
  private readonly ttlMs: number;

  constructor(limit = PUSHED_PER_USER, ttlMs = PUSHED_TTL_MS) {
    this.limit = limit;
    this.ttlMs = ttlMs;
  }

  mark(tenantId: string, convId: string, seq: number, now: number) {
    const entries = this.byUser.get(tenantId) ?? new Map<string, number>();
    this.byUser.set(tenantId, entries);
    const key = `${convId}#${seq}`;
    entries.delete(key);
    entries.set(key, now);
    // Map 按插入顺序 = 按时间：从最旧的开始丢过期的和超出条数的
    for (const [oldKey, at] of entries) {
      if (entries.size <= this.limit && now - at <= this.ttlMs) break;
      entries.delete(oldKey);
    }
  }

  /** 推过且没过期就返回 true，并忘掉它（一条只替换一次） */
  take(tenantId: string, convId: string, seq: number, now: number): boolean {
    const entries = this.byUser.get(tenantId);
    const key = `${convId}#${seq}`;
    const at = entries?.get(key);
    if (at === undefined) return false;
    entries?.delete(key);
    return now - at <= this.ttlMs;
  }

  size(tenantId: string) {
    return this.byUser.get(tenantId)?.size ?? 0;
  }
}

/** notifyPreview=true 时的通知正文 */
export function imPreviewText(message: Pick<StoredMessage, "kind" | "body">): string {
  switch (message.kind) {
    case "text": {
      const chars = Array.from((message.body as ImTextBody).text.replace(/\s+/g, " ").trim());
      return chars.length > PREVIEW_CHARS ? `${chars.slice(0, PREVIEW_CHARS).join("")}…` : chars.join("");
    }
    case "image":
      return "[图片]";
    case "voice":
      return `[语音] ${Math.max(1, Math.round((message.body as ImVoiceBody).durationMs / 1000))}″`;
    case "file":
      return `[文件] ${(message.body as ImFileBody).name}`;
    case "link": {
      const body = message.body as ImLinkBody;
      let host = body.url;
      try {
        host = new URL(body.url).hostname;
      } catch {
        // 校验过的 url 一定能解析，这里只是兜底
      }
      return `[链接] ${body.title || host}`;
    }
    case "location": {
      const body = message.body as ImLocationBody;
      return `[位置] ${body.name || body.address}`;
    }
  }
}

export type ImAlertInput = {
  convId: string;
  message: StoredMessage;
  senderNickname: string;
  /** 收件人的偏好：通知里显示正文 */
  notifyPreview: boolean;
  /** 收件人这个会话的未读（含这一条） */
  convUnread: number;
  /** 角标分部：IM 未读合计 + 助理待处理数；设备按自己订阅的类别合计（apnsBadgeFor） */
  badgeParts: BadgeParts;
  /** 收件人有 caps 含 im 且在前台的在线连接 */
  foregroundOnline: boolean;
  muted: boolean;
  /** 被收件人拉黑：这条对他不可见 */
  rejected: boolean;
};

/** 新消息通知；不该发时返回 null */
export function imAlertFor(input: ImAlertInput): ApnsMessage | null {
  if (input.foregroundOnline || input.muted || input.rejected) return null;
  const { convId, message } = input;
  const body = input.notifyPreview
    ? imPreviewText(message)
    : input.convUnread > 1
      ? `发来 ${input.convUnread} 条消息`
      : "发来一条消息";
  return {
    itemId: `${convId}#${message.seq}`,
    kind: "im",
    title: input.senderNickname,
    body,
    channel: "im",
    threadId: imThreadId(convId),
    collapseId: imCollapseId(convId, message.seq),
    priority: 10,
    pushType: "alert",
    badgeParts: input.badgeParts,
    cr: { kind: "im", convId, seq: message.seq },
    redactLog: true,
  };
}

/** 撤回：用同一个 collapse-id 替换掉之前那条通知 */
export function imRecallAlert(
  convId: string,
  seq: number,
  senderNickname: string,
  badgeParts: BadgeParts,
): ApnsMessage {
  return {
    itemId: `${convId}#${seq}`,
    kind: "im",
    title: senderNickname,
    body: "撤回了一条消息",
    channel: "im",
    threadId: imThreadId(convId),
    collapseId: imCollapseId(convId, seq),
    priority: 10,
    pushType: "alert",
    badgeParts,
    cr: { kind: "im", convId, seq },
    redactLog: true,
  };
}

/** 读过之后的静默推送：其他设备据此清通知、更新角标 */
export function imReadPush(convId: string, badgeParts: BadgeParts): ApnsMessage {
  return {
    itemId: `${convId}#read`,
    kind: "im_read",
    title: "",
    body: "",
    channel: "im",
    pushType: "background",
    priority: 5,
    sound: null,
    badgeParts,
    cr: { kind: "im_read", convId },
    redactLog: true,
  };
}
