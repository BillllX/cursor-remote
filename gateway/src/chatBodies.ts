import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 会话正文单独存放：state.json 只留元数据，正文按会话分目录、每 SEGMENT_TURNS 轮一个文件。
 * 分段文件按内容哈希命名、写好后不再改：先写新分段，再提交 state.json，最后删没人引用的旧分段，
 * 崩在任何一步，盘上的 state.json 指向的分段都是完整的。
 * 写盘时只写变了的分段；内存里只留最近用过的几条会话的正文，其余在读 `chat.turns` 时再从磁盘装回。
 *
 * 判脏靠引用：分段里的每个 turn 对象和上次写盘时相同就视为没变。改 turn 必须换新对象，不能原地改字段。
 */

export const SEGMENT_TURNS = 100;
const MAX_RESIDENT_CHATS = 16;
const MAX_RESIDENT_BYTES = 64 * 1024 * 1024;

/** state.json 里每条会话的 body 字段 */
export type BodyInfo = { count: number; preview: string; segs: string[]; sizes: number[] };

type BodyRecord = {
  /** 上次写盘（或从盘上装回）时每段的 turn 引用；换出内存后清空 */
  segRefs: unknown[][];
  segHashes: string[];
  segSizes: number[];
  /** 本进程写过：装回时不用再收尾上次进程遗留的「运行中」标记 */
  fresh: boolean;
  /** 装回时有分段读不出或内容对不上哈希：内存里的正文不完整。没改动时沿用这份旧描述；有改动时先把目录复制到 chats-broken/ 再写 */
  broken?: BodyInfo;
  /** broken 时装回返回的 turn 引用，用来判断之后有没有改动 */
  loaded?: unknown[];
};

export type BodyStore = {
  dir: string;
  records: Map<string, BodyRecord>;
  touched: Map<string, number>;
  /** 本轮写过分段、提交 state.json 后要清理旧分段的会话 */
  sweep: Set<string>;
  /** 进程里还没清理过：第一次写盘后把所有会话目录都扫一遍，清掉上次崩溃留下的分段和目录 */
  fullSweep: boolean;
  settle: (turns: unknown[]) => unknown[];
};

const BODY = Symbol("chatBody");
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
let clock = 0;

export function createBodyStore(stateDir: string, settle: (turns: unknown[]) => unknown[]): BodyStore {
  return { dir: resolve(stateDir, "chats"), records: new Map(), touched: new Map(), sweep: new Set(), fullSweep: true, settle };
}

function chatDir(store: BodyStore, id: string) {
  // 点号不在 SAFE_ID 里，哈希目录名不会和真实 id 撞
  const key = SAFE_ID.test(id) ? id : `x.${createHash("sha1").update(id).digest("hex")}`;
  return resolve(store.dir, key);
}

function segName(hash: string) {
  return `${hash}.json`;
}

function touch(store: BodyStore, id: string) {
  clock += 1;
  store.touched.set(id, clock);
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

/** 与 iOS preview 语义逐字对齐：先倒序找最后一条非空 user，没有再倒序找 assistant */
export function previewOfTurns(turns: unknown[]): string {
  for (const key of ["user", "assistant"] as const) {
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const turn = turns[i];
      if (!turn || typeof turn !== "object") continue;
      const text = (turn as Record<string, unknown>)[key];
      if (typeof text === "string" && text.trim()) return text.slice(0, 100);
    }
  }
  return "";
}

/** 正文在内存里（或这条会话本来就没有 turns 键）。不会触发从磁盘装回 */
export function isBodyLoaded(chat: unknown): boolean {
  if (!chat || typeof chat !== "object") return true;
  const desc = Object.getOwnPropertyDescriptor(chat, "turns");
  return !desc || "value" in desc;
}

/** 条数和预览；没有 turns 键时返回 null。不会触发装回 */
export function bodySummary(chat: unknown): { count: number; preview: string } | null {
  if (!chat || typeof chat !== "object") return null;
  if (!isBodyLoaded(chat)) {
    const info = (chat as { [BODY]?: BodyInfo })[BODY];
    return { count: info?.count ?? 0, preview: info?.preview ?? "" };
  }
  const turns = (chat as { turns?: unknown }).turns;
  if (!Array.isArray(turns)) return null;
  return { count: turns.length, preview: previewOfTurns(turns) };
}

/** 除 turns 外的字段浅拷贝。不会触发装回 */
export function chatMeta(chat: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(chat)) {
    if (key !== "turns") out[key] = chat[key];
  }
  return out;
}

function loadBody(store: BodyStore, id: string, info: BodyInfo): unknown[] {
  const dir = chatDir(store, id);
  const record = store.records.get(id);
  const turns: unknown[] = [];
  const segRefs: unknown[][] = [];
  let broken = false;
  for (let i = 0; i < info.segs.length; i += 1) {
    let rows: unknown[] = [];
    try {
      const text = readFileSync(resolve(dir, segName(info.segs[i])), "utf8");
      if (createHash("sha1").update(text).digest("hex") !== info.segs[i]) throw new Error("内容和哈希对不上");
      const parsed = JSON.parse(text) as unknown;
      if (!Array.isArray(parsed)) throw new Error("不是数组");
      rows = parsed;
    } catch (err) {
      broken = true;
      console.warn("会话正文分段读取失败，有改动时会先把原目录复制到 chats-broken/", id, segName(info.segs[i]), err instanceof Error ? err.message : err);
    }
    let seg = rows;
    if (!record?.fresh) {
      const settled = store.settle(rows);
      // 收尾改过的分段不记引用，下次写盘按哈希比对会把收尾结果写回去
      seg = settled;
      segRefs.push(settled.every((turn, at) => turn === rows[at]) ? settled : []);
    } else {
      segRefs.push(rows);
    }
    turns.push(...seg);
  }
  store.records.set(id, {
    segRefs,
    segHashes: info.segs.slice(),
    segSizes: info.sizes.slice(),
    fresh: record?.fresh ?? false,
    broken: broken ? info : undefined,
    loaded: broken ? turns.slice() : undefined,
  });
  touch(store, id);
  return turns;
}

function installStub(store: BodyStore, chat: Record<string, unknown>, id: string, info: BodyInfo) {
  Object.defineProperty(chat, BODY, { value: info, enumerable: false, configurable: true, writable: true });
  Object.defineProperty(chat, "turns", {
    enumerable: true,
    configurable: true,
    get() {
      const turns = loadBody(store, id, info);
      Object.defineProperty(chat, "turns", { value: turns, enumerable: true, configurable: true, writable: true });
      return turns;
    },
    set(value: unknown) {
      Object.defineProperty(chat, "turns", { value, enumerable: true, configurable: true, writable: true });
      touch(store, id);
    },
  });
}

function readInfo(raw: unknown): BodyInfo {
  const body = (raw && typeof raw === "object" ? raw : {}) as Partial<BodyInfo>;
  const segs = Array.isArray(body.segs) ? body.segs.filter((s): s is string => typeof s === "string") : [];
  const sizes = Array.isArray(body.sizes) ? body.sizes.map((n) => (typeof n === "number" ? n : 0)) : [];
  return {
    count: typeof body.count === "number" ? body.count : 0,
    preview: typeof body.preview === "string" ? body.preview : "",
    segs,
    sizes: segs.map((_, i) => sizes[i] ?? 0),
  };
}

/** 读 state.json 时：带 body 描述、没有内联 turns 的行换成按需装回的会话 */
export function hydrateChat(store: BodyStore, row: unknown): unknown {
  if (!row || typeof row !== "object") return row;
  const rec = row as Record<string, unknown>;
  const hasBody = "body" in rec;
  const info = readInfo(rec.body);
  delete rec.body;
  const id = typeof rec.id === "string" ? rec.id : "";
  if (!hasBody || !id || Array.isArray(rec.turns) || store.records.has(id)) return rec;
  store.records.set(id, { segRefs: [], segHashes: info.segs.slice(), segSizes: info.sizes.slice(), fresh: false });
  installStub(store, rec, id, info);
  return rec;
}

function sameRefs(a: unknown[] | undefined, b: unknown[]) {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < b.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** 写一条会话的正文，返回 state.json 里的 body 描述。只重写变了的分段 */
function writeBody(store: BodyStore, id: string, turns: unknown[], preview: string): BodyInfo {
  const prev = store.records.get(id);
  const dir = chatDir(store, id);
  const segCount = Math.ceil(turns.length / SEGMENT_TURNS);
  const segRefs: unknown[][] = [];
  const segHashes: string[] = [];
  const segSizes: number[] = [];
  const pending = new Map<string, string>();
  for (let i = 0; i < segCount; i += 1) {
    const refs = turns.slice(i * SEGMENT_TURNS, (i + 1) * SEGMENT_TURNS);
    segRefs.push(refs);
    const known = prev?.segHashes[i];
    if (known && sameRefs(prev?.segRefs[i], refs)) {
      segHashes.push(known);
      segSizes.push(prev?.segSizes[i] ?? 0);
      continue;
    }
    const text = JSON.stringify(refs);
    const hash = createHash("sha1").update(text).digest("hex");
    segHashes.push(hash);
    segSizes.push(Buffer.byteLength(text));
    if (hash === known) continue;
    pending.set(hash, text);
  }
  if (pending.size) {
    mkdirSync(dir, { recursive: true });
    for (const [hash, text] of pending) {
      const file = resolve(dir, segName(hash));
      if (existsSync(file) && createHash("sha1").update(readFileSync(file, "utf8")).digest("hex") === hash) continue;
      writeFileSync(`${file}.tmp`, text);
      renameSync(`${file}.tmp`, file);
    }
  }
  const changed = pending.size > 0 || segHashes.length !== (prev?.segHashes.length ?? 0);
  if (changed) store.sweep.add(id);
  store.records.set(id, { segRefs, segHashes, segSizes, fresh: Boolean(prev?.fresh) || pending.size > 0 });
  if (pending.size || !prev) touch(store, id);
  return { count: turns.length, preview, segs: segHashes, sizes: segSizes };
}

/**
 * 写盘前调用：把每条会话拆成 state.json 里的元数据行，正文写进分段文件。
 * 没有 id、id 重复或 turns 不是数组的会话原样留在行里（内联），保证不丢。
 * 写分段失败会抛出，调用方此时不能写 state.json。
 */
export function persistBodies(store: BodyStore, chats: unknown[]): unknown[] {
  const seen = new Set<string>();
  const rows: unknown[] = [];
  for (const item of chats) {
    if (!item || typeof item !== "object") {
      rows.push(item);
      continue;
    }
    const chat = item as Record<string, unknown>;
    const id = typeof chat.id === "string" ? chat.id : "";
    if (!id || seen.has(id)) {
      rows.push({ ...chat });
      continue;
    }
    seen.add(id);
    const meta = chatMeta(chat);
    if (!isBodyLoaded(chat)) {
      meta.body = (chat as { [BODY]?: BodyInfo })[BODY];
      rows.push(meta);
      continue;
    }
    if (!("turns" in chat)) {
      rows.push(meta);
      continue;
    }
    const turns = chat.turns;
    if (!Array.isArray(turns)) {
      rows.push({ ...meta, turns });
      continue;
    }
    const record = store.records.get(id);
    if (record?.broken) {
      if (sameRefs(record.loaded, turns)) {
        meta.body = record.broken;
        rows.push(meta);
        continue;
      }
      quarantine(store, id);
      store.records.set(id, { ...record, segRefs: [], segHashes: [], segSizes: [], broken: undefined, loaded: undefined });
    }
    meta.body = writeBody(store, id, turns, previewOfTurns(turns));
    rows.push(meta);
  }
  return rows;
}

/** 正文有损坏的会话要写新内容前，把整个目录原样留一份，供人工恢复。复制失败会抛出，这次不写盘 */
function quarantine(store: BodyStore, id: string) {
  const dir = chatDir(store, id);
  if (!existsSync(dir)) return;
  const target = resolve(store.dir, "..", "chats-broken", `${dir.slice(store.dir.length + 1)}-${Date.now()}`);
  cpSync(dir, target, { recursive: true });
  console.warn("会话正文有损坏，原目录已复制到", target);
}

/** state.json 写成功后调用：删掉已不存在的会话的正文目录，以及本轮换下来的旧分段 */
export function dropRemovedBodies(store: BodyStore, chats: unknown[]) {
  const live = new Set<string>();
  for (const item of chats) {
    const id = item && typeof item === "object" ? (item as { id?: unknown }).id : null;
    if (typeof id === "string") live.add(id);
  }
  for (const id of [...store.records.keys()]) {
    if (live.has(id)) continue;
    store.records.delete(id);
    store.touched.delete(id);
    rmSync(chatDir(store, id), { recursive: true, force: true });
  }
  if (store.fullSweep) {
    const dirs = new Set([...live].map((id) => chatDir(store, id)));
    let names: string[] = [];
    try {
      names = readdirSync(store.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    for (const name of names) {
      const dir = resolve(store.dir, name);
      if (!dirs.has(dir)) rmSync(dir, { recursive: true, force: true });
    }
    for (const id of store.records.keys()) store.sweep.add(id);
    store.fullSweep = false;
  }
  for (const id of [...store.sweep]) {
    const record = store.records.get(id);
    try {
      if (record) sweepChat(store, id, record);
      store.sweep.delete(id);
    } catch (err) {
      console.warn("清理旧分段失败，下次写盘再试", id, err instanceof Error ? err.message : err);
    }
  }
}

function sweepChat(store: BodyStore, id: string, record: BodyRecord) {
  const dir = chatDir(store, id);
  if (!record.segHashes.length) {
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  const keep = new Set(record.segHashes.map(segName));
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const name of names) {
    if (keep.has(name)) continue;
    try {
      unlinkSync(resolve(dir, name));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}

/** 写盘后调用：超出预算时，把最久没用的会话正文换出内存。刚写完，盘上就是最新的 */
export function evictBodies(store: BodyStore, chats: unknown[], rows: unknown[]) {
  const resident: Array<{ chat: Record<string, unknown>; id: string; at: number; info: BodyInfo }> = [];
  for (let i = 0; i < chats.length; i += 1) {
    const chat = chats[i];
    const info = (rows[i] as { body?: BodyInfo } | undefined)?.body;
    if (!info || !chat || typeof chat !== "object" || !isBodyLoaded(chat)) continue;
    const id = (chat as { id?: unknown }).id;
    if (typeof id !== "string") continue;
    resident.push({ chat: chat as Record<string, unknown>, id, at: store.touched.get(id) ?? 0, info });
  }
  resident.sort((a, b) => b.at - a.at);
  let bytes = 0;
  for (let i = 0; i < resident.length; i += 1) {
    const item = resident[i];
    bytes += sum(item.info.sizes);
    if (i === 0 || (i < MAX_RESIDENT_CHATS && bytes <= MAX_RESIDENT_BYTES)) continue;
    const record = store.records.get(item.id);
    if (record) record.segRefs = [];
    installStub(store, item.chat, item.id, item.info);
    store.touched.delete(item.id);
  }
}
