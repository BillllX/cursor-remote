import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { validateMemoryCenterMutateArgs } from "../src/assistant/memoryCenterMutateValidate.ts";
import { parseMemoryFileLines, serializeMemoryFileLines } from "../src/assistant/memoryFileEdit.ts";

describe("memoryCenterMutateValidate", () => {
  test("拒绝未知 args 字段", () => {
    const r = validateMemoryCenterMutateArgs({
      scope: "ws",
      mutation: { action: "create", section: "约定", text: "x" },
      extra: true,
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, "invalid_input");
  });

  test("正文超限按码点拒绝", () => {
    const r = validateMemoryCenterMutateArgs({
      scope: "ws",
      mutation: { action: "create", section: "约定", text: "字".repeat(4001) },
    });
    assert.equal(r.ok, false);
  });

  test("expires 日历日严格校验", () => {
    const ok = validateMemoryCenterMutateArgs({
      scope: "ws",
      mutation: { action: "create", section: "约定", text: "x", expires: "2028-02-29" },
    });
    assert.equal(ok.ok, true);
    for (const bad of ["2026-99-99", "2026-02-29", "2026-04-31", "2026-13-01"]) {
      const r = validateMemoryCenterMutateArgs({
        scope: "ws",
        mutation: { action: "create", section: "约定", text: "x", expires: bad },
      });
      assert.equal(r.ok, false, bad);
    }
    const patchBad = validateMemoryCenterMutateArgs({
      scope: "ws",
      mutation: {
        action: "update",
        id: "wm_x",
        revision: "r",
        patch: { expires: "2026-02-29" },
      },
    });
    assert.equal(patchBad.ok, false);
    const patchOk = validateMemoryCenterMutateArgs({
      scope: "ws",
      mutation: {
        action: "update",
        id: "wm_x",
        revision: "r",
        patch: { expires: "2028-02-29" },
      },
    });
    assert.equal(patchOk.ok, true);
  });

  test("update patch 未知键拒绝", () => {
    const r = validateMemoryCenterMutateArgs({
      scope: "ws",
      mutation: {
        action: "update",
        id: "wm_x",
        revision: "abc",
        patch: { text: "ok", hacker: true },
      },
    });
    assert.equal(r.ok, false);
  });
});

describe("memoryFileEdit fidelity", () => {
  test("保留 CRLF 与 final newline", () => {
    const raw = "## 约定\r\n- a\r\n\r\n## 坑\r\n- b\r\n";
    const view = parseMemoryFileLines(raw);
    assert.equal(view.eol, "\r\n");
    assert.equal(view.hadTrailingNewline, true);
    assert.equal(serializeMemoryFileLines(view), raw);
  });
});
