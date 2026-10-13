// mergeAndCompactChat 的「上一份磁盘回合」索引：工具表 / files 表 / 工具 at 表。
//
// 全量实现每次都遍历 prev 的全部回合建这三张表，耗时随回合数线性增长。
// 这里把表缓存在 prev.turns 这个数组对象上（WeakMap 键于数组，会话删除/数组被替换后随 GC 回收，
// 不往 tenant 上挂任何结构），并在压缩产出新数组时只按「变化的位置」增量更新。
//
// 正确性约束：任何无法确定增量结果与全量重建一致的情形（同 key 出现重复、位置漂移过多、
// 数组长度和上次不符），一律丢弃索引整体重建。重建与旧全量实现的建表逻辑逐条一致。
import { toolsAtMapOf, turnIdOf } from "../runlog.ts";

export type IndexedTool = { args?: unknown; result?: unknown; review?: unknown };

/** key 的取值与出现次数：n>1 说明有重复，增量更新碰到就整体重建 */
type Slot<V> = { v: V; n: number };

export class CompactIndex {
  /** callId → 上一份里最后一个同 callId 的工具（后者覆盖，与旧 prevTools 一致） */
  tools = new Map<string, Slot<IndexedTool>>();
  /** 回合 id → 最后一个带 files 数组的同 id 回合（与 keepTurnFiles 一致） */
  files = new Map<string, Slot<unknown>>();
  /** 回合 id → 第一个有「带 at 工具」的同 id 回合的 callId→at 表（与 keepToolsAt 一致，先到先得） */
  at = new Map<string, Slot<Map<string, number>>>();
  /** tools 里 n>1 的 key 个数；为 0 时每个工具查到的必然是它自己 */
  dupTools = 0;
  /** 建索引/最近一次增量更新时数组的长度，用来识别「数组被原地改过」 */
  len = 0;
}

/** 回合里会进旧 prevTools 表的 (callId, 工具) 列表，判定口径与旧实现完全相同 */
function eachTool(turn: unknown, fn: (callId: string, tool: IndexedTool) => void) {
  if (!turn || typeof turn !== "object" || !Array.isArray((turn as { tools?: unknown }).tools)) return;
  for (const tool of (turn as { tools: unknown[] }).tools) {
    if (!tool || typeof tool !== "object") continue;
    const callId = (tool as { callId?: unknown }).callId;
    if (typeof callId !== "string" || !callId) continue;
    fn(callId, tool as IndexedTool);
  }
}

/** 回合的 files 条目：id 非空且 files 是数组才有 */
function filesKey(turn: unknown): string {
  const id = turnIdOf(turn);
  if (!id || !Array.isArray((turn as { files?: unknown }).files)) return "";
  return id;
}

/** 全量建表（首次、缓存失效、增量放弃时用）。与旧 mergeAndCompactChat/keepTurnFiles/keepToolsAt 的建表逐条一致 */
export function buildIndex(turns: readonly unknown[]): CompactIndex {
  const index = new CompactIndex();
  index.len = turns.length;
  for (const turn of turns) {
    eachTool(turn, (callId, tool) => {
      const hit = index.tools.get(callId);
      if (hit) {
        if (hit.n === 1) index.dupTools += 1;
        hit.v = tool;
        hit.n += 1;
      } else {
        index.tools.set(callId, { v: tool, n: 1 });
      }
    });
    const fid = filesKey(turn);
    if (fid) {
      const hit = index.files.get(fid);
      if (hit) {
        hit.v = turn;
        hit.n += 1;
      } else {
        index.files.set(fid, { v: turn, n: 1 });
      }
    }
    const id = turnIdOf(turn);
    if (id) {
      const atById = toolsAtMapOf(turn);
      if (atById) {
        const hit = index.at.get(id);
        if (hit) hit.n += 1;
        else index.at.set(id, { v: atById, n: 1 });
      }
    }
  }
  return index;
}

/** 摘掉一个回合在索引里的条目；碰到重复 key 或对不上返回 false（调用方整体重建） */
function removeTurn(index: CompactIndex, turn: unknown): boolean {
  let ok = true;
  eachTool(turn, (callId, tool) => {
    const hit = index.tools.get(callId);
    if (!hit || hit.n !== 1 || hit.v !== tool) ok = false;
    else index.tools.delete(callId);
  });
  if (!ok) return false;
  const fid = filesKey(turn);
  if (fid) {
    const hit = index.files.get(fid);
    if (!hit || hit.n !== 1 || hit.v !== turn) return false;
    index.files.delete(fid);
  }
  const id = turnIdOf(turn);
  if (id) {
    const atById = toolsAtMapOf(turn);
    if (atById) {
      const hit = index.at.get(id);
      if (!hit || hit.n !== 1) return false;
      index.at.delete(id);
    }
  }
  return true;
}

/** 把一个回合加进索引；key 已存在（出现重复）返回 false */
function addTurn(index: CompactIndex, turn: unknown): boolean {
  let ok = true;
  eachTool(turn, (callId, tool) => {
    if (index.tools.has(callId)) ok = false;
    else index.tools.set(callId, { v: tool, n: 1 });
  });
  if (!ok) return false;
  const fid = filesKey(turn);
  if (fid) {
    if (index.files.has(fid)) return false;
    index.files.set(fid, { v: turn, n: 1 });
  }
  const id = turnIdOf(turn);
  if (id) {
    const atById = toolsAtMapOf(turn);
    if (atById) {
      if (index.at.has(id)) return false;
      index.at.set(id, { v: atById, n: 1 });
    }
  }
  return true;
}

/** 位置漂移超过它就不做增量（比如整段回合错位），直接重建 */
const MAX_DELTA = 48;

/** oldTurns → newTurns 之间逐位置不同的下标；超过上限返回 null */
function changedPositions(oldTurns: readonly unknown[], newTurns: readonly unknown[]): number[] | null {
  const out: number[] = [];
  const max = Math.max(oldTurns.length, newTurns.length);
  for (let i = 0; i < max; i += 1) {
    if (oldTurns[i] === newTurns[i] && i < oldTurns.length && i < newTurns.length) continue;
    out.push(i);
    if (out.length > MAX_DELTA) return null;
  }
  return out;
}

/** 数组 → 它当前对应的索引（谁的索引就挂在谁的数组上） */
const owned = new WeakMap<readonly unknown[], CompactIndex>();
/** 新数组 → 「由哪个数组、哪个索引算出」的待应用增量。惰性应用：产出没被采用就不花任何代价 */
const pending = new WeakMap<readonly unknown[], { base: CompactIndex; from: readonly unknown[] }>();

/** 取 turns 对应的索引：命中缓存直接用；有待应用增量就增量更新；否则全量重建 */
export function indexFor(turns: readonly unknown[]): CompactIndex {
  const cached = owned.get(turns);
  if (cached && cached.len === turns.length) return cached;
  const delta = pending.get(turns);
  if (delta) {
    pending.delete(turns);
    const { base, from } = delta;
    // base 必须还停在 from 上（没有被别的产出抢先转走）且 from 没被原地改过长度
    if (owned.get(from) === base && base.len === from.length) {
      const changed = changedPositions(from, turns);
      if (changed) {
        let ok = true;
        for (const i of changed) {
          if (i < from.length && !removeTurn(base, from[i])) {
            ok = false;
            break;
          }
        }
        if (ok) {
          for (const i of changed) {
            if (i < turns.length && !addTurn(base, turns[i])) {
              ok = false;
              break;
            }
          }
        }
        if (ok) {
          owned.delete(from);
          base.len = turns.length;
          owned.set(turns, base);
          return base;
        }
        // 增量走到一半失败，base 已被改乱：必须从 owned 摘掉，别让别人再用
        owned.delete(from);
      }
    }
  }
  const built = buildIndex(turns);
  owned.set(turns, built);
  return built;
}

/** 登记「newTurns 是在 base（挂在 from 上）基础上算出的」，下次要用 newTurns 的索引时再增量更新 */
export function noteDerived(newTurns: readonly unknown[], from: readonly unknown[], base: CompactIndex) {
  if (newTurns === from) return;
  pending.set(newTurns, { base, from });
}
