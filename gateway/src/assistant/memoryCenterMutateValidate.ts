import { isValidCalendarDateUtc } from "../../../shared/calendarDateUtc.ts";
import type {
  MemoryCenterMutateArgs,
  MemoryCenterMutateErrorCode,
  MemoryCenterMutateMutation,
  MemoryCenterMutatePatch,
} from "../../../shared/protocol.ts";
import { SECTIONS } from "./workspaceMemory.ts";

export const MAX_MUTATE_TEXT_CODEPOINTS = 4_000;
export const MAX_MUTATE_TEXT_UTF8_BYTES = 12_000;
export const MAX_MUTATE_REFS = 5;
export const MAX_MUTATE_REF_LEN = 240;

const PATCH_KEYS = new Set(["section", "text", "refs", "pinned", "state", "expires"]);
const CREATE_KEYS = new Set(["action", "section", "text", "refs", "pinned", "state", "expires"]);
const UPDATE_KEYS = new Set(["action", "id", "revision", "patch"]);
const SET_STATE_KEYS = new Set(["action", "id", "revision", "state"]);
const SET_PINNED_KEYS = new Set(["action", "id", "revision", "pinned"]);
const DELETE_KEYS = new Set(["action", "id", "revision"]);

export type ValidateFail = { ok: false; code: MemoryCenterMutateErrorCode; message: string };
export type ValidateOk = { ok: true; value: MemoryCenterMutateArgs };

function fail(code: MemoryCenterMutateErrorCode, message: string): ValidateFail {
  return { ok: false, code, message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(obj: Record<string, unknown>, allowed: Set<string>): ValidateFail | null {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) return fail("invalid_input", `未知字段：${key}`);
  }
  return null;
}

function codePointCount(text: string) {
  return [...text].length;
}

function normalizeBodyText(raw: unknown): { ok: true; text: string } | ValidateFail {
  if (typeof raw !== "string") return fail("invalid_input", "正文必须是字符串。");
  const text = raw
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<!--|-->/g, " ")
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return fail("invalid_input", "正文不能为空。");
  const cps = codePointCount(text);
  if (cps > MAX_MUTATE_TEXT_CODEPOINTS) {
    return fail("invalid_input", `正文超过 ${MAX_MUTATE_TEXT_CODEPOINTS} 个字符（按码点计）。`);
  }
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_MUTATE_TEXT_UTF8_BYTES) {
    return fail("invalid_input", `正文 UTF-8 超过 ${MAX_MUTATE_TEXT_UTF8_BYTES} 字节。`);
  }
  return { ok: true, text };
}

function parseRefs(raw: unknown): { ok: true; refs: string[] } | ValidateFail {
  if (raw === undefined) return { ok: true, refs: [] };
  if (!Array.isArray(raw) || raw.some((r) => typeof r !== "string")) {
    return fail("invalid_input", "refs 必须是字符串数组。");
  }
  const refs = raw.map((r) => r.trim()).filter(Boolean);
  if (refs.length > MAX_MUTATE_REFS) return fail("invalid_input", `引用最多 ${MAX_MUTATE_REFS} 条。`);
  for (const ref of refs) {
    if (ref.length > MAX_MUTATE_REF_LEN) return fail("invalid_input", "单条引用路径过长。");
  }
  return { ok: true, refs };
}

function parseExpires(raw: unknown, required = false): { ok: true; expires?: string } | ValidateFail {
  if (raw === undefined) return required ? fail("invalid_input", "缺少 expires。") : { ok: true };
  if (raw === null) return { ok: true, expires: undefined };
  if (typeof raw !== "string" || !isValidCalendarDateUtc(raw)) {
    return fail("invalid_input", "expires 必须是合法 UTC 日历日 YYYY-MM-DD。");
  }
  return { ok: true, expires: raw };
}

function parseSection(raw: unknown): { ok: true; section: (typeof SECTIONS)[number] } | ValidateFail {
  if (typeof raw !== "string" || !(SECTIONS as readonly string[]).includes(raw)) {
    return fail("invalid_input", "章节不在允许列表中。");
  }
  return { ok: true, section: raw as (typeof SECTIONS)[number] };
}

type MutateState = "hot" | "cold" | "done";
type ParseStateOk = { ok: true; state?: MutateState | null };

function parseState(raw: unknown, allowNull: true): ParseStateOk | ValidateFail;
function parseState(raw: unknown, allowNull?: false): { ok: true; state?: MutateState } | ValidateFail;
function parseState(raw: unknown, allowNull = false): ParseStateOk | ValidateFail {
  if (raw === undefined) return { ok: true };
  if (raw === null) return allowNull ? { ok: true, state: null } : fail("invalid_input", "state 不能为 null。");
  if (raw !== "hot" && raw !== "cold" && raw !== "done") {
    return fail("invalid_input", "state 只能是 hot、cold 或 done。");
  }
  return { ok: true, state: raw };
}

function parsePatch(raw: unknown): { ok: true; patch: MemoryCenterMutatePatch } | ValidateFail {
  if (!isPlainObject(raw)) return fail("invalid_input", "patch 必须是对象。");
  const unknown = assertExactKeys(raw, PATCH_KEYS);
  if (unknown) return unknown;
  const keys = Object.keys(raw);
  if (!keys.length) return fail("invalid_input", "patch 至少包含一个字段。");
  const patch: MemoryCenterMutatePatch = {};
  if (raw.section !== undefined) {
    const sec = parseSection(raw.section);
    if (!sec.ok) return sec;
    patch.section = sec.section;
  }
  if (raw.text !== undefined) {
    const body = normalizeBodyText(raw.text);
    if (!body.ok) return body;
    patch.text = body.text;
  }
  if (raw.refs !== undefined) {
    const refs = parseRefs(raw.refs);
    if (!refs.ok) return refs;
    patch.refs = refs.refs;
  }
  if (raw.pinned !== undefined) {
    if (typeof raw.pinned !== "boolean") return fail("invalid_input", "pinned 必须是布尔值。");
    patch.pinned = raw.pinned;
  }
  if (raw.state !== undefined) {
    const st = parseState(raw.state, true);
    if (!st.ok) return st;
    patch.state = st.state ?? null;
  }
  if (raw.expires !== undefined) {
    if (raw.expires === null) patch.expires = null;
    else {
      const ex = parseExpires(raw.expires, true);
      if (!ex.ok) return ex;
      patch.expires = ex.expires ?? null;
    }
  }
  return { ok: true, patch };
}

function parseMutation(raw: unknown): { ok: true; mutation: MemoryCenterMutateMutation } | ValidateFail {
  if (!isPlainObject(raw)) return fail("invalid_input", "mutation 必须是对象。");
  const action = raw.action;
  if (typeof action !== "string") return fail("invalid_input", "mutation.action 无效。");

  if (action === "create") {
    const bad = assertExactKeys(raw, CREATE_KEYS);
    if (bad) return bad;
    const sec = parseSection(raw.section);
    if (!sec.ok) return sec;
    const body = normalizeBodyText(raw.text);
    if (!body.ok) return body;
    const refs = parseRefs(raw.refs);
    if (!refs.ok) return refs;
    let pinned: boolean | undefined;
    if (raw.pinned !== undefined) {
      if (typeof raw.pinned !== "boolean") return fail("invalid_input", "pinned 必须是布尔值。");
      pinned = raw.pinned;
    }
    const st = parseState(raw.state);
    if (!st.ok) return st;
    const ex = parseExpires(raw.expires);
    if (!ex.ok) return ex;
    if (pinned && st.state === "done") {
      return fail("invalid_input", "新建时不能同时置顶并标为完成。");
    }
    return {
      ok: true,
      mutation: {
        action: "create",
        section: sec.section,
        text: body.text,
        refs: refs.refs.length ? refs.refs : undefined,
        pinned,
        state: st.state,
        expires: ex.expires,
      },
    };
  }

  if (action === "update") {
    const bad = assertExactKeys(raw, UPDATE_KEYS);
    if (bad) return bad;
    if (typeof raw.id !== "string" || !raw.id.trim()) return fail("invalid_input", "缺少 id。");
    if (typeof raw.revision !== "string" || !raw.revision.trim()) return fail("invalid_input", "缺少 revision。");
    const patch = parsePatch(raw.patch);
    if (!patch.ok) return patch;
    return {
      ok: true,
      mutation: { action: "update", id: raw.id.trim(), revision: raw.revision.trim(), patch: patch.patch },
    };
  }

  if (action === "set_state") {
    const bad = assertExactKeys(raw, SET_STATE_KEYS);
    if (bad) return bad;
    if (typeof raw.id !== "string" || !raw.id.trim()) return fail("invalid_input", "缺少 id。");
    if (typeof raw.revision !== "string" || !raw.revision.trim()) return fail("invalid_input", "缺少 revision。");
    const st = parseState(raw.state);
    if (!st.ok || !st.state) return fail("invalid_input", "set_state 需要 state。");
    return {
      ok: true,
      mutation: { action: "set_state", id: raw.id.trim(), revision: raw.revision.trim(), state: st.state },
    };
  }

  if (action === "set_pinned") {
    const bad = assertExactKeys(raw, SET_PINNED_KEYS);
    if (bad) return bad;
    if (typeof raw.id !== "string" || !raw.id.trim()) return fail("invalid_input", "缺少 id。");
    if (typeof raw.revision !== "string" || !raw.revision.trim()) return fail("invalid_input", "缺少 revision。");
    if (typeof raw.pinned !== "boolean") return fail("invalid_input", "pinned 必须是布尔值。");
    return {
      ok: true,
      mutation: { action: "set_pinned", id: raw.id.trim(), revision: raw.revision.trim(), pinned: raw.pinned },
    };
  }

  if (action === "delete") {
    const bad = assertExactKeys(raw, DELETE_KEYS);
    if (bad) return bad;
    if (typeof raw.id !== "string" || !raw.id.trim()) return fail("invalid_input", "缺少 id。");
    if (typeof raw.revision !== "string" || !raw.revision.trim()) return fail("invalid_input", "缺少 revision。");
    return {
      ok: true,
      mutation: { action: "delete", id: raw.id.trim(), revision: raw.revision.trim() },
    };
  }

  return fail("invalid_input", `不支持的 mutation.action：${action}`);
}

/** 运行时 schema：拒绝未知字段与类型漂移。 */
export function validateMemoryCenterMutateArgs(raw: Record<string, unknown>): ValidateOk | ValidateFail {
  if (!isPlainObject(raw)) return fail("invalid_input", "args 必须是对象。");
  for (const key of Object.keys(raw)) {
    if (key !== "scope" && key !== "mutation") return fail("invalid_input", `未知字段：${key}`);
  }
  const scope = raw.scope;
  if (typeof scope !== "string" || !scope.trim()) return fail("invalid_input", "缺少 scope。");
  const mutation = parseMutation(raw.mutation);
  if (!mutation.ok) return mutation;
  return { ok: true, value: { scope: scope.trim(), mutation: mutation.mutation } };
}
