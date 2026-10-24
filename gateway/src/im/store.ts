// IM 落盘：全局状态目录 im/ 下放会话和附件，各租户目录 im.json 放自己的会话设置。
// 全部走 fs/promises，不阻塞事件循环；改同一会话的操作经 serial(convId) 排队，seq 不会撞。
//
//   <root>/im/conversations/<convId>/meta.json      members、maxSeq、createdAt、每成员 visibleMax（小、有界，合并写）
//   <root>/im/conversations/<convId>/<NNNNN>.jsonl  每段 1000 条，追加写；撤回追加 {op:"recall",seq,at}
//                                                    到原消息所在那一段，读时合并
//   <root>/im/blobs/<sha256> + <sha256>.json        附件字节 + 固定大小的元数据：size、kinds（用途→mime）、uploaders
//   <root>/im/blobs/<sha256>.refs.jsonl             引用日志：每行 {convId, seq, kind}，只追加
//   <root>/im/profiles.json                         昵称、头像
//   <tenantDir>/im.json                             convs{readSeq,pin,mute,hideBefore}、blocked、notifyPreview
//
// 规模前提：几十个用户，单会话一生几万到几十万条。内存和打开会话的开销只和「未读窗口 + 最近一两段」成正比。
// 提交点：消息行追加进 jsonl 就算发出。meta.json 只是摘要，丢了、落后了都能从尾段修复。
// 内存里每个会话：最后一段常驻、旧分段走小 LRU、最近 2000 个 clientId，以及每个成员的未读窗口
//   incoming —— seq > max(readSeq, hideBefore) 里对方发来、对他可见、没撤回的 seq（升序；二分计数）。
// 第一次打开会话时从尾段往前异步扫，扫到所有成员的已读线以下（且凑够去重用的 2000 条）就停；
// 从没读过的会话最多收 UNREAD_CAP 条就停（未读显示 999+）。谁对谁不可见不常驻：要判断时读那一段。
// 都不做破坏性改动：readSeq / hideBefore 在 im.json 里，未读随时按它们现算，所以哪个文件先落盘都不会少算。
import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, open, readdir, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { resolve } from "node:path";
import type { ActorRef, CollabAnchorBody, ImAuthor, ImBody, ImKind } from "../../../shared/protocol.ts";
import { atomicWriteFile, atomicWriteFileSync } from "../fsAtomic.ts";
import { log } from "../log.ts";
import { isOwnMessage, senderKey } from "./identity.ts";
import { isTenantId, parseConvId } from "./ids.ts";

export const SEGMENT_SIZE = 1000;
/** 每个会话在内存里记最近这么多个 clientId → 消息，用于重发去重；冷启动扫 jsonl 时一并重建 */
export const CLIENT_IDS_PER_CONV = 2000;
/** 内存里最多缓存多少个非末尾分段（所有会话合计） */
const MAX_CACHED_SEGMENTS = 8;
/** 未读最多数到这么多（客户端显示 999+）；从没读过的长会话打开时不用扫全部历史 */
export const UNREAD_CAP = 1000;
/** 同时最多重建几个会话（im_list / 角标第一次打开所有会话时） */
const OPEN_CONCURRENCY = 4;
/** 内存里最多缓存多少个 blob 的引用表 */
const MAX_CACHED_REFS = 2000;
/** 缓存的引用表合计最多多少条引用（超了淘汰最久没用的 blob） */
const REF_BUDGET = 200_000;
/** 小文件写失败后多久重试 */
const RETRY_MS = 1000;
const STALE_UPLOAD_MS = 60 * 60_000;

export type StoredMessage = {
  seq: number;
  from: string;
  author?: ImAuthor;
  at: number;
  kind: ImKind | "collab";
  body?: ImBody | CollabAnchorBody;
  replyTo?: number;
  clientId: string;
  trigger?: { eventKey: string; mentions: Array<{ actorId: string }> };
  /** 被这些成员拉黑时写入：他们的任何接口都不返回这条，也不计未读 */
  rejectedFor?: string[];
  /** 读时由 recall 记录合并上来，不在原行里 */
  recalledAt?: number;
};

type RecallOp = { op: "recall"; seq: number; at: number };

/** meta.json：只放有界的摘要 */
type ConvMetaBase = {
  maxSeq: number;
  createdAt: number;
  /** 每个成员可见的最大 seq */
  visibleMax: Record<string, number>;
  /** 每个成员收到的（别人发的、对他可见的）最大 seq，上界：不超过已读线的成员打开会话时不用往前扫 */
  lastIncoming: Record<string, number>;
};
export type DmConvMeta = ConvMetaBase & {
  kind?: "dm";
  convId: string;
  members: [string, string];
};
export type GroupConvMeta = ConvMetaBase & {
  kind: "group";
  version: 1;
  convId: string;
  title: string;
  /** 群成员只有可登录的真人租户；Actor 永不进入 fanout 成员表。 */
  members: string[];
  actors: ActorRef[];
  archived?: boolean;
  defaultGroup?: boolean;
};
export type ConvMeta = DmConvMeta | GroupConvMeta;

/**
 * 一个成员的未读窗口：incoming 覆盖 [coveredFrom, ∞) 里所有算未读的 seq。
 * capped = 打开时收满 UNREAD_CAP 条就停了，coveredFrom 之前可能还有
 */
type UnreadWindow = { incoming: number[]; coveredFrom: number; capped: boolean };

/**
 * 已封闭分段的可见性摘要（<NNNNN>.sum.json），可从分段重建：
 *   visible  —— 每个成员在这一段里可见的条数（历史翻页跳段）
 *   incoming —— 其中别人发的条数（未读重建跳段；含已撤回，只作「这段有没有」的上界）
 */
type SegSummary = { visible: Record<string, number>; incoming: Record<string, number> };

export type BlobKind = "image" | "thumb" | "voice" | "file" | "avatar" | "icon";

/** 哪条消息的哪个用途引用了这个附件；下载时据此找到“调用者可见的消息” */
export type BlobRef = { convId: string; seq: number; kind: BlobKind };

/** <sha>.json：固定大小（uploaders 最多是租户数） */
export type BlobMeta = {
  sha: string;
  size: number;
  /** 按什么用途上传过、各自声明的 mime（同一份字节可以既是原图又是缩略图） */
  kinds: Partial<Record<BlobKind, string>>;
  uploaders: string[];
  createdAt: number;
};

/** 一个会话里对某个 blob 的引用：keys 去重（「seq:kind」），list 按 seq 升序（追加时就地插入，查询不排序） */
type ConvRefs = { keys: Set<string>; list: Array<{ seq: number; kind: BlobKind }> };
/** 一个 blob 的引用：会话号 → ConvRefs */
type BlobRefs = Map<string, ConvRefs>;
/** size = 这个 blob 的引用条数（加载完才计入） */
type RefEntry = { refs: Promise<BlobRefs>; size: number };

export type ConvSettings = { readSeq: number; pin: boolean; mute: boolean; hideBefore: number };

export type UserState = {
  convs: Record<string, ConvSettings>;
  blocked: string[];
  notifyPreview: boolean;
};

export type Profile = { nickname?: string; avatar?: string };

type Rows = Array<StoredMessage | undefined>;

export type Conv = {
  meta: ConvMeta;
  dir: string;
  /** 分段号 → 该段消息（下标 = seq - 段号*1000 - 1） */
  segments: Map<number, Rows>;
  clients: Map<string, StoredMessage>;
  /** clients 覆盖 [clientsFrom, maxSeq]；不够 CLIENT_IDS_PER_CONV 条时第一次去重没命中再往前补 */
  clientsFrom: number;
  unread: Map<string, UnreadWindow>;
  /** 用过的已封闭分段摘要（每段几个数） */
  sums: Map<number, SegSummary>;
  /** 正在从分段重建的摘要 */
  sumLoads: Map<number, Promise<SegSummary>>;
  metaWriter: Coalesced;
};

export class BlobTooLarge extends Error {
  constructor() {
    super("too large");
  }
}

/**
 * 合并写一个小文件：save() 返回的 promise 在「包含这次改动的那次写」成功后 resolve，失败则 reject；
 * 写失败时当时所有等待者都 reject（不会越积越多），改动仍记着没写完，retryMs 后自动重试
 * （下一次 save 也会立即重试）。target() 在开始写时才取数据，所以一次写会带上这之前的所有改动。
 */
export class Coalesced {
  private version = 0;
  private written = 0;
  private running: Promise<void> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private waiters: Array<{ version: number; done: () => void; fail: (err: unknown) => void }> = [];
  private readonly label: string;
  private readonly target: () => { file: string; data: unknown } | null;
  private readonly retryMs: number;
  private readonly write: (file: string, text: string) => Promise<void>;

  constructor(
    label: string,
    target: () => { file: string; data: unknown } | null,
    retryMs = RETRY_MS,
    write = (file: string, text: string) => atomicWriteFile(file, text, { mkdir: true }),
  ) {
    this.label = label;
    this.target = target;
    this.retryMs = retryMs;
    this.write = write;
  }

  get pending() {
    return this.waiters.length;
  }

  get dirty() {
    return this.written < this.version;
  }

  save(): Promise<void> {
    const version = (this.version += 1);
    const waiting = new Promise<void>((done, fail) => this.waiters.push({ version, done, fail }));
    this.kick();
    return waiting;
  }

  /** 等到当前所有改动落盘（或这一轮写失败） */
  async flush(): Promise<void> {
    if (!this.dirty && !this.running) return;
    await this.save().catch(() => undefined);
  }

  private kick() {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.running ??= this.loop().finally(() => {
      this.running = null;
      // loop 退出到这里之间（等待者的 then 回调里）来的 save() 看到 running 还在、没启动新一轮：补上
      if (this.dirty && !this.retry) this.kick();
    });
  }

  private settle(upTo: number, err?: unknown) {
    const rest: typeof this.waiters = [];
    for (const waiter of this.waiters) {
      if (waiter.version > upTo) rest.push(waiter);
      else if (err === undefined) waiter.done();
      else waiter.fail(err);
    }
    this.waiters = rest;
  }

  private async loop() {
    while (this.dirty) {
      const upTo = this.version;
      const target = this.target();
      try {
        if (target) await this.write(target.file, JSON.stringify(target.data));
        this.written = upTo;
        this.settle(upTo);
      } catch (err) {
        log.warn("im 写入失败，稍后重试", this.label, errText(err));
        this.settle(Number.POSITIVE_INFINITY, err);
        this.retry = setTimeout(() => this.kick(), this.retryMs);
        this.retry.unref?.();
        return;
      }
    }
  }

  /** 进程退出时同步补写 */
  writeSync() {
    if (!this.dirty) return;
    const target = this.target();
    try {
      if (target) atomicWriteFileSync(target.file, JSON.stringify(target.data), { mkdir: true });
    } catch {
      // 退出时目录已不在（测试清理）就算了
    }
  }

  close() {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
  }
}

/** 所有 ImStore 共用一个 exit 钩子：进程退出时把没写完的小文件同步补写 */
const liveStores = new Set<ImStore>();
let exitHooked = false;
function trackStore(store: ImStore) {
  liveStores.add(store);
  if (exitHooked) return;
  exitHooked = true;
  process.once("exit", () => {
    for (const item of liveStores) item.writeAllSync();
  });
}

async function readJson<T>(file: string): Promise<T | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    log.warn("im 读取失败", file, err instanceof Error ? err.message : err);
    return null;
  }
}

const segName = (index: number) => `${String(index).padStart(5, "0")}.jsonl`;
const segIndex = (seq: number) => Math.floor((seq - 1) / SEGMENT_SIZE);
const authorOf = (row: Pick<StoredMessage, "from" | "author">): ImAuthor =>
  row.author ?? { kind: "tenant", tenantId: row.from };
const clientKey = (author: ImAuthor, clientId: string) => `${senderKey(author)}\u0000${clientId}`;
const yieldLoop = () => new Promise<void>((done) => setImmediate(done));

/** 第一个 > value 的下标 */
function upperBound(list: number[], value: number) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const BLOB_KINDS: readonly string[] = ["image", "thumb", "voice", "file", "avatar", "icon"] satisfies BlobKind[];
const isRefKind = (kind: unknown): kind is BlobKind => typeof kind === "string" && BLOB_KINDS.includes(kind);
const refKey = (ref: { seq: number; kind: BlobKind }) => `${ref.seq}:${ref.kind}`;
const refLine = (ref: BlobRef) => `${JSON.stringify({ convId: ref.convId, seq: ref.seq, kind: ref.kind })}\n`;

/** 记一条引用；已有返回 false */
function addRef(refs: BlobRefs, ref: BlobRef): boolean {
  let conv = refs.get(ref.convId);
  if (!conv) {
    conv = { keys: new Set(), list: [] };
    refs.set(ref.convId, conv);
  }
  const key = refKey(ref);
  if (conv.keys.has(key)) return false;
  conv.keys.add(key);
  // 通常是追加在末尾；补写的旧 seq 二分插入
  let lo = 0;
  let hi = conv.list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (conv.list[mid].seq <= ref.seq) lo = mid + 1;
    else hi = mid;
  }
  conv.list.splice(lo, 0, { seq: ref.seq, kind: ref.kind });
  return true;
}

export function emptySettings(): ConvSettings {
  return { readSeq: 0, pin: false, mute: false, hideBefore: 0 };
}

function normalizeDmMeta(
  convId: string,
  raw: Partial<DmConvMeta> | null,
  fallbackMembers: [string, string],
): DmConvMeta {
  const members = Array.isArray(raw?.members)
    ? raw.members.filter((item): item is string => typeof item === "string")
    : fallbackMembers;
  const maxSeq = Number(raw?.maxSeq) || 0;
  const visibleMax: Record<string, number> = {};
  const lastIncoming: Record<string, number> = {};
  for (const member of members) {
    visibleMax[member] = Number(raw?.visibleMax?.[member]) || 0;
    const known = raw?.lastIncoming?.[member];
    // 旧版 meta 没有这个字段：拿 maxSeq 当上界（打开时扫到的会把它收紧）
    lastIncoming[member] = typeof known === "number" ? known : maxSeq;
  }
  return {
    convId,
    members: members.length === 2 ? [members[0], members[1]] : fallbackMembers,
    maxSeq,
    createdAt: Number(raw?.createdAt) || 0,
    visibleMax,
    lastIncoming,
  };
}

function normalizeGroupMeta(convId: string, raw: Partial<GroupConvMeta> | null): GroupConvMeta | null {
  if (
    raw?.kind !== "group" ||
    raw.version !== 1 ||
    typeof raw.title !== "string" ||
    !raw.title.trim() ||
    !Array.isArray(raw.members) ||
    !raw.members.every(isTenantId) ||
    !Array.isArray(raw.actors)
  )
    return null;
  const members = [...new Set(raw.members)];
  const actors = raw.actors.filter((actor): actor is ActorRef =>
    Boolean(
      actor &&
      (actor.kind === "assistant" || actor.kind === "workspace_agent") &&
      typeof actor.actorId === "string" &&
      typeof actor.ownerTenantId === "string" &&
      members.includes(actor.ownerTenantId) &&
      typeof actor.displayName === "string" &&
      (actor.kind !== "workspace_agent" || typeof actor.workspaceId === "string"),
    ),
  );
  if (actors.length !== raw.actors.length || new Set(actors.map((actor) => actor.actorId)).size !== actors.length)
    return null;
  const maxSeq = Number(raw.maxSeq) || 0;
  const visibleMax: Record<string, number> = {};
  const lastIncoming: Record<string, number> = {};
  for (const member of members) {
    visibleMax[member] = Number(raw.visibleMax?.[member]) || 0;
    const known = raw.lastIncoming?.[member];
    lastIncoming[member] = typeof known === "number" ? known : maxSeq;
  }
  return {
    kind: "group",
    version: 1,
    convId,
    title: raw.title.trim(),
    members,
    actors,
    archived: raw.archived === true,
    defaultGroup: raw.defaultGroup === true,
    maxSeq,
    createdAt: Number(raw.createdAt) || 0,
    visibleMax,
    lastIncoming,
  };
}

function summarize(members: string[], rows: Rows): SegSummary {
  const visible: Record<string, number> = {};
  const incoming: Record<string, number> = {};
  for (const member of members) {
    visible[member] = 0;
    incoming[member] = 0;
  }
  for (const row of rows) {
    if (!row) continue;
    for (const member of members) {
      if (row.rejectedFor?.includes(member)) continue;
      visible[member] += 1;
      if (!isOwnMessage(authorOf(row), member)) incoming[member] += 1;
    }
  }
  return { visible, incoming };
}

function validAuthor(meta: ConvMeta, row: Pick<StoredMessage, "from" | "author">): boolean {
  if (meta.kind !== "group") {
    const author = row.author ?? { kind: "tenant" as const, tenantId: row.from };
    return author.kind === "tenant" && author.tenantId === row.from && meta.members.includes(author.tenantId);
  }
  if (!row.author) return false;
  if (row.author.kind === "tenant")
    return row.from === row.author.tenantId && meta.members.includes(row.author.tenantId);
  const author = row.author;
  const actor = meta.actors.find((item) => item.actorId === author.actorId);
  return Boolean(
    actor &&
    row.from === author.actorId &&
    actor.kind === author.kind &&
    actor.ownerTenantId === author.ownerTenantId &&
    (actor.kind !== "workspace_agent" ||
      (author.kind === "workspace_agent" && actor.workspaceId === author.workspaceId)),
  );
}

/** 摘要文件内容合法：成员集合完全一致，计数是 0..SEGMENT_SIZE 的整数，incoming 不超过 visible */
function validSummary(members: string[], raw: unknown): raw is SegSummary {
  if (!raw || typeof raw !== "object") return false;
  const { visible, incoming } = raw as Partial<SegSummary>;
  if (!visible || !incoming || typeof visible !== "object" || typeof incoming !== "object") return false;
  const same = (counts: Record<string, number>) =>
    Object.keys(counts).length === members.length && members.every((member) => member in counts);
  const count = (value: unknown) =>
    Number.isInteger(value) && (value as number) >= 0 && (value as number) <= SEGMENT_SIZE;
  return (
    same(visible) &&
    same(incoming) &&
    members.every((member) => count(visible[member]) && count(incoming[member]) && incoming[member] <= visible[member])
  );
}

/** 解析一段 jsonl：同 seq 后写的覆盖先写的（追加失败重试），撤回记录合并到原消息上 */
function parseSegment(text: string, index: number): Rows {
  const rows: Rows = [];
  const base = index * SEGMENT_SIZE;
  const recalls: RecallOp[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    let row: (StoredMessage & { op?: undefined }) | RecallOp;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || typeof row.seq !== "number") continue;
    const slot = row.seq - base - 1;
    if (slot < 0 || slot >= SEGMENT_SIZE) continue;
    if (row.op === "recall") recalls.push(row);
    else rows[slot] = row;
  }
  for (const op of recalls) {
    const target = rows[op.seq - base - 1];
    if (target && target.recalledAt === undefined) target.recalledAt = op.at;
  }
  return rows;
}

export class ImStore {
  readonly root: string;
  private readonly tenantDir: (id: string) => string;
  private loading: Promise<void> | null = null;
  private readonly metas = new Map<string, ConvMeta>();
  private readonly convs = new Map<string, Promise<Conv>>();
  private readonly lru = new Map<string, { convId: string; index: number }>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly blobs = new Map<string, BlobMeta>();
  private readonly blobLoads = new Map<string, Promise<BlobMeta | null>>();
  /** 懒加载的引用表（LRU，按 blob 数和引用总条数两道上限） */
  private readonly refCache = new Map<string, RefEntry>();
  private refTotal = 0;
  private readonly refBudget: number;
  private profiles: Record<string, Profile> = {};
  private readonly profileWriter: Coalesced;
  private readonly users = new Map<string, Promise<UserState>>();
  private readonly loadedUsers = new Map<string, UserState>();
  private readonly userWriters = new Map<string, Coalesced>();
  private readonly metaWriters = new Set<Coalesced>();
  /** 从磁盘读分段文件的次数（测试据此确认列表、未读、推送不读历史） */
  segmentReads = 0;
  /** 正在重建的会话数、排队等名额的、出现过的最大并发（测试用） */
  private rebuilding = 0;
  private readonly rebuildWaiters: Array<() => void> = [];
  peakRebuilds = 0;
  /** 后台清理（临时文件、没有 meta 的 blob）；测试可 await */
  sweeping: Promise<void> = Promise.resolve();

  private readonly retryMs: number;

  /**
   * root = 全局状态目录（tenants/<id> 的上一级）；tenantDir 给出租户状态目录；
   * retryMs = 写失败后多久重试；refBudget = 引用缓存总条数上限
   */
  constructor(root: string, tenantDir: (id: string) => string, opts: { retryMs?: number; refBudget?: number } = {}) {
    this.root = resolve(root);
    this.tenantDir = tenantDir;
    this.retryMs = opts.retryMs ?? RETRY_MS;
    this.refBudget = opts.refBudget ?? REF_BUDGET;
    this.profileWriter = this.writer("profiles", () => ({
      file: resolve(this.root, "im", "profiles.json"),
      data: this.profiles,
    }));
    trackStore(this);
  }

  private writer(label: string, target: () => { file: string; data: unknown } | null) {
    return new Coalesced(label, target, this.retryMs);
  }

  private get convRoot() {
    return resolve(this.root, "im", "conversations");
  }

  private get blobRoot() {
    return resolve(this.root, "im", "blobs");
  }

  /** 第一次用时读所有会话的 meta 和 profiles.json；之后 profile() 等同步读内存 */
  ready(): Promise<void> {
    this.loading ??= this.init();
    return this.loading;
  }

  private async init() {
    const names = await readdir(this.convRoot).catch(() => [] as string[]);
    await Promise.all(
      names.map(async (name) => {
        const parsed = parseConvId(name);
        if (!parsed) return;
        const raw = await readJson<Partial<ConvMeta>>(resolve(this.convRoot, name, "meta.json"));
        if (parsed.kind === "dm") {
          // DM 的 meta 丢了也能从会话号修复；群没有可推导的成员，必须有合法 meta。
          this.metas.set(name, normalizeDmMeta(name, raw as Partial<DmConvMeta>, parsed.members));
          return;
        }
        const group = normalizeGroupMeta(name, raw as Partial<GroupConvMeta>);
        if (group) this.metas.set(name, group);
        else log.warn("im 群 meta 不合法，已隔离", name);
      }),
    );
    this.profiles = (await readJson<Record<string, Profile>>(resolve(this.root, "im", "profiles.json"))) ?? {};
    this.sweeping = this.sweepBlobs().catch((err) => log.warn("im 清理 blobs 失败", errText(err)));
  }

  /**
   * 后台清理（不阻塞 ready）：
   *   - 过期的 .upload-*.tmp（上传中途崩溃）
   *   - 没有 meta 的 blob（旧版本先 rename 后写 meta 时崩溃留下的；现在先写 meta，不会再出现）
   *   - 过期的、没有字节的 meta（写完 meta、rename 前崩溃；不过期的可能正在归位，不动）
   */
  private async sweepBlobs() {
    const names = await readdir(this.blobRoot).catch(() => [] as string[]);
    const present = new Set(names);
    const cutoff = Date.now() - STALE_UPLOAD_MS;
    const old = async (file: string) => {
      const info = await stat(file).catch(() => null);
      return Boolean(info && info.mtimeMs < cutoff);
    };
    for (const name of names) {
      const file = resolve(this.blobRoot, name);
      const metaOf = /^([0-9a-f]{64})\.json$/.exec(name)?.[1];
      if (name.startsWith(".upload-")) {
        if (await old(file)) await unlink(file).catch(() => undefined);
      } else if (/^[0-9a-f]{64}$/.test(name) && !present.has(`${name}.json`)) {
        await this.serial(`blob:${name}`, async () => {
          if (!this.blobs.has(name)) await unlink(file).catch(() => undefined);
        });
      } else if (metaOf && !present.has(metaOf) && (await old(file))) {
        await this.serial(`blob:${metaOf}`, async () => {
          if (!this.blobs.has(metaOf)) await unlink(file).catch(() => undefined);
        });
      }
    }
  }

  /** 同一个 key（会话号、blob:<sha>）的异步操作按到达顺序一个个跑 */
  serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(key, tail);
    void tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    });
    return run;
  }

  /* ── 会话 ── */

  /** 某租户参与的会话（打开并建好未读窗口）；重建受全局 OPEN_CONCURRENCY 名额限制 */
  async convsOf(tenantId: string): Promise<Conv[]> {
    await this.ready();
    const ids = [...this.metas.values()].filter((meta) => meta.members.includes(tenantId)).map((meta) => meta.convId);
    const out = await Promise.all(ids.map((id) => this.open(id)));
    return out.filter((conv): conv is Conv => conv !== null);
  }

  /** Collab Trigger Scanner 的只读入口；按群内 seq 顺序补扫，不从 convId 推导成员。 */
  async groupRowsAfter(
    tenantId: string,
    convId: string,
    after: number,
    limit = 100,
  ): Promise<{ rows: StoredMessage[]; maxSeq: number }> {
    const conv = await this.open(convId);
    if (!conv || conv.meta.kind !== "group" || !conv.meta.members.includes(tenantId)) {
      return { rows: [], maxSeq: 0 };
    }
    const page = await this.visibleRange(conv, tenantId, after + 1, conv.meta.maxSeq, limit, false);
    return { rows: page.rows, maxSeq: conv.meta.maxSeq };
  }

  /** 启动恢复时列出当前真人参与的群，Scanner cursor 按 convId 各自推进。 */
  async groupConvIdsOf(tenantId: string): Promise<string[]> {
    await this.ready();
    return [...this.metas.values()]
      .filter((meta): meta is GroupConvMeta => meta.kind === "group" && meta.members.includes(tenantId))
      .map((meta) => meta.convId)
      .sort();
  }

  /** 同一会话并发打开共享一个 Promise；不同会话的重建整个 store 同时最多 OPEN_CONCURRENCY 个 */
  async open(convId: string): Promise<Conv | null> {
    await this.ready();
    const known = this.convs.get(convId);
    if (known) return known;
    const meta = this.metas.get(convId);
    if (!meta) return null;
    const opening = this.withRebuildSlot(() => this.load(convId, meta));
    this.convs.set(convId, opening);
    opening.catch(() => this.convs.delete(convId));
    return opening;
  }

  private async withRebuildSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.rebuilding >= OPEN_CONCURRENCY) {
      await new Promise<void>((done) => this.rebuildWaiters.push(done));
    } else {
      this.rebuilding += 1;
    }
    this.peakRebuilds = Math.max(this.peakRebuilds, this.rebuilding);
    try {
      return await fn();
    } finally {
      // 名额直接转给排队的下一个（rebuilding 不变），没人排队才归还
      const next = this.rebuildWaiters.shift();
      if (next) next();
      else this.rebuilding -= 1;
    }
  }

  /** 没有就建（members 只在新建时生效）。调用方要在 serial(convId) 里 */
  async ensure(convId: string, members: string[], now: number): Promise<Conv> {
    const known = await this.open(convId);
    if (known) return known;
    await mkdir(resolve(this.convRoot, convId), { recursive: true });
    const sorted = [...members].sort();
    if (sorted.length !== 2) throw new Error("DM 必须恰好有两个成员");
    const meta = normalizeDmMeta(convId, { members: [sorted[0], sorted[1]], maxSeq: 0, createdAt: now }, [
      sorted[0],
      sorted[1],
    ]);
    this.metas.set(convId, meta);
    const conv = await this.open(convId);
    if (!conv) throw new Error(`im 会话建不出来：${convId}`);
    await conv.metaWriter.save();
    return conv;
  }

  /** 新建空群并立即持久化；空群是产品实体，不能按空 DM 清理。调用方要在 serial(convId) 里。 */
  async createGroup(
    convId: string,
    ownerTenantId: string,
    title: string,
    actors: ActorRef[],
    now: number,
    defaultGroup = false,
  ): Promise<Conv> {
    if (await this.open(convId)) throw new Error(`im 群已存在：${convId}`);
    await mkdir(resolve(this.convRoot, convId), { recursive: true });
    const meta: GroupConvMeta = {
      kind: "group",
      version: 1,
      convId,
      title,
      members: [ownerTenantId],
      actors,
      defaultGroup,
      maxSeq: 0,
      createdAt: now,
      visibleMax: { [ownerTenantId]: 0 },
      lastIncoming: { [ownerTenantId]: 0 },
    };
    this.metas.set(convId, meta);
    const conv = await this.open(convId);
    if (!conv) throw new Error(`im 群建不出来：${convId}`);
    await conv.metaWriter.save();
    return conv;
  }

  async updateGroup(
    convId: string,
    ownerTenantId: string,
    patch: { title?: string; actors?: ActorRef[]; archived?: boolean; defaultGroup?: boolean },
  ): Promise<Conv> {
    const conv = await this.open(convId);
    if (!conv || conv.meta.kind !== "group" || !conv.meta.members.includes(ownerTenantId)) {
      throw new Error("群不存在");
    }
    if (patch.title !== undefined) conv.meta.title = patch.title;
    if (patch.actors !== undefined) conv.meta.actors = patch.actors;
    if (patch.archived !== undefined) conv.meta.archived = patch.archived;
    if (patch.defaultGroup !== undefined) conv.meta.defaultGroup = patch.defaultGroup;
    await conv.metaWriter.save();
    return conv;
  }

  /**
   * 会话里一条消息都没有（maxSeq = 0）就整个删掉：内存、meta 写入、目录。调用方要在 serial(convId) 里。
   * 删之前重读第一段：追加其实写完了只是报错的话，那几行按已提交接上（修 maxSeq、进去重表），不删
   */
  async dropIfEmpty(conv: Conv) {
    if (conv.meta.maxSeq > 0 || conv.meta.kind === "group") return;
    const { convId } = conv.meta;
    const rows = await this.readRows(conv, 0);
    if (rows.some(Boolean)) {
      conv.segments.set(0, rows);
      for (const row of rows) if (row) this.applyRow(conv, row);
      log.warn("im 追加报错但消息行已写入，按已提交处理", convId, conv.meta.maxSeq);
      await conv.metaWriter.save().catch(() => undefined);
      return;
    }
    conv.metaWriter.close();
    this.metaWriters.delete(conv.metaWriter);
    this.metas.delete(convId);
    this.convs.delete(convId);
    for (const index of conv.segments.keys()) this.lru.delete(`${convId}\u0000${index}`);
    await rm(conv.dir, { recursive: true, force: true }).catch((err) =>
      log.warn("im 清理空会话失败", convId, errText(err)),
    );
  }

  /** 这个成员在这个会话里的已读线 max(readSeq, hideBefore) */
  private async floorOf(member: string, convId: string): Promise<number> {
    const row = (await this.user(member)).convs[convId];
    return row ? Math.max(row.readSeq, row.hideBefore) : 0;
  }

  /**
   * 第一次打开：最后一段补换行；读最后两段修 meta、建去重表；再给每个成员建未读窗口（rebuildWindow，
   * 跳过摘要说没有别人发给他的段）。每段之间让出事件循环；末尾分段常驻
   */
  private async load(convId: string, stale: ConvMeta): Promise<Conv> {
    const dir = resolve(this.convRoot, convId);
    const meta: ConvMeta = { ...stale, visibleMax: { ...stale.visibleMax }, lastIncoming: { ...stale.lastIncoming } };
    this.metas.set(convId, meta);
    const conv: Conv = {
      meta,
      dir,
      segments: new Map(),
      clients: new Map(),
      clientsFrom: 1,
      unread: new Map(),
      sums: new Map(),
      sumLoads: new Map(),
      metaWriter: this.writer(`meta ${convId}`, () => ({ file: resolve(dir, "meta.json"), data: conv.meta })),
    };
    this.metaWriters.add(conv.metaWriter);
    const indices = (await readdir(dir).catch(() => [] as string[]))
      .filter((name) => /^\d{5}\.jsonl$/.test(name))
      .map((name) => Number(name.slice(0, 5)))
      .sort((a, b) => a - b);
    if (indices.length) await terminateLine(resolve(dir, segName(indices[indices.length - 1])));

    // 第一步：只读最后两段 —— 修 maxSeq / visibleMax / lastIncoming（meta 落后时落后的都在尾部），建去重表
    const seenVisible = new Set<string>();
    const seenIncoming = new Set<string>();
    const recent: StoredMessage[] = [];
    let maxSeq = 0;
    let lowest = Number.POSITIVE_INFINITY;
    const tail = indices.slice(-2).reverse();
    for (const [i, index] of tail.entries()) {
      const rows = i === 0 ? await this.readRows(conv, index) : await this.readSegment(conv, index);
      if (i === 0) conv.segments.set(index, rows);
      for (let slot = rows.length - 1; slot >= 0; slot -= 1) {
        const row = rows[slot];
        if (!row) continue;
        maxSeq = Math.max(maxSeq, row.seq);
        lowest = row.seq;
        if (recent.length < CLIENT_IDS_PER_CONV) recent.push(row);
        for (const member of meta.members) {
          if (row.rejectedFor?.includes(member)) continue;
          if (!seenVisible.has(member)) {
            seenVisible.add(member);
            meta.visibleMax[member] = row.seq;
          }
          if (!isOwnMessage(authorOf(row), member) && !seenIncoming.has(member)) {
            seenIncoming.add(member);
            meta.lastIncoming[member] = row.seq;
          }
        }
      }
      await yieldLoop();
    }
    meta.maxSeq = Math.max(maxSeq, indices.length ? 0 : stale.maxSeq);
    for (const member of meta.members) {
      // 尾部没碰到：真正的值在更早，meta 里的值不超过扫过的下沿就照用
      const below = Math.min(lowest - 1, meta.maxSeq);
      if (!seenVisible.has(member)) meta.visibleMax[member] = Math.min(meta.visibleMax[member] ?? 0, below);
      if (!seenIncoming.has(member)) meta.lastIncoming[member] = Math.min(meta.lastIncoming[member] ?? 0, below);
    }
    for (let i = recent.length - 1; i >= 0; i -= 1) this.remember(conv, recent[i]);
    conv.clientsFrom =
      recent.length >= CLIENT_IDS_PER_CONV
        ? recent[recent.length - 1].seq
        : tail.length
          ? tail[tail.length - 1] * SEGMENT_SIZE + 1
          : 1;

    // 第二步：各成员的未读窗口
    for (const member of meta.members) {
      conv.unread.set(member, await this.rebuildWindow(conv, member, await this.floorOf(member, convId)));
    }
    const changed =
      meta.maxSeq !== stale.maxSeq ||
      meta.members.some(
        (member) =>
          meta.visibleMax[member] !== stale.visibleMax[member] ||
          meta.lastIncoming[member] !== stale.lastIncoming[member],
      );
    if (changed) {
      if (meta.maxSeq !== stale.maxSeq) log.warn("im 会话按尾段修复 maxSeq", convId, stale.maxSeq, "->", meta.maxSeq);
      void conv.metaWriter.save().catch(() => undefined);
    }
    return conv;
  }

  /**
   * 一个成员的未读窗口：从 lastIncoming 所在段往前，扫到已读线以下、或找到第 UNREAD_CAP + 1 条（封顶）、或到开头。
   * 摘要说这段没有别人发给他的就跳过；摘要缺失或不合法的段才读分段
   */
  private async rebuildWindow(conv: Conv, member: string, floor: number): Promise<UnreadWindow> {
    const last = conv.meta.lastIncoming[member] ?? conv.meta.maxSeq;
    if (last <= floor) return { incoming: [], coveredFrom: floor + 1, capped: false };
    const list: number[] = [];
    let coveredFrom = 1;
    let capped = false;
    scan: for (let index = segIndex(last); index >= 0; index -= 1) {
      const base = index * SEGMENT_SIZE;
      if (base + SEGMENT_SIZE <= floor) {
        coveredFrom = floor + 1;
        break;
      }
      const sum = await this.summary(conv, index);
      if (sum && sum.incoming[member] === 0) continue;
      const rows = await this.readSegment(conv, index);
      for (let slot = Math.min(rows.length, last - base) - 1; slot >= 0; slot -= 1) {
        const row = rows[slot];
        if (!row) continue;
        if (row.seq <= floor) {
          coveredFrom = floor + 1;
          break scan;
        }
        if (row.rejectedFor?.includes(member) || isOwnMessage(authorOf(row), member) || row.recalledAt !== undefined)
          continue;
        if (list.length >= UNREAD_CAP) {
          // 找到第 UNREAD_CAP + 1 条才算封顶；窗口仍从收到的第 UNREAD_CAP 条开始
          capped = true;
          coveredFrom = list[list.length - 1];
          break scan;
        }
        list.push(row.seq);
      }
      await yieldLoop();
    }
    return { incoming: list.reverse(), coveredFrom, capped };
  }

  private async readRows(conv: Conv, index: number): Promise<Rows> {
    this.segmentReads += 1;
    try {
      const rows = parseSegment(await readFile(resolve(conv.dir, segName(index)), "utf8"), index);
      for (let slot = 0; slot < rows.length; slot += 1) {
        const row = rows[slot];
        if (row && !validAuthor(conv.meta, row)) rows[slot] = undefined;
      }
      return rows;
    } catch (err) {
      if ((err as { code?: string }).code !== "ENOENT") {
        log.warn("im 分段读取失败", conv.meta.convId, index, errText(err));
      }
      return [];
    }
  }

  /** 新追加的一条进内存（seq 递增）：visibleMax O(1) 更新，未读窗口追加在末尾仍然有序 */
  private applyRow(conv: Conv, row: StoredMessage) {
    conv.meta.maxSeq = Math.max(conv.meta.maxSeq, row.seq);
    for (const member of conv.meta.members) {
      if (row.rejectedFor?.includes(member)) continue;
      conv.meta.visibleMax[member] = row.seq;
      if (isOwnMessage(authorOf(row), member) || row.recalledAt !== undefined) continue;
      conv.meta.lastIncoming[member] = row.seq;
      let window = conv.unread.get(member);
      if (!window) {
        window = { incoming: [], coveredFrom: 1, capped: false };
        conv.unread.set(member, window);
      }
      window.incoming.push(row.seq);
      // 一直不读也不无限长：只留最新的 UNREAD_CAP 条，更早的按封顶处理
      if (window.incoming.length >= 2 * UNREAD_CAP) {
        window.incoming.splice(0, window.incoming.length - UNREAD_CAP);
        window.coveredFrom = window.incoming[0];
        window.capped = true;
      }
    }
    this.remember(conv, row);
  }

  private async readSegment(conv: Conv, index: number): Promise<Rows> {
    const known = conv.segments.get(index);
    if (known) {
      this.touch(conv, index);
      return known;
    }
    const rows = await this.readRows(conv, index);
    // 读的时候可能有别的请求已经把这段放进缓存（并发读同一段）
    const raced = conv.segments.get(index);
    if (raced) return raced;
    conv.segments.set(index, rows);
    this.touch(conv, index);
    return rows;
  }

  /** 非末尾分段走 LRU；末尾分段常驻（追加、去重、列表的最后一条都要用） */
  private touch(conv: Conv, index: number) {
    const key = `${conv.meta.convId}\u0000${index}`;
    this.lru.delete(key);
    if (index === segIndex(Math.max(1, conv.meta.maxSeq))) return;
    this.lru.set(key, { convId: conv.meta.convId, index });
    while (this.lru.size > MAX_CACHED_SEGMENTS) {
      const [oldKey, old] = this.lru.entries().next().value as [string, { convId: string; index: number }];
      this.lru.delete(oldKey);
      void this.convs.get(old.convId)?.then((owner) => {
        if (old.index !== segIndex(Math.max(1, owner.meta.maxSeq))) owner.segments.delete(old.index);
      });
    }
  }

  private remember(conv: Conv, row: StoredMessage) {
    const key = clientKey(authorOf(row), row.clientId);
    conv.clients.delete(key);
    conv.clients.set(key, row);
    while (conv.clients.size > CLIENT_IDS_PER_CONV) {
      conv.clients.delete(conv.clients.keys().next().value as string);
    }
  }

  /** 同一发件人的 clientId 已经写过：返回那一条（只查内存） */
  byClientId(conv: Conv, author: ImAuthor, clientId: string): StoredMessage | null {
    return conv.clients.get(clientKey(author, clientId)) ?? null;
  }

  /** 同上，但内存里不够最近 CLIENT_IDS_PER_CONV 条时先往前补（每个会话最多补一次）。要在 serial(convId) 里 */
  async findClient(conv: Conv, author: ImAuthor, clientId: string): Promise<StoredMessage | null> {
    const hit = this.byClientId(conv, author, clientId);
    if (hit) return hit;
    const target = Math.max(1, conv.meta.maxSeq - CLIENT_IDS_PER_CONV + 1);
    if (conv.clientsFrom <= target) return null;
    const older: StoredMessage[] = [];
    let edge = conv.clientsFrom;
    while (edge > target) {
      const index = segIndex(edge - 1);
      const rows = await this.readSegment(conv, index);
      const part = rows.filter((row): row is StoredMessage => Boolean(row && row.seq >= target && row.seq < edge));
      older.unshift(...part);
      edge = index * SEGMENT_SIZE + 1;
    }
    const newer = [...conv.clients.values()];
    conv.clients = new Map();
    conv.clientsFrom = target;
    for (const row of [...older, ...newer]) this.remember(conv, row);
    return this.byClientId(conv, author, clientId);
  }

  /** 下一条会拿到的 seq。调用方要在 serial(convId) 里，且接着就 append */
  nextSeq(conv: Conv) {
    return conv.meta.maxSeq + 1;
  }

  /**
   * 追加一条，seq = maxSeq + 1。调用方要在 serial(convId) 里。
   * 消息行写进 jsonl 就是提交点：之后内存索引、去重表立即更新；meta 摘要合并写、不等（可从 jsonl 重建）
   */
  async append(conv: Conv, row: Omit<StoredMessage, "seq" | "recalledAt">): Promise<StoredMessage> {
    if (!validAuthor(conv.meta, row)) throw new Error("im 消息 author 不属于会话");
    const seq = conv.meta.maxSeq + 1;
    const index = segIndex(seq);
    const slot = seq - index * SEGMENT_SIZE - 1;
    const rows = slot === 0 ? (conv.segments.get(index) ?? []) : await this.readSegment(conv, index);
    const stored: StoredMessage = { seq, ...row };
    const file = resolve(conv.dir, segName(index));
    try {
      await appendFile(file, `${JSON.stringify(stored)}\n`);
    } catch (err) {
      // 可能写了半行：补换行隔开，重试时这条会以同一个 seq 再追加一次，读时后写的覆盖半行
      await terminateLine(file);
      throw err;
    }
    rows[slot] = stored;
    conv.segments.set(index, rows);
    const prevIndex = segIndex(Math.max(1, conv.meta.maxSeq));
    this.applyRow(conv, stored);
    if (prevIndex !== index) {
      // 上一段封闭了：写它的可见性摘要（每 1000 条一次；失败无妨，用到时从分段重建）
      const closed = conv.segments.get(prevIndex);
      if (closed) await this.saveSummary(conv, prevIndex, summarize(conv.meta.members, closed));
      this.touch(conv, prevIndex);
    }
    // meta 只有几个数，等它写完代价是常数；写失败不影响已提交的消息（稍后重试，也能从 jsonl 重建）
    await conv.metaWriter.save().catch(() => undefined);
    return stored;
  }

  async get(conv: Conv, seq: number): Promise<StoredMessage | null> {
    if (!Number.isInteger(seq) || seq < 1 || seq > conv.meta.maxSeq) return null;
    const index = segIndex(seq);
    return (await this.readSegment(conv, index))[seq - index * SEGMENT_SIZE - 1] ?? null;
  }

  /** 调用方要在 serial(convId) 里 */
  async recall(conv: Conv, row: StoredMessage, at: number) {
    if (row.recalledAt !== undefined) return;
    const op: RecallOp = { op: "recall", seq: row.seq, at };
    const file = resolve(conv.dir, segName(segIndex(row.seq)));
    // 原消息可能在较早的分段，冷启动只给最后一段补换行；这里先补，免得和之前崩溃留下的半行粘在一起
    await terminateLine(file);
    try {
      await appendFile(file, `${JSON.stringify(op)}\n`);
    } catch (err) {
      await terminateLine(file);
      throw err;
    }
    row.recalledAt = at;
    const remembered = conv.clients.get(clientKey(authorOf(row), row.clientId));
    if (remembered?.seq === row.seq) remembered.recalledAt = at;
    for (const [member, window] of conv.unread) {
      const slot = upperBound(window.incoming, row.seq) - 1;
      if (slot < 0 || window.incoming[slot] !== row.seq) continue;
      window.incoming.splice(slot, 1);
      if (window.capped && window.incoming.length < UNREAD_CAP) await this.refill(conv, member, window);
    }
  }

  /**
   * 封顶的窗口因撤回不满 UNREAD_CAP 条：从 coveredFrom 往前补，直到又收满（找到下一条才算仍封顶）、
   * 扫到已读线、或到开头。调用方要在 serial(convId) 里
   */
  private async refill(conv: Conv, member: string, window: UnreadWindow) {
    const floor = await this.floorOf(member, conv.meta.convId);
    if (floor + 1 >= window.coveredFrom) {
      window.capped = false;
      return;
    }
    const older: number[] = [];
    let coveredFrom = 1;
    let capped = false;
    let edge = window.coveredFrom;
    scan: while (edge > 1) {
      const index = segIndex(edge - 1);
      const base = index * SEGMENT_SIZE;
      if (base + SEGMENT_SIZE <= floor) {
        coveredFrom = floor + 1;
        break;
      }
      const sum = await this.summary(conv, index);
      if (sum && sum.incoming[member] === 0) {
        edge = base + 1;
        continue;
      }
      const rows = await this.readSegment(conv, index);
      for (let slot = Math.min(rows.length, edge - base - 1) - 1; slot >= 0; slot -= 1) {
        const row = rows[slot];
        if (!row) continue;
        if (row.seq <= floor) {
          coveredFrom = floor + 1;
          break scan;
        }
        if (row.rejectedFor?.includes(member) || isOwnMessage(authorOf(row), member) || row.recalledAt !== undefined)
          continue;
        if (window.incoming.length + older.length >= UNREAD_CAP) {
          capped = true;
          coveredFrom = older.length ? older[older.length - 1] : window.coveredFrom;
          break scan;
        }
        older.push(row.seq);
      }
      edge = base + 1;
    }
    window.incoming = [...older.reverse(), ...window.incoming];
    window.coveredFrom = coveredFrom;
    window.capped = capped;
  }

  /* ── 查询 ── */

  /** 这一条对 member 不可见（被他拒收）；不存在的也算。要读那一段（走段缓存） */
  async isHidden(conv: Conv, member: string, seq: number): Promise<boolean> {
    const row = await this.get(conv, seq);
    return !row || Boolean(row.rejectedFor?.includes(member));
  }

  /** member 可见的最大 seq（0 = 没有）；存在 meta 里，发送时 O(1) 更新 */
  visibleMax(conv: Conv, member: string): number {
    return conv.meta.visibleMax[member] ?? 0;
  }

  /** [lo, hi] 里有没有 member 可见的 seq（从 fromHigh 指定的一端找，跳过全不可见的已封闭分段） */
  async anyVisible(conv: Conv, member: string, lo: number, hi: number, fromHigh = false): Promise<boolean> {
    return (await this.visibleRange(conv, member, lo, hi, 0, fromHigh)).more;
  }

  /**
   * [lo, hi] 里 member 可见的行，从 fromHigh 指定的一端取最多 limit 条（升序返回）；more = 这个方向上还有。
   * 按段读、段内同步过滤；已封闭且摘要说对 member 全不可见的段不读，整段在区间里且有可见的段判 more 也不读
   */
  async visibleRange(
    conv: Conv,
    member: string,
    lo: number,
    hi: number,
    limit: number,
    fromHigh: boolean,
  ): Promise<{ rows: StoredMessage[]; more: boolean }> {
    const from = Math.max(1, lo);
    const to = Math.min(conv.meta.maxSeq, hi);
    const out: StoredMessage[] = [];
    let more = false;
    if (to < from) return { rows: out, more };
    const step = fromHigh ? -1 : 1;
    const last = segIndex(fromHigh ? from : to);
    for (let index = segIndex(fromHigh ? to : from); fromHigh ? index >= last : index <= last; index += step) {
      const base = index * SEGMENT_SIZE;
      const segLo = Math.max(from, base + 1);
      const segHi = Math.min(to, base + SEGMENT_SIZE);
      const sum = await this.summary(conv, index);
      if (sum && !(sum.visible[member] > 0)) continue;
      if (sum && out.length >= limit && segLo === base + 1 && segHi === base + SEGMENT_SIZE) {
        more = true;
        break;
      }
      const rows = await this.readSegment(conv, index);
      for (let seq = fromHigh ? segHi : segLo; fromHigh ? seq >= segLo : seq <= segHi; seq += step) {
        const row = rows[seq - base - 1];
        if (!row || row.rejectedFor?.includes(member)) continue;
        if (out.length >= limit) {
          more = true;
          break;
        }
        out.push(row);
      }
      if (more) break;
    }
    if (fromHigh) out.reverse();
    return { rows: out, more };
  }

  private sumFile(conv: Conv, index: number) {
    return resolve(conv.dir, `${String(index).padStart(5, "0")}.sum.json`);
  }

  /** 写失败只记日志（内存里已有，下次进程用到时再从分段重建） */
  private async saveSummary(conv: Conv, index: number, sum: SegSummary) {
    conv.sums.set(index, sum);
    await atomicWriteFile(this.sumFile(conv, index), JSON.stringify(sum)).catch((err) =>
      log.warn("im 分段摘要写入失败", conv.meta.convId, index, errText(err)),
    );
  }

  /**
   * 已封闭分段的摘要；末尾分段（还在追加）返回 null。摘要文件没有或不合法就读分段重建并写回；
   * 同一段并发来的共用一次重建
   */
  private summary(conv: Conv, index: number): Promise<SegSummary | null> {
    if (index >= segIndex(Math.max(1, conv.meta.maxSeq))) return Promise.resolve(null);
    const known = conv.sums.get(index);
    if (known) return Promise.resolve(known);
    let loading = conv.sumLoads.get(index);
    if (!loading) {
      loading = this.loadSummary(conv, index).finally(() => conv.sumLoads.delete(index));
      conv.sumLoads.set(index, loading);
    }
    return loading;
  }

  private async loadSummary(conv: Conv, index: number): Promise<SegSummary> {
    const raw = await readJson<unknown>(this.sumFile(conv, index));
    if (validSummary(conv.meta.members, raw)) {
      const sum: SegSummary = { visible: raw.visible, incoming: raw.incoming };
      conv.sums.set(index, sum);
      return sum;
    }
    if (raw) log.warn("im 分段摘要不合法，按分段重建", conv.meta.convId, index);
    const sum = summarize(conv.meta.members, await this.readSegment(conv, index));
    await this.saveSummary(conv, index, sum);
    return sum;
  }

  /** seq > threshold 的未读（别人发的、对他可见、没撤回），最多报 UNREAD_CAP（客户端显示 999+） */
  unread(conv: Conv, member: string, threshold: number): number {
    const window = conv.unread.get(member);
    if (!window) return 0;
    if (window.capped && threshold + 1 < window.coveredFrom) return UNREAD_CAP;
    return Math.min(UNREAD_CAP, window.incoming.length - upperBound(window.incoming, threshold));
  }

  /** 已读线前进后丢掉窗口里用不到的（纯内存，下次打开按 im.json 重建） */
  trimUnread(conv: Conv, member: string, threshold: number) {
    const window = conv.unread.get(member);
    if (!window || threshold + 1 < window.coveredFrom) return;
    window.incoming.splice(0, upperBound(window.incoming, threshold));
    window.coveredFrom = threshold + 1;
    window.capped = false;
  }

  /* ── 附件 ── */

  blobFile(sha: string) {
    return resolve(this.blobRoot, sha);
  }

  async blobMeta(sha: string): Promise<BlobMeta | null> {
    const known = this.blobs.get(sha);
    if (known) return known;
    let loading = this.blobLoads.get(sha);
    if (!loading) {
      loading = this.loadBlobMeta(sha).finally(() => this.blobLoads.delete(sha));
      this.blobLoads.set(sha, loading);
    }
    return loading;
  }

  private async loadBlobMeta(sha: string): Promise<BlobMeta | null> {
    const raw = await readJson<Partial<BlobMeta> & { kind?: BlobKind; mime?: string; refs?: BlobRef[] }>(
      resolve(this.blobRoot, `${sha}.json`),
    );
    if (!raw) return null;
    const info = await stat(this.blobFile(sha)).catch(() => null);
    if (!info?.isFile()) return null;
    const kinds: Partial<Record<BlobKind, string>> = raw.kinds && typeof raw.kinds === "object" ? raw.kinds : {};
    if (raw.kind && raw.mime && !kinds[raw.kind]) kinds[raw.kind] = raw.mime;
    const meta: BlobMeta = {
      sha,
      size: info.size,
      kinds,
      uploaders: Array.isArray(raw.uploaders) ? raw.uploaders : [],
      createdAt: Number(raw.createdAt) || 0,
    };
    if (Array.isArray(raw.refs) || raw.kind || raw.mime) {
      // 旧格式：refs 在 json 里。先追加进引用日志再改写 json（中途失败下次再搬，日志按集合去重）
      const legacy = (raw.refs ?? []).filter((ref) => ref && typeof ref.convId === "string" && isRefKind(ref.kind));
      if (legacy.length) await appendFile(this.refsFile(sha), legacy.map((ref) => refLine(ref)).join(""));
      const cached = this.refCache.get(sha);
      if (cached) {
        this.refCache.delete(sha);
        this.refTotal -= cached.size;
      }
      await this.writeBlobMeta(meta);
    }
    this.blobs.set(sha, this.blobs.get(sha) ?? meta);
    return this.blobs.get(sha) as BlobMeta;
  }

  private writeBlobMeta(meta: BlobMeta) {
    const data: BlobMeta = {
      sha: meta.sha,
      size: meta.size,
      kinds: meta.kinds,
      uploaders: meta.uploaders,
      createdAt: meta.createdAt,
    };
    return atomicWriteFile(resolve(this.blobRoot, `${meta.sha}.json`), JSON.stringify(data), { mkdir: true });
  }

  private refsFile(sha: string) {
    return resolve(this.blobRoot, `${sha}.refs.jsonl`);
  }

  /** 引用表（懒加载，LRU：最多 MAX_CACHED_REFS 个 blob，且引用总条数不超过 refBudget；刚用的那个不淘汰） */
  private blobRefs(sha: string): Promise<BlobRefs> {
    let entry = this.refCache.get(sha);
    if (entry) {
      this.refCache.delete(sha);
    } else {
      const loaded: RefEntry = { refs: this.loadRefs(sha), size: 0 };
      entry = loaded;
      loaded.refs.then(
        (refs) => {
          if (this.refCache.get(sha) !== loaded) return;
          for (const conv of refs.values()) loaded.size += conv.list.length;
          this.refTotal += loaded.size;
          this.evictRefs();
        },
        () => {
          if (this.refCache.get(sha) === loaded) this.refCache.delete(sha);
        },
      );
    }
    this.refCache.set(sha, entry);
    this.evictRefs();
    return entry.refs;
  }

  private evictRefs() {
    while (this.refCache.size > 1 && (this.refCache.size > MAX_CACHED_REFS || this.refTotal > this.refBudget)) {
      const [oldest, entry] = this.refCache.entries().next().value as [string, RefEntry];
      this.refCache.delete(oldest);
      this.refTotal -= entry.size;
    }
  }

  /** 内存里缓存着的引用总条数（测试用） */
  get cachedRefs() {
    return this.refTotal;
  }

  private async loadRefs(sha: string): Promise<BlobRefs> {
    const refs: BlobRefs = new Map();
    const text = await readFile(this.refsFile(sha), "utf8").catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return "";
      throw err;
    });
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const ref = JSON.parse(line) as BlobRef;
        if (typeof ref.convId === "string" && Number.isInteger(ref.seq) && isRefKind(ref.kind)) addRef(refs, ref);
      } catch {
        // 半行（追加到一半崩了）：跳过，下一次追加前会先补换行
      }
    }
    return refs;
  }

  /** 这个会话里引用这个 blob 的 (seq, kind)，按 seq 升序（只读，调用方从尾往前看就是从新到旧） */
  async refsIn(sha: string, convId: string): Promise<ReadonlyArray<{ seq: number; kind: BlobKind }>> {
    return (await this.blobRefs(sha)).get(convId)?.list ?? [];
  }

  /** 引用过这个 blob 的会话号 */
  async refConvs(sha: string): Promise<string[]> {
    return [...(await this.blobRefs(sha)).keys()];
  }

  /** 上传流写进临时文件，边写边算 sha256；超过 limit 抛 BlobTooLarge（请求暂停，不再读）。失败时临时文件已删 */
  async ingest(source: IncomingMessage | Buffer, limit: number): Promise<{ tmp: string; sha: string; size: number }> {
    await mkdir(this.blobRoot, { recursive: true });
    const tmp = resolve(this.blobRoot, `.upload-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
    const hash = createHash("sha256");
    const handle = await open(tmp, "w");
    let size = 0;
    try {
      if (Buffer.isBuffer(source)) {
        if (source.length > limit) throw new BlobTooLarge();
        hash.update(source);
        size = source.length;
        await handle.writeFile(source);
      } else {
        size = await pipeLimited(source, limit, (chunk) => {
          hash.update(chunk);
          return handle.write(chunk).then(() => undefined);
        });
      }
      await handle.close();
    } catch (err) {
      await handle.close().catch(() => undefined);
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
    return { tmp, sha: hash.digest("hex"), size };
  }

  /**
   * 临时文件归位到 blobs/<sha>，登记用途和上传者。先写 meta 再 rename：中途失败最多留下一个
   * 没有字节的 meta（blobMeta() 认作不存在，下次上传覆盖），不会有没 meta 的 blob。
   * 不管成功失败，返回时临时文件都不在了
   */
  commitBlob(
    upload: { tmp: string; sha: string; size: number },
    kind: BlobKind,
    mime: string,
    uploader: string,
    now: number,
  ): Promise<BlobMeta> {
    return this.serial(`blob:${upload.sha}`, async () => {
      try {
        const known = await this.blobMeta(upload.sha);
        const meta: BlobMeta = known
          ? { ...known, kinds: { ...known.kinds }, uploaders: [...known.uploaders] }
          : { sha: upload.sha, size: upload.size, kinds: {}, uploaders: [], createdAt: now };
        const changed = !known || !meta.kinds[kind] || !meta.uploaders.includes(uploader);
        meta.kinds[kind] ??= mime;
        if (!meta.uploaders.includes(uploader)) meta.uploaders.push(uploader);
        if (changed) await this.writeBlobMeta(meta);
        if (!known) await rename(upload.tmp, this.blobFile(upload.sha));
        this.blobs.set(meta.sha, meta);
        return meta;
      } finally {
        await unlink(upload.tmp).catch(() => undefined);
      }
    });
  }

  /** 已归位的同一份字节补登记另一个用途。分享扩展上传图片时原图同时作为缩略图使用。 */
  registerBlobKind(sha: string, kind: BlobKind, mime: string, uploader: string): Promise<BlobMeta | null> {
    return this.serial(`blob:${sha}`, async () => {
      const known = await this.blobMeta(sha);
      if (!known) return null;
      const meta: BlobMeta = { ...known, kinds: { ...known.kinds }, uploaders: [...known.uploaders] };
      const changed = !meta.kinds[kind] || !meta.uploaders.includes(uploader);
      meta.kinds[kind] ??= mime;
      if (!meta.uploaders.includes(uploader)) meta.uploaders.push(uploader);
      if (changed) await this.writeBlobMeta(meta);
      this.blobs.set(sha, meta);
      return meta;
    });
  }

  /** 测试和内部用：直接存一段字节，sha 由调用方给 */
  async putBlob(sha: string, buf: Buffer, mime: string, kind: BlobKind, uploader: string, now: number) {
    const upload = await this.ingest(buf, Number.MAX_SAFE_INTEGER);
    return this.commitBlob({ ...upload, sha }, kind, mime, uploader, now);
  }

  /** 幂等：同一 (会话, seq, 用途) 只记一次；只往 <sha>.refs.jsonl 追加一行，<sha>.json 不动 */
  addBlobRef(sha: string, ref: BlobRef): Promise<void> {
    return this.serial(`blob:${sha}`, async () => {
      if (!(await this.blobMeta(sha))) return;
      const loading = this.blobRefs(sha);
      const refs = await loading;
      if (refs.get(ref.convId)?.keys.has(refKey(ref))) return;
      const file = this.refsFile(sha);
      await terminateLine(file);
      await appendFile(file, refLine(ref));
      addRef(refs, ref);
      const entry = this.refCache.get(sha);
      if (entry?.refs === loading) {
        entry.size += 1;
        this.refTotal += 1;
        this.evictRefs();
      }
    });
  }

  /* ── 资料与个人设置（小文件，合并写；调用方 await 到自己的改动落盘） ── */

  /** 要先 await ready() */
  profile(id: string): Profile {
    return this.profiles[id] ?? {};
  }

  /** 写失败 reject（改动留在内存，稍后重试） */
  setProfile(id: string, profile: Profile): Promise<void> {
    this.profiles[id] = profile;
    return this.profileWriter.save();
  }

  user(id: string): Promise<UserState> {
    const known = this.users.get(id);
    if (known) return known;
    const loading = this.loadUser(id);
    this.users.set(id, loading);
    return loading;
  }

  private async loadUser(id: string): Promise<UserState> {
    const raw = await readJson<Partial<UserState>>(resolve(this.tenantDir(id), "im.json"));
    const convs: Record<string, ConvSettings> = {};
    if (raw?.convs && typeof raw.convs === "object") {
      for (const [convId, row] of Object.entries(raw.convs)) {
        if (!row || typeof row !== "object") continue;
        convs[convId] = {
          readSeq: Number(row.readSeq) || 0,
          pin: row.pin === true,
          mute: row.mute === true,
          hideBefore: Number(row.hideBefore) || 0,
        };
      }
    }
    const state: UserState = {
      convs,
      blocked: Array.isArray(raw?.blocked) ? raw.blocked.filter((item) => typeof item === "string") : [],
      notifyPreview: raw?.notifyPreview === true,
    };
    this.loadedUsers.set(id, state);
    return state;
  }

  /** 把这个用户的 im.json 落盘；resolve = 包含调用前所有改动的那次写成功了，写失败 reject 并稍后重试 */
  saveUser(id: string): Promise<void> {
    let writer = this.userWriters.get(id);
    if (!writer) {
      writer = this.writer(`im.json ${id}`, () => {
        const state = this.loadedUsers.get(id);
        return state ? { file: resolve(this.tenantDir(id), "im.json"), data: state } : null;
      });
      this.userWriters.set(id, writer);
    }
    return writer.save();
  }

  private writers(): Coalesced[] {
    return [this.profileWriter, ...this.userWriters.values(), ...this.metaWriters];
  }

  /** 等所有合并写落盘（测试、关机前） */
  async flush() {
    await Promise.all(this.writers().map((writer) => writer.flush()));
  }

  /** 进程退出时同步补写还没落盘的小文件 */
  writeAllSync() {
    for (const writer of this.writers()) writer.writeSync();
  }

  /** 不再使用：停掉重试定时器，从 exit 钩子里摘掉 */
  close() {
    for (const writer of this.writers()) writer.close();
    liveStores.delete(this);
  }
}

function errText(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

/** 崩溃可能留下没写完的半行：补一个换行，后面的追加不会和它粘在一起 */
async function terminateLine(file: string) {
  try {
    const handle = await open(file, "r");
    try {
      const { size } = await handle.stat();
      if (!size) return;
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, size - 1);
      if (last[0] !== 0x0a) await appendFile(file, "\n");
    } finally {
      await handle.close();
    }
  } catch {
    // 读不了的分段交给 readSegment 记日志
  }
}

/** 逐块交给 write（写完再读下一块）；超过 limit 就暂停请求并抛 BlobTooLarge */
function pipeLimited(req: IncomingMessage, limit: number, write: (chunk: Buffer) => Promise<void>): Promise<number> {
  return new Promise((done, fail) => {
    let size = 0;
    let settled = false;
    const finish = (err: Error | null) => {
      if (settled) return;
      settled = true;
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      req.removeListener("close", onClose);
      if (err) {
        req.pause();
        fail(err);
      } else done(size);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        finish(new BlobTooLarge());
        return;
      }
      req.pause();
      write(chunk).then(
        () => {
          if (!settled) req.resume();
        },
        (err: Error) => finish(err),
      );
    };
    const onEnd = () => finish(null);
    const onError = (err: Error) => finish(err);
    // 客户端中途断开不一定有 error，只保证有 close；不处理就留下临时文件
    const onClose = () => finish(new Error("上传中途断开"));
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("close", onClose);
    req.resume();
  });
}
