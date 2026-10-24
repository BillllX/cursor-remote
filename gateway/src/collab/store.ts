import { mkdir, open, readdir, readFile, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { atomicWriteFile } from "../fsAtomic.ts";
import { eventIdForKey } from "./ids.ts";
import type {
  CollabAggregate,
  CollabEffect,
  CollabEvent,
  CollabRun,
  CollabSnapshot,
  CollabStateView,
  CollabTask,
  EffectDelivery,
} from "./types.ts";

const EFFECT_TTL_MS = 180 * 24 * 60 * 60_000;
const EVENT_TTL_MS = 30 * 24 * 60 * 60_000;
const terminalRun = new Set(["completed", "failed", "cancelled"]);
const terminalTask = new Set(["succeeded", "failed", "cancelled", "blocked"]);

type AppendInput = {
  eventKey: string;
  aggregate: CollabAggregate;
  expectedVersion: number;
  type: string;
  payload?: Record<string, unknown>;
  effects?: CollabEffect[];
  at?: number;
};

type PreparedAppend = { input: AppendInput; event: CollabEvent };
type EventRecord = CollabEvent | { batch: CollabEvent[] };

function month(at: number) {
  return new Date(at).toISOString().slice(0, 7);
}

function parseLines<T>(text: string): T[] {
  const rows: T[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      // 崩溃留下的半行不是已提交记录，后续 append 会先补换行。
    }
  }
  return rows;
}

async function durableAppend(file: string, value: unknown) {
  await mkdir(dirname(file), { recursive: true });
  const handle = await open(file, "a+");
  try {
    const stat = await handle.stat();
    if (stat.size) {
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, stat.size - 1);
      if (last[0] !== 0x0a) await handle.write("\n");
    }
    await handle.write(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function parseEventRows(text: string) {
  return parseLines<EventRecord>(text).flatMap((row) => {
    if (row && typeof row === "object" && "batch" in row && Array.isArray(row.batch)) return row.batch;
    return row ? [row as CollabEvent] : [];
  });
}

async function durableAtomic(file: string, value: unknown) {
  await atomicWriteFile(file, JSON.stringify(value), { mkdir: true });
  const handle = await open(file, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function durableAtomicText(file: string, text: string) {
  await atomicWriteFile(file, text, { mkdir: true });
  const handle = await open(file, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** 事件日志是状态唯一事实源；cursor、effect 状态和 snapshot 都只是可重建投影。 */
export class CollabStore {
  readonly root: string;
  private loaded: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly runs = new Map<string, CollabRun>();
  private readonly tasks = new Map<string, CollabTask>();
  private readonly events: CollabEvent[] = [];
  private readonly eventKeys = new Set<string>();
  private readonly effects = new Map<string, EffectDelivery>();
  private cursors: Record<string, number> = {};

  constructor(stateDir: string) {
    this.root = resolve(stateDir, "collab");
  }

  ready() {
    this.loaded ??= this.load();
    return this.loaded;
  }

  private async load() {
    const eventDir = resolve(this.root, "events");
    const names = (await readdir(eventDir).catch(() => [] as string[]))
      .filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name))
      .sort();
    for (const name of names) {
      const rows = parseEventRows(await readFile(resolve(eventDir, name), "utf8").catch(() => ""));
      for (const row of rows) {
        if (!row?.eventKey || this.eventKeys.has(row.eventKey)) continue;
        this.apply(row);
      }
    }
    const snapshotDir = resolve(this.root, "snapshots");
    for (const name of (await readdir(snapshotDir).catch(() => [] as string[]))
      .filter((row) => row.endsWith(".json"))
      .sort()) {
      try {
        const snapshot = JSON.parse(await readFile(resolve(snapshotDir, name), "utf8")) as CollabSnapshot;
        if (!snapshot?.run?.id || !terminalRun.has(snapshot.run.status)) continue;
        const current = this.runs.get(snapshot.run.id);
        if (!current || snapshot.run.version > current.version) this.runs.set(snapshot.run.id, snapshot.run);
        for (const task of snapshot.tasks ?? []) {
          const known = this.tasks.get(task.id);
          if (!known || task.version > known.version) this.tasks.set(task.id, task);
        }
      } catch {
        // 单个损坏 snapshot 隔离；未清理的事件仍可重建。
      }
    }
    const dedupeDir = resolve(this.root, "dedupe");
    const dedupeNames = (await readdir(dedupeDir).catch(() => [] as string[]))
      .filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name))
      .sort();
    for (const name of dedupeNames) {
      const rows = parseLines<EffectDelivery>(await readFile(resolve(dedupeDir, name), "utf8").catch(() => ""));
      for (const row of rows) if (row?.key) this.effects.set(row.key, row);
    }
    try {
      this.cursors = JSON.parse(await readFile(resolve(this.root, "projectors", "trigger-scanner.json"), "utf8"));
    } catch {
      this.cursors = {};
    }
  }

  private versionOf(aggregate: CollabAggregate) {
    return aggregate.kind === "run"
      ? (this.runs.get(aggregate.id)?.version ?? 0)
      : (this.tasks.get(aggregate.id)?.version ?? 0);
  }

  private apply(event: CollabEvent) {
    if (this.eventKeys.has(event.eventKey)) return;
    if (this.versionOf(event.aggregate) !== event.expectedVersion) {
      throw new Error(`collab 日志 CAS 断裂：${event.eventKey}`);
    }
    if (event.aggregate.kind === "run") {
      const current = this.runs.get(event.aggregate.id);
      const created = event.payload.run as CollabRun | undefined;
      const patch = (event.payload.patch ?? {}) as Partial<CollabRun>;
      if (!current && !created) throw new Error(`collab Run 缺少创建载荷：${event.eventKey}`);
      this.runs.set(event.aggregate.id, {
        ...(current ?? created!),
        ...patch,
        version: event.nextVersion,
        updatedAt: event.at,
      });
    } else {
      const current = this.tasks.get(event.aggregate.id);
      const created = event.payload.task as CollabTask | undefined;
      const patch = (event.payload.patch ?? {}) as Partial<CollabTask>;
      if (!current && !created) throw new Error(`collab Task 缺少创建载荷：${event.eventKey}`);
      const next = {
        ...(current ?? created!),
        ...patch,
        version: event.nextVersion,
        updatedAt: event.at,
      };
      if (current && event.type === "task.retry") {
        next.attempts = [
          ...(current.attempts ?? []),
          {
            attempt: next.attempt,
            status: next.status,
            startedAt: event.at,
            childChatId: next.childChatId,
          },
        ];
      } else {
        const attempts = [...(next.attempts ?? [])];
        const at = Math.max(
          0,
          attempts.findIndex((attempt) => attempt.attempt === next.attempt),
        );
        const previous = attempts[at] ?? { attempt: next.attempt, status: next.status, startedAt: next.createdAt };
        attempts[at] = {
          ...previous,
          status: next.status,
          childChatId: next.childChatId,
          sourceTurnId: next.sourceTurnId,
          summary: next.summary,
          files: next.files,
          approval: next.approval,
          error: next.error,
          ...(["succeeded", "failed", "cancelled", "blocked"].includes(next.status) ? { endedAt: event.at } : {}),
        };
        next.attempts = attempts;
      }
      this.tasks.set(event.aggregate.id, next);
    }
    this.events.push(event);
    this.eventKeys.add(event.eventKey);
  }

  append(input: AppendInput): Promise<CollabEvent> {
    return this.serial(async () => {
      await this.ready();
      const duplicate = this.events.find((event) => event.eventKey === input.eventKey);
      if (duplicate) return duplicate;
      const currentVersion = this.versionOf(input.aggregate);
      if (currentVersion !== input.expectedVersion) {
        throw new Error(
          `collab CAS 冲突：${input.aggregate.kind}/${input.aggregate.id} 期望 ${input.expectedVersion}，实际 ${currentVersion}`,
        );
      }
      const current =
        input.aggregate.kind === "run" ? this.runs.get(input.aggregate.id) : this.tasks.get(input.aggregate.id);
      if (
        current &&
        input.type !== "task.retry" &&
        input.type !== "task.republish" &&
        input.type !== "run.retry" &&
        (input.aggregate.kind === "run"
          ? terminalRun.has((current as CollabRun).status)
          : terminalTask.has((current as CollabTask).status))
      ) {
        throw new Error(`collab 终态不可继续：${input.aggregate.kind}/${input.aggregate.id}`);
      }
      const at = input.at ?? Date.now();
      const event: CollabEvent = {
        eventId: eventIdForKey(input.eventKey),
        eventKey: input.eventKey,
        aggregate: input.aggregate,
        expectedVersion: input.expectedVersion,
        nextVersion: input.expectedVersion + 1,
        type: input.type,
        payload: input.payload ?? {},
        effects: input.effects ?? [],
        at,
      };
      await durableAppend(resolve(this.root, "events", `${month(at)}.jsonl`), event);
      this.apply(event);
      return event;
    });
  }

  /** 先完整校验，再用一次 fsync 提交同一批事件；内存只在落盘成功后更新。 */
  appendBatch(inputs: AppendInput[]): Promise<CollabEvent[]> {
    return this.serial(async () => {
      await this.ready();
      if (!inputs.length) return [];
      const versions = new Map<string, number>();
      const prepared: PreparedAppend[] = [];
      const at = inputs[0].at ?? Date.now();
      if (inputs.some((input) => month(input.at ?? at) !== month(at))) {
        throw new Error("collab batch 不能跨月提交");
      }
      for (const input of inputs) {
        const duplicate = this.events.find((event) => event.eventKey === input.eventKey);
        if (duplicate) {
          prepared.push({ input, event: duplicate });
          continue;
        }
        const key = `${input.aggregate.kind}:${input.aggregate.id}`;
        const currentVersion = versions.get(key) ?? this.versionOf(input.aggregate);
        if (currentVersion !== input.expectedVersion) {
          throw new Error(
            `collab CAS 冲突：${input.aggregate.kind}/${input.aggregate.id} 期望 ${input.expectedVersion}，实际 ${currentVersion}`,
          );
        }
        const current =
          input.aggregate.kind === "run" ? this.runs.get(input.aggregate.id) : this.tasks.get(input.aggregate.id);
        if (
          current &&
          input.type !== "task.retry" &&
          input.type !== "task.republish" &&
          input.type !== "run.retry" &&
          (input.aggregate.kind === "run"
            ? terminalRun.has((current as CollabRun).status)
            : terminalTask.has((current as CollabTask).status))
        ) {
          throw new Error(`collab 终态不可继续：${input.aggregate.kind}/${input.aggregate.id}`);
        }
        const eventAt = input.at ?? at;
        const event: CollabEvent = {
          eventId: eventIdForKey(input.eventKey),
          eventKey: input.eventKey,
          aggregate: input.aggregate,
          expectedVersion: input.expectedVersion,
          nextVersion: input.expectedVersion + 1,
          type: input.type,
          payload: input.payload ?? {},
          effects: input.effects ?? [],
          at: eventAt,
        };
        prepared.push({ input, event });
        versions.set(key, event.nextVersion);
      }
      const fresh = prepared.filter(({ event }) => !this.eventKeys.has(event.eventKey)).map(({ event }) => event);
      if (fresh.length) {
        // 一个 JSONL record 是 batch 的提交点；崩溃半行会整体被 parseLines 丢弃。
        await durableAppend(resolve(this.root, "events", `${month(at)}.jsonl`), { batch: fresh });
        for (const event of fresh) this.apply(event);
      }
      return prepared.map(({ event }) => event);
    });
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  run(id: string) {
    return this.runs.get(id);
  }

  task(id: string) {
    return this.tasks.get(id);
  }

  tasksForRun(runId: string) {
    return [...this.tasks.values()].filter((task) => task.runId === runId);
  }

  allRuns() {
    return [...this.runs.values()];
  }

  allTasks() {
    return [...this.tasks.values()];
  }

  pendingEffects(now = Date.now(), includeDeferredRetries = false) {
    return this.events
      .flatMap((event) => event.effects)
      .filter((effect) => {
        const state = this.effects.get(effect.key);
        return !state || (state.status === "retry" && (includeDeferredRetries || (state.nextAt ?? 0) <= now));
      });
  }

  effect(key: string) {
    return this.effects.get(key);
  }

  recordEffect(input: Omit<EffectDelivery, "at" | "expiresAt"> & { at?: number }) {
    return this.serial(async () => {
      await this.ready();
      const previous = this.effects.get(input.key);
      if (previous?.status === "delivered") return previous;
      const at = input.at ?? Date.now();
      const row: EffectDelivery = { ...input, at, expiresAt: at + EFFECT_TTL_MS };
      await durableAppend(resolve(this.root, "dedupe", `${month(at)}.jsonl`), row);
      this.effects.set(row.key, row);
      return row;
    });
  }

  cursor(convId: string) {
    return this.cursors[convId] ?? 0;
  }

  async advanceCursor(convId: string, seq: number) {
    await this.ready();
    if (seq <= this.cursor(convId)) return;
    this.cursors = { ...this.cursors, [convId]: seq };
    await durableAtomic(resolve(this.root, "projectors", "trigger-scanner.json"), this.cursors);
  }

  state(convId: string): CollabStateView {
    const runs = [...this.runs.values()]
      .filter((run) => run.convId === convId)
      // Map 插入顺序会受事件清理后加载 snapshot 的时机影响，不能作为“最新”语义。
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      .map((run) => ({
        runId: run.id,
        version: run.version,
        status: run.status,
        createdAt: run.createdAt,
        wave: run.wave,
        ...(run.explanation ? { explanation: run.explanation } : {}),
        ...(run.summary ? { summary: run.summary } : {}),
        ...(run.partial !== undefined ? { partial: run.partial } : {}),
        tasks: this.tasksForRun(run.id).map((task) => ({
          taskId: task.id,
          version: task.version,
          workspaceId: task.workspaceId,
          title: task.title,
          wave: task.wave,
          dependsOn: task.dependsOn,
          acceptance: task.acceptance,
          required: task.required,
          ...(task.suggestedNextActors?.length ? { suggestedNextActors: task.suggestedNextActors } : {}),
          status: task.status,
          attempt: task.attempt,
          attempts: task.attempts,
          ...(task.summary ? { summary: task.summary } : {}),
          ...(task.files?.length ? { files: task.files } : {}),
          ...(task.approval ? { approval: task.approval } : {}),
          ...(task.error ? { error: task.error } : {}),
        })),
      }));
    return { snapshotSeq: this.events.length, runs };
  }

  async writeSnapshot(runId: string) {
    const run = this.runs.get(runId);
    if (!run || !terminalRun.has(run.status)) return;
    const snapshot: CollabSnapshot = {
      run,
      tasks: this.tasksForRun(runId),
      snapshotSeq: this.events.length,
    };
    await durableAtomic(resolve(this.root, "snapshots", `${runId}.json`), snapshot);
  }

  /** 只删除已有终态 snapshot 且 trigger cursor 已越过的旧事件；dedupe 独立保留 180 天。 */
  async cleanup(now = Date.now()) {
    await this.ready();
    return this.serial(async () => {
      const removedEvents: string[] = [];
      const removedDedupe: string[] = [];
      const eventDir = resolve(this.root, "events");
      const eventFiles = await Promise.all(
        (await readdir(eventDir).catch(() => [] as string[]))
          .filter((row) => row.endsWith(".jsonl"))
          .map(async (name) => ({
            name,
            rows: parseEventRows(await readFile(resolve(eventDir, name), "utf8").catch(() => "")),
          })),
      );
      const taskRuns = new Map<string, string>();
      for (const { rows } of eventFiles) {
        for (const row of rows) {
          if (row.aggregate.kind !== "task") continue;
          const created = row.payload.task as CollabTask | undefined;
          const runId = created?.runId ?? this.tasks.get(row.aggregate.id)?.runId;
          if (runId) taskRuns.set(row.aggregate.id, runId);
        }
      }
      const runIdOf = (row: CollabEvent) =>
        row.aggregate.kind === "run" ? row.aggregate.id : taskRuns.get(row.aggregate.id);
      const oldFiles = new Set(
        eventFiles
          .filter(({ rows }) => rows.length > 0 && rows.every((row) => now - row.at >= EVENT_TTL_MS))
          .map(({ name }) => name),
      );
      // 一个 run 的事件必须全部位于本次候选文件中；跨月还有残留时一个月也不删。
      for (const { name, rows } of eventFiles) {
        if (!oldFiles.has(name)) continue;
        let safe = true;
        for (const row of rows) {
          const runId = runIdOf(row);
          const run = runId ? this.runs.get(runId) : undefined;
          const appearsOutside = eventFiles.some(
            (other) => !oldFiles.has(other.name) && other.rows.some((event) => runIdOf(event) === runId),
          );
          if (
            !runId ||
            !run ||
            appearsOutside ||
            !terminalRun.has(run.status) ||
            this.cursor(run.convId) < run.triggerSeq ||
            !(await readFile(resolve(this.root, "snapshots", `${runId}.json`), "utf8").catch(() => ""))
          ) {
            safe = false;
            break;
          }
        }
        if (!safe) oldFiles.delete(name);
      }
      // 文件互相包含多个 run 时迭代到稳定，避免删掉其中一个 run 的部分日志。
      let changed = true;
      while (changed) {
        changed = false;
        for (const { name, rows } of eventFiles) {
          if (!oldFiles.has(name)) continue;
          const partial = rows.some((row) => {
            const runId = runIdOf(row);
            return eventFiles.some(
              (other) => !oldFiles.has(other.name) && other.rows.some((event) => runIdOf(event) === runId),
            );
          });
          if (partial) {
            oldFiles.delete(name);
            changed = true;
          }
        }
      }
      for (const name of oldFiles) {
        await unlink(resolve(eventDir, name)).catch(() => undefined);
        removedEvents.push(name);
      }
      const dedupeDir = resolve(this.root, "dedupe");
      for (const name of (await readdir(dedupeDir).catch(() => [] as string[])).filter((row) =>
        row.endsWith(".jsonl"),
      )) {
        const file = resolve(dedupeDir, name);
        const rows = parseLines<EffectDelivery>(await readFile(file, "utf8").catch(() => ""));
        const retained = rows.filter((row) => row.expiresAt > now);
        if (retained.length === rows.length) continue;
        if (retained.length)
          await durableAtomicText(file, `${retained.map((row) => JSON.stringify(row)).join("\n")}\n`);
        else await unlink(file).catch(() => undefined);
        removedDedupe.push(name);
      }
      return { removedEvents, removedDedupe };
    });
  }
}
