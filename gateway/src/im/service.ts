// IM 业务：联系人、会话列表、历史、收发、撤回、已读、设置、资料、拉黑、下载鉴权。
// 不认识 WebSocket：在线连接、推送、租户名单都从 deps 注入，测试用假连接即可。
// 对调用者不可见的消息（他拉黑对方时被拒收的）在所有操作里都等同于不存在：同一个错误码和文案，
// seq 上限一律用他可见的 maxSeq。
import type {
  ClientMessage,
  ImConvRow,
  ImFileBody,
  ImMe,
  ImMessage,
  ImUser,
  ServerMessage,
} from "../../../shared/protocol.ts";
import type { ApnsMessage, BadgeParts } from "../assistant/apns.ts";
import { log } from "../log.ts";
import { blobsOf, checkBody, isBlobId, type BlobUse } from "./body.ts";
import { ImError } from "./errors.ts";
import { dmConvId, imVisible, parseDmConvId, type ImPeer } from "./ids.ts";
import { compareKeys, decodeCursor, encodeCursor, rowKey } from "./listCursor.ts";
import { imAlertFor, imReadPush, imRecallAlert, RecentPushes } from "./pushRules.ts";
import {
  emptySettings,
  type BlobKind,
  type BlobMeta,
  type Conv,
  type ConvSettings,
  type ImStore,
  type StoredMessage,
  type UserState,
} from "./store.ts";
import { AVATARS_SCOPE, imTicket } from "./ticket.ts";

export const RATE_LIMIT_PER_MIN = 30;
export const RECALL_WINDOW_MS = 2 * 60_000;
export const HISTORY_DEFAULT = 30;
export const HISTORY_MAX = 50;
export const LIST_DEFAULT = 50;
export const LIST_MAX = 100;
const NICKNAME_MAX = 32;
const CLIENT_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const NO_MESSAGE = "消息不存在";
const NO_BLOB = "附件不存在，先上传";

/** 一条在线连接：key 用来认出发起请求的那条（不给它重复发） */
export type ImLiveConn = {
  key: unknown;
  tenantId: string;
  foreground: boolean;
  send: (message: ServerMessage) => void;
};

export type ImDeps = {
  store: ImStore;
  tenants: () => ImPeer[];
  secret: () => string;
  /** caps 含 "im" 的在线连接 */
  conns: () => Iterable<ImLiveConn>;
  /** 给某租户的 im 订阅发 APNs；不等结果 */
  push: (tenantId: string, message: ApnsMessage) => void;
  /** 该租户助理待处理数（未读收件箱 + 待批），和 App 里助理入口的角标同一口径；拿不到时 undefined（角标分量不带） */
  assistantBadge?: (tenantId: string) => Promise<number | undefined>;
  workspaceBadge?: (tenantId: string) => Promise<number | undefined>;
  now?: () => number;
};

type Msg<T extends ClientMessage["type"]> = Extract<ClientMessage, { type: T }>;
type Out<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;

const isInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);
const thresholdOf = (settings: ConvSettings) => Math.max(settings.readSeq, settings.hideBefore);

export class ImService {
  private readonly deps: ImDeps;
  private readonly store: ImStore;
  private readonly sends = new Map<string, number[]>();
  private readonly pushed = new RecentPushes();

  constructor(deps: ImDeps) {
    this.deps = deps;
    this.store = deps.store;
  }

  private now() {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private peer(id: string): ImPeer | undefined {
    return this.deps.tenants().find((item) => item.id === id);
  }

  private async me(id: string): Promise<ImPeer> {
    await this.store.ready();
    const me = this.peer(id);
    if (!me) throw new ImError("not_found", "找不到当前用户");
    return me;
  }

  /** 对方存在且可见；不可见和不存在回同一个错误，不暴露隐藏账号 */
  private visiblePeer(me: ImPeer, id: unknown): ImPeer {
    const peer = typeof id === "string" ? this.peer(id) : undefined;
    if (!peer || peer.id === me.id || !imVisible(me, peer)) throw new ImError("not_visible", "找不到这个用户");
    return peer;
  }

  /** 会话号合法、自己是成员、对方可见 */
  private target(me: ImPeer, convId: unknown): { convId: string; peer: ImPeer } {
    const pair = parseDmConvId(convId);
    if (!pair || !pair.includes(me.id)) throw new ImError("not_found", "会话不存在");
    const peer = this.visiblePeer(me, pair[0] === me.id ? pair[1] : pair[0]);
    return { convId: convId as string, peer };
  }

  private ticket(tenantId: string, scope: string) {
    return imTicket(this.deps.secret(), tenantId, scope, this.now());
  }

  /** 要先 await store.ready() */
  nickname(id: string): string {
    return this.store.profile(id).nickname || this.peer(id)?.name || id;
  }

  userView(id: string): ImUser {
    const profile = this.store.profile(id);
    return { id, nickname: this.nickname(id), ...(profile.avatar ? { avatar: profile.avatar } : {}) };
  }

  async meView(id: string): Promise<ImMe> {
    return { ...this.userView(id), notifyPreview: (await this.store.user(id)).notifyPreview };
  }

  /** viewer 看到的样子；被他拉黑拒收的返回 null */
  view(convId: string, row: StoredMessage, viewer: string): ImMessage | null {
    if (row.rejectedFor?.includes(viewer)) return null;
    const out: ImMessage = {
      convId,
      seq: row.seq,
      from: row.from,
      at: row.at,
      kind: row.kind,
      clientId: row.clientId,
    };
    if (row.recalledAt !== undefined) out.recalled = true;
    else out.body = row.body;
    if (row.replyTo !== undefined) out.replyTo = row.replyTo;
    if (row.from === viewer && row.rejectedFor?.length) out.rejected = true;
    return out;
  }

  /** viewer 可见的那一条；不存在和不可见都返回 null */
  private async visibleRow(conv: Conv | null, viewer: string, seq: unknown): Promise<StoredMessage | null> {
    if (!conv || !isInt(seq)) return null;
    const row = await this.store.get(conv, seq);
    return row && !row.rejectedFor?.includes(viewer) ? row : null;
  }

  /**
   * 等改动落盘再回包 / 广播：写失败回 internal，改动留在内存里由 store 稍后重试
   * （客户端看到失败可以重发同样的设置，幂等）
   */
  private async persist(saving: Promise<void>) {
    try {
      await saving;
    } catch {
      throw new ImError("internal", "保存失败，网关稍后会自动重试");
    }
  }

  private persistUser(id: string) {
    return this.persist(this.store.saveUser(id));
  }

  private settingsIn(user: UserState, convId: string): ConvSettings {
    return user.convs[convId] ?? emptySettings();
  }

  private ensureSettings(user: UserState, convId: string): ConvSettings {
    user.convs[convId] ??= emptySettings();
    return user.convs[convId];
  }

  /** 未读：readSeq / hideBefore 之后、别人发的、自己可见且没撤回的（只读 index） */
  async unread(viewer: string, convId: string): Promise<number> {
    const conv = await this.store.open(convId);
    if (!conv) return 0;
    return this.store.unread(conv, viewer, thresholdOf(this.settingsIn(await this.store.user(viewer), convId)));
  }

  /** 角标：所有（对方仍可见的）会话未读合计（只读 index） */
  async badge(viewer: string): Promise<number> {
    await this.store.ready();
    const me = this.peer(viewer);
    if (!me) return 0;
    const user = await this.store.user(viewer);
    let total = 0;
    for (const conv of await this.store.convsOf(viewer)) {
      const peerId = conv.meta.members.find((id) => id !== viewer);
      const peer = peerId ? this.peer(peerId) : undefined;
      if (!peer || !imVisible(me, peer)) continue;
      total += this.store.unread(conv, viewer, thresholdOf(this.settingsIn(user, conv.meta.convId)));
    }
    return total;
  }

  /** APNs 角标分部：IM 未读合计 + 助理待处理数（哪个分量拿不到就是 undefined）。
   *  设备按自己订阅的类别合计（apnsBadgeFor）：只订阅聊天的 iPad 不算助理待处理，助理变化不会推给它 */
  async pushBadge(viewer: string): Promise<BadgeParts> {
    const assistant = this.deps.assistantBadge
      ? this.deps.assistantBadge(viewer).catch(() => undefined)
      : Promise.resolve(undefined);
    const workspace = this.deps.workspaceBadge
      ? this.deps.workspaceBadge(viewer).catch(() => undefined)
      : Promise.resolve(undefined);
    const [im, extra, workspaceUnread] = await Promise.all([this.badge(viewer), assistant, workspace]);
    return { im, assistant: extra, ...(workspaceUnread === undefined ? {} : { workspace: workspaceUnread }) };
  }

  /** 这些租户各自在这个会话的未读，随更新下发给他们（客户端只用这个权威值，不自己推算） */
  private async unreadOf(tenantIds: string[], convId: string): Promise<Map<string, number>> {
    const pairs = await Promise.all(tenantIds.map(async (id) => [id, await this.unread(id, convId)] as const));
    return new Map(pairs);
  }

  /** 发给这些租户的在线 im 连接；except 是发起请求那条连接的 key */
  private fanout(tenantIds: string[], build: (tenantId: string) => ServerMessage | null, except?: unknown) {
    const built = new Map<string, ServerMessage | null>();
    for (const conn of this.deps.conns()) {
      if (conn.key === except || !tenantIds.includes(conn.tenantId)) continue;
      if (!built.has(conn.tenantId)) built.set(conn.tenantId, build(conn.tenantId));
      const message = built.get(conn.tenantId);
      if (message) conn.send(message);
    }
  }

  private foregroundOnline(tenantId: string): boolean {
    for (const conn of this.deps.conns()) if (conn.tenantId === tenantId && conn.foreground) return true;
    return false;
  }

  /* ── 读 ── */

  async contacts(meId: string): Promise<Out<"im_contacts">> {
    const me = await this.me(meId);
    const users = this.deps
      .tenants()
      .filter((item) => item.id !== me.id && imVisible(me, item))
      .map((item) => this.userView(item.id))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return {
      type: "im_contacts",
      me: await this.meView(me.id),
      users,
      avatarTicket: this.ticket(me.id, AVATARS_SCOPE),
    };
  }

  async list(meId: string, message: Partial<Msg<"im_list">> = {}): Promise<Out<"im_list">> {
    const me = await this.me(meId);
    if (message.limit !== undefined && !(isInt(message.limit) && message.limit >= 1)) {
      throw new ImError("bad_body", "limit 必须是正整数");
    }
    const after = message.cursor !== undefined && message.cursor !== null ? decodeCursor(String(message.cursor)) : null;
    if (message.cursor !== undefined && message.cursor !== null && !after) throw new ImError("bad_body", "cursor 不对");
    const limit = Math.min(LIST_MAX, message.limit ?? LIST_DEFAULT);
    const user = await this.store.user(me.id);
    const rows: ImConvRow[] = [];
    for (const conv of await this.store.convsOf(me.id)) {
      const { convId } = conv.meta;
      const peerId = conv.meta.members.find((id) => id !== me.id);
      const peer = peerId ? this.peer(peerId) : undefined;
      if (!peer || !imVisible(me, peer)) continue;
      const settings = this.settingsIn(user, convId);
      const maxSeq = this.store.visibleMax(conv, me.id);
      if (!maxSeq) continue;
      const lastRow = maxSeq > settings.hideBefore ? await this.store.get(conv, maxSeq) : null;
      const last = lastRow ? this.view(convId, lastRow, me.id) : null;
      rows.push({
        convId,
        peer: peer.id,
        ...(last ? { last } : {}),
        unread: this.store.unread(conv, me.id, thresholdOf(settings)),
        readSeq: settings.readSeq,
        maxSeq,
        pin: settings.pin,
        mute: settings.mute,
        hideBefore: settings.hideBefore,
        ticket: this.ticket(me.id, convId),
      });
    }
    rows.sort((a, b) => compareKeys(rowKey(a), rowKey(b)));
    const rest = after ? rows.filter((row) => compareKeys(rowKey(row), after) > 0) : rows;
    const convs = rest.slice(0, limit);
    const more = rest.length > convs.length;
    return {
      type: "im_list",
      convs,
      blocked: [...user.blocked],
      more,
      ...(more && convs.length ? { cursor: encodeCursor(rowKey(convs[convs.length - 1])) } : {}),
    };
  }

  async history(meId: string, message: Msg<"im_history">): Promise<Out<"im_history">> {
    const me = await this.me(meId);
    const { convId } = this.target(me, message.convId);
    for (const key of ["before", "after", "limit"] as const) {
      const value = message[key];
      if (value !== undefined && value !== null && !(isInt(value) && value >= 0)) {
        throw new ImError("bad_body", `${key} 必须是非负整数`);
      }
    }
    const limit = Math.min(HISTORY_MAX, Math.max(1, message.limit || HISTORY_DEFAULT));
    const conv = await this.store.open(convId);
    const floor = this.settingsIn(await this.store.user(me.id), convId).hideBefore;
    const before = isInt(message.before) ? message.before : undefined;
    const after = isInt(message.after) ? message.after : undefined;
    const messages: ImMessage[] = [];
    let more = false;
    if (conv) {
      // 上界用自己可见的 maxSeq：它之后全是自己拒收的，不用看
      const top = this.store.visibleMax(conv, me.id);
      const end = before !== undefined ? Math.min(before - 1, top) : top;
      const page =
        after !== undefined
          ? await this.store.visibleRange(conv, me.id, Math.max(after, floor) + 1, end, limit, false)
          : await this.store.visibleRange(conv, me.id, floor + 1, end, limit, true);
      for (const row of page.rows) {
        const view = this.view(convId, row, me.id);
        if (view) messages.push(view);
      }
      more = page.more;
    }
    return {
      type: "im_history",
      convId,
      messages,
      more,
      ticket: this.ticket(me.id, convId),
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
    };
  }

  /* ── 写 ── */

  private ack(convId: string, row: StoredMessage): Out<"im_ack"> {
    return {
      type: "im_ack",
      clientId: row.clientId,
      convId,
      seq: row.seq,
      at: row.at,
      ...(row.rejectedFor?.length ? { rejected: true } : {}),
    };
  }

  /** 占一个限流名额；失败时 release 退回 */
  private reserve(meId: string, now: number) {
    const recent = (this.sends.get(meId) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= RATE_LIMIT_PER_MIN) {
      this.sends.set(meId, recent);
      throw new ImError("rate_limited", "发得太快了，稍等一会儿再发");
    }
    recent.push(now);
    this.sends.set(meId, recent);
  }

  private release(meId: string, at: number) {
    const recent = this.sends.get(meId);
    const index = recent?.indexOf(at) ?? -1;
    if (recent && index >= 0) recent.splice(index, 1);
  }

  /**
   * 这个会话里有没有一条引用对 viewer 算授权：双方仍互相可见、消息对他可见、没撤回、消息确实按这个用途引用了它。
   * 只看这个会话的引用，从新到旧，找到一条就停。返回那条引用的用途
   */
  private async usableIn(viewer: ImPeer, sha: string, convId: string): Promise<BlobKind | null> {
    const pair = parseDmConvId(convId);
    if (!pair || !pair.includes(viewer.id)) return null;
    const peer = this.peer(pair[0] === viewer.id ? pair[1] : pair[0]);
    if (!peer || !imVisible(viewer, peer)) return null;
    const conv = await this.store.open(convId);
    if (!conv) return null;
    const refs = await this.store.refsIn(sha, convId);
    for (let i = refs.length - 1; i >= 0; i -= 1) {
      const ref = refs[i];
      const row = await this.visibleRow(conv, viewer.id, ref.seq);
      if (!row || row.recalledAt !== undefined) continue;
      if (blobsOf(row.kind, row.body).some((use) => use.sha === sha && use.kind === ref.kind)) return ref.kind;
    }
    return null;
  }

  /**
   * 引用的附件必须存在、按这个字段的用途上传过，且是自己上传的或在自己可见的消息里出现过（转发）。
   * file 的 mime / size 以网关记录为准
   */
  private async checkBlobs(me: ImPeer, uses: BlobUse[]): Promise<BlobMeta[]> {
    const metas: BlobMeta[] = [];
    for (const use of uses) {
      const meta = await this.store.blobMeta(use.sha);
      let usable = Boolean(meta && meta.uploaders.includes(me.id));
      if (meta && !usable) {
        for (const convId of await this.store.refConvs(use.sha)) {
          if (!parseDmConvId(convId)?.includes(me.id)) continue;
          if (await this.usableIn(me, use.sha, convId)) {
            usable = true;
            break;
          }
        }
      }
      if (!meta || !usable) throw new ImError("not_found", NO_BLOB);
      if (!meta.kinds[use.kind])
        throw new ImError("bad_body", `附件用途不对：这里要 ${use.kind}，按这个 kind 重新上传`);
      metas.push(meta);
    }
    return metas;
  }

  /** 去重命中或刚提交：补做幂等的副作用（附件引用、投递）。客户端按 convId+seq 去重，重复投递无害 */
  private async settle(convId: string, peer: string, row: StoredMessage, origin: unknown) {
    for (const use of blobsOf(row.kind, row.body)) {
      await this.store.addBlobRef(use.sha, { convId, seq: row.seq, kind: use.kind });
    }
    const audience = row.rejectedFor?.length ? [row.from] : [row.from, peer];
    const unread = await this.unreadOf(audience, convId);
    this.fanout(
      audience,
      (tenantId) => {
        const view = this.view(convId, row, tenantId);
        return view
          ? {
              type: "im_message",
              message: view,
              ticket: this.ticket(tenantId, convId),
              unread: unread.get(tenantId) ?? 0,
            }
          : null;
      },
      origin,
    );
  }

  /**
   * 发送顺序（在 serial(convId) 里）：
   *   1. 去重：同一发件人的 clientId 已提交 → 补做附件引用和投递，回原 ack
   *   2. 校验（replyTo、附件用途）；都过了才建会话（新会话），确定 seq = maxSeq + 1
   *   3. 先写附件引用 {convId, seq, kind}（幂等；没提交成功时这条引用指向的 seq 上不会有引用它的消息，
   *      下载鉴权会核对消息内容，所以悬空引用不授权任何东西）
   *   4. 追加消息行 —— 提交点。meta.maxSeq / index 写失败也能从 jsonl 修复，去重表已在内存里登记
   *   5. 投递、推送（失败不影响已提交）
   */
  async send(meId: string, origin: unknown, message: Msg<"im_send">): Promise<Out<"im_ack">> {
    const me = await this.me(meId);
    if (typeof message.clientId !== "string" || !CLIENT_ID_RE.test(message.clientId)) {
      throw new ImError("bad_body", "clientId 不合法（1–64 位字母数字或 _.:-）");
    }
    let target: { convId: string; peer: ImPeer };
    if (message.to !== undefined && message.to !== null) {
      const peer = this.visiblePeer(me, message.to);
      target = { convId: dmConvId(me.id, peer.id), peer };
      if (message.convId !== undefined && message.convId !== null && message.convId !== target.convId) {
        throw new ImError("bad_body", "to 和 convId 对不上");
      }
    } else {
      target = this.target(me, message.convId);
    }
    const { convId, peer } = target;
    const clientId = message.clientId;
    const existing = await this.store.open(convId);
    const early = existing ? this.store.byClientId(existing, me.id, clientId) : null;
    if (early) {
      await this.settle(convId, peer.id, early, origin);
      return this.ack(convId, early);
    }

    const checked = checkBody(message.kind, message.body);
    const now = this.now();
    this.reserve(me.id, now);
    let fresh = false;
    let row: StoredMessage;
    try {
      row = await this.store.serial(convId, async () => {
        const opened = await this.store.open(convId);
        const dup = opened ? await this.store.findClient(opened, me.id, clientId) : null;
        if (dup) return dup;
        if (message.replyTo !== undefined && message.replyTo !== null) {
          if (!(await this.visibleRow(opened, me.id, message.replyTo))) {
            throw new ImError("bad_body", "replyTo 不是这个会话里的消息");
          }
        }
        const metas = await this.checkBlobs(me, checked.blobs);
        if (checked.kind === "file") {
          const body = checked.body as ImFileBody;
          body.size = metas[0].size;
          body.mime = metas[0].kinds.file ?? body.mime;
        }
        const rejected = (await this.store.user(peer.id)).blocked.includes(me.id);
        // 校验都过了才建会话：失败的请求不留下空会话
        const conv = opened ?? (await this.store.ensure(convId, [me.id, peer.id], now));
        const seq = this.store.nextSeq(conv);
        try {
          for (const use of checked.blobs) {
            await this.store.addBlobRef(use.sha, { convId, seq, kind: use.kind });
          }
          const stored = await this.store.append(conv, {
            from: me.id,
            at: now,
            kind: checked.kind,
            body: checked.body,
            ...(isInt(message.replyTo) ? { replyTo: message.replyTo } : {}),
            clientId,
            ...(rejected ? { rejectedFor: [peer.id] } : {}),
          });
          fresh = true;
          return stored;
        } catch (err) {
          // 一条消息都没写成的会话不留下
          await this.store.dropIfEmpty(conv);
          throw err;
        }
      });
    } catch (err) {
      this.release(me.id, now);
      throw err;
    }
    if (!fresh) {
      this.release(me.id, now);
      await this.settle(convId, peer.id, row, origin);
      return this.ack(convId, row);
    }
    log.info("im send", convId, row.seq, row.kind, row.rejectedFor ? "rejected" : "");
    await this.settle(convId, peer.id, row, origin);
    if (!row.rejectedFor) await this.maybePush(convId, peer.id, row);
    return this.ack(convId, row);
  }

  private async maybePush(convId: string, recipient: string, row: StoredMessage) {
    if (this.foregroundOnline(recipient)) return;
    const user = await this.store.user(recipient);
    if (this.settingsIn(user, convId).mute) return;
    const alert = imAlertFor({
      convId,
      message: row,
      senderNickname: this.nickname(row.from),
      notifyPreview: user.notifyPreview,
      convUnread: await this.unread(recipient, convId),
      badgeParts: await this.pushBadge(recipient),
      foregroundOnline: false,
      muted: false,
      rejected: false,
    });
    if (!alert) return;
    this.deps.push(recipient, alert);
    this.pushed.mark(recipient, convId, row.seq, this.now());
  }

  async recall(meId: string, origin: unknown, message: Msg<"im_recall">): Promise<Out<"im_update">> {
    const me = await this.me(meId);
    const { convId, peer } = this.target(me, message.convId);
    const now = this.now();
    const { update, row, changed } = await this.store.serial(convId, async () => {
      const conv = await this.store.open(convId);
      const row = await this.visibleRow(conv, me.id, message.seq);
      if (!conv || !row) throw new ImError("not_found", NO_MESSAGE);
      if (row.from !== me.id) throw new ImError("forbidden", "只能撤回自己发的消息");
      const update: Out<"im_update"> = { type: "im_update", what: "recall", convId, seq: row.seq };
      if (row.recalledAt !== undefined) return { update, row, changed: false };
      if (now - row.at > RECALL_WINDOW_MS) throw new ImError("recall_expired", "超过 2 分钟，不能撤回了");
      await this.store.recall(conv, row, now);
      return { update, row, changed: true };
    });
    if (!changed) return { ...update, unread: await this.unread(me.id, convId) };
    const peerSees = !row.rejectedFor?.includes(peer.id);
    const audience = peerSees ? [me.id, peer.id] : [me.id];
    // 撤回的那条不再算未读：每个人带自己的未读
    const unread = await this.unreadOf(audience, convId);
    this.fanout(audience, (tenantId) => ({ ...update, unread: unread.get(tenantId) ?? 0 }), origin);
    // 只替换确实推过的通知（同一个 collapse-id）；没推过的（当时在前台、免打扰）不发，网关重启后忘掉的也不发
    if (peerSees && this.pushed.take(peer.id, convId, row.seq, now)) {
      this.deps.push(peer.id, imRecallAlert(convId, row.seq, this.nickname(me.id), await this.pushBadge(peer.id)));
    }
    return { ...update, unread: unread.get(me.id) ?? 0 };
  }

  /** readSeq 推到 min(seq, 自己可见的 maxSeq)；没前进就什么都不做 */
  async read(meId: string, origin: unknown, message: Msg<"im_read">): Promise<null> {
    const me = await this.me(meId);
    const { convId } = this.target(me, message.convId);
    if (!isInt(message.seq) || message.seq < 0) throw new ImError("bad_body", "seq 必须是非负整数");
    const user = await this.store.user(me.id);
    const moved = await this.store.serial(convId, async () => {
      const conv = await this.store.open(convId);
      if (!conv) return null;
      const target = Math.min(message.seq, this.store.visibleMax(conv, me.id));
      const settings = this.ensureSettings(user, convId);
      if (target <= settings.readSeq) return null;
      settings.readSeq = target;
      return target;
    });
    if (moved === null) return null;
    // 未读由 readSeq 现算；落盘后才裁内存窗口、同步给其他设备
    await this.persistUser(me.id);
    const conv = await this.store.open(convId);
    if (conv) this.store.trimUnread(conv, me.id, thresholdOf(this.settingsIn(user, convId)));
    const unread = await this.unread(me.id, convId);
    this.fanout([me.id], () => ({ type: "im_update", what: "read", convId, seq: moved, unread }), origin);
    this.deps.push(me.id, imReadPush(convId, await this.pushBadge(me.id)));
    return null;
  }

  async settings(meId: string, origin: unknown, message: Msg<"im_settings">): Promise<Out<"im_update">> {
    const me = await this.me(meId);
    const { convId } = this.target(me, message.convId);
    for (const key of ["pin", "mute"] as const) {
      if (message[key] !== undefined && typeof message[key] !== "boolean") {
        throw new ImError("bad_body", `${key} 必须是布尔值`);
      }
    }
    if (message.hideBefore !== undefined && !(isInt(message.hideBefore) && message.hideBefore >= 0)) {
      throw new ImError("bad_body", "hideBefore 必须是非负整数");
    }
    const user = await this.store.user(me.id);
    const { settings, readMoved } = await this.store.serial(convId, async () => {
      const settings = this.ensureSettings(user, convId);
      if (typeof message.pin === "boolean") settings.pin = message.pin;
      if (typeof message.mute === "boolean") settings.mute = message.mute;
      let readMoved = false;
      if (isInt(message.hideBefore)) {
        const conv = await this.store.open(convId);
        const visibleMax = conv ? this.store.visibleMax(conv, me.id) : 0;
        settings.hideBefore = Math.max(settings.hideBefore, Math.min(message.hideBefore, visibleMax));
        if (settings.readSeq < settings.hideBefore) {
          settings.readSeq = settings.hideBefore;
          readMoved = true;
        }
      }
      return { settings: { ...settings }, readMoved };
    });
    await this.persistUser(me.id);
    const update: Out<"im_update"> = {
      type: "im_update",
      what: "settings",
      convId,
      pin: settings.pin,
      mute: settings.mute,
      hideBefore: settings.hideBefore,
      unread: await this.unread(me.id, convId),
    };
    this.fanout([me.id], () => update, origin);
    if (readMoved) this.deps.push(me.id, imReadPush(convId, await this.pushBadge(me.id)));
    return update;
  }

  async profile(meId: string, origin: unknown, message: Msg<"im_profile">): Promise<Out<"im_update">> {
    const me = await this.me(meId);
    // 先把所有校验（含异步查 blob）做完，再在 profile:<id> 里把这次带的字段合并进最新的资料：
    // 并发的「改昵称」和「换头像」谁也不会用旧副本覆盖谁
    let nickname: string | undefined;
    if (message.nickname !== undefined) {
      nickname = typeof message.nickname === "string" ? message.nickname.replace(/\s+/g, " ").trim() : "";
      const length = Array.from(nickname).length;
      if (!length || length > NICKNAME_MAX) throw new ImError("bad_body", `昵称要 1–${NICKNAME_MAX} 个字`);
    }
    let avatar: string | null | undefined;
    if (message.avatar !== undefined) {
      if (message.avatar === null || message.avatar === "") avatar = null;
      else {
        if (!isBlobId(message.avatar)) throw new ImError("bad_body", "avatar 不是有效的 blob");
        const blob = await this.store.blobMeta(message.avatar);
        if (!blob || !blob.uploaders.includes(me.id)) throw new ImError("not_found", "头像不存在，先上传");
        if (!blob.kinds.avatar) throw new ImError("bad_body", "头像要按 kind=avatar 上传");
        avatar = message.avatar;
      }
    }
    if (message.notifyPreview !== undefined && typeof message.notifyPreview !== "boolean") {
      throw new ImError("bad_body", "notifyPreview 必须是布尔值");
    }
    const user = await this.store.user(me.id);
    const { before, view } = await this.store.serial(`profile:${me.id}`, async () => {
      const before = JSON.stringify(this.userView(me.id));
      const profile = { ...this.store.profile(me.id) };
      if (nickname !== undefined) profile.nickname = nickname;
      if (avatar === null) delete profile.avatar;
      else if (avatar !== undefined) profile.avatar = avatar;
      const writes: Promise<void>[] = [];
      if (typeof message.notifyPreview === "boolean" && user.notifyPreview !== message.notifyPreview) {
        user.notifyPreview = message.notifyPreview;
        writes.push(this.store.saveUser(me.id));
      }
      if (JSON.stringify(profile) !== JSON.stringify(this.store.profile(me.id))) {
        writes.push(this.store.setProfile(me.id, profile));
      }
      await this.persist(Promise.all(writes).then(() => undefined));
      return { before, view: this.userView(me.id) };
    });
    const prefs: Out<"im_update"> = { type: "im_update", what: "prefs", me: await this.meView(me.id) };
    this.fanout([me.id], () => prefs, origin);
    if (JSON.stringify(view) !== before) {
      const audience = this.deps
        .tenants()
        .filter((item) => item.id !== me.id && imVisible(me, item))
        .map((item) => item.id);
      this.fanout(audience, (tenantId) => ({
        type: "im_update",
        what: "profile",
        user: view,
        avatarTicket: this.ticket(tenantId, AVATARS_SCOPE),
      }));
    }
    return prefs;
  }

  async block(meId: string, origin: unknown, message: Msg<"im_block">): Promise<Out<"im_update">> {
    const me = await this.me(meId);
    const peer = this.visiblePeer(me, message.tenantId);
    if (typeof message.on !== "boolean") throw new ImError("bad_body", "on 必须是布尔值");
    const user = await this.store.user(me.id);
    const rest = user.blocked.filter((id) => id !== peer.id);
    user.blocked = message.on ? [...rest, peer.id] : rest;
    await this.persistUser(me.id);
    const update: Out<"im_update"> = { type: "im_update", what: "block", blocked: [...user.blocked] };
    this.fanout([me.id], () => update, origin);
    return update;
  }

  /**
   * /media/im 鉴权，返回该用途登记的 mime；不授权返回 null。
   * avatars：blob 是某个可见用户（含自己）的当前头像。
   * 会话号：调用者是成员、双方仍互相可见，且 blob 至少有一条引用落在这个会话里、对他可见、没撤回的消息上
   */
  async canDownload(tenantId: string, scope: string, sha: string): Promise<string | null> {
    await this.store.ready();
    const me = this.peer(tenantId);
    const meta = await this.store.blobMeta(sha);
    if (!me || !meta) return null;
    if (scope === AVATARS_SCOPE) {
      const used = this.deps
        .tenants()
        .some((item) => imVisible(me, item) && this.store.profile(item.id).avatar === sha);
      return used ? (meta.kinds.avatar ?? null) : null;
    }
    const kind = await this.usableIn(me, sha, scope);
    return kind ? (meta.kinds[kind] ?? null) : null;
  }
}
