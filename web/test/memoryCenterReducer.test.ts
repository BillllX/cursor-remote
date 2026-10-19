import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
  AssistantResultMessage,
  MemoryCenterOverview,
  MemoryCenterScopeDetail,
  MemoryCenterScopeSummary,
} from "@shared/protocol";
import {
  applyMemoryCenterResult,
  buildScopeTreeRows,
  detailForScope,
  filterItemsByState,
  findPending,
  initialMemoryCenterData,
  injectionRoundItems,
  overviewPendingTotal,
  pinnedOnlyItems,
  registerPending,
  resolveScopeLabel,
} from "../components/assistant/memoryCenterReducer";
import {
  MEMORY_CENTER_CSS,
  MEMORY_CENTER_FOCUS,
  SEARCHABLE_KIND_LABEL,
} from "../components/assistant/memoryCenterLabels";

function scope(id: string, parentId: string | null, pending = 0): MemoryCenterScopeSummary {
  return {
    id,
    label: id,
    kind: "workspace_memory",
    layer: "L2",
    parentId,
    memoryCount: 1,
    hot: 1,
    cold: 0,
    done: 0,
    expired: 0,
    pinned: 0,
    missingRefs: 0,
    ruleFileCount: 0,
    tokenBudget: 100,
    injectionSelected: 1,
    injectionSkipped: 0,
    pendingCount: pending,
  };
}

function detailPayload(scopeId: string) {
  return {
    mode: "detail" as const,
    detail: {
      scope: scope(scopeId, null),
      items: [],
      rules: [],
      diagnostics: null,
    },
  };
}

describe("memoryCenterReducer", () => {
  test("reqId 乱序：未注册的响应被忽略", () => {
    const data = registerPending(initialMemoryCenterData(), { reqId: "a", kind: "overview" });
    const msg: AssistantResultMessage = {
      type: "assistant_result",
      op: "memory_center_get",
      reqId: "stray",
      ok: true,
      data: {
        mode: "overview",
        overview: {
          personal: {
            validEntries: 0,
            invalidEntries: 0,
            coreFieldLines: 0,
            workPreferenceLines: 0,
            paused: false,
            coreBudget: 1,
            coreTokens: 0,
            workPreferenceBudget: 1,
          },
          scopes: [],
        },
      },
    };
    assert.equal(applyMemoryCenterResult(data, msg), null);
  });

  test("scope 乱序 alpha→beta→beta 响应→alpha 响应，最终 beta", () => {
    let data = registerPending(
      initialMemoryCenterData(),
      { reqId: "a1", kind: "scope", scopeId: "alpha" },
      { replaceSameKind: true },
    );
    data = registerPending(data, { reqId: "b1", kind: "scope", scopeId: "beta" }, { replaceSameKind: true });
    assert.equal(data.pending.length, 1);
    assert.equal(data.activeScopeReqId, "b1");
    assert.equal(data.activeScopeId, "beta");

    data =
      applyMemoryCenterResult(data, {
        type: "assistant_result",
        op: "memory_center_get",
        reqId: "b1",
        ok: true,
        data: detailPayload("beta"),
      }) ?? data;
    assert.equal(data.detail?.scope.id, "beta");

    const stale =
      applyMemoryCenterResult(data, {
        type: "assistant_result",
        op: "memory_center_get",
        reqId: "a1",
        ok: true,
        data: detailPayload("alpha"),
      }) ?? null;
    assert.equal(stale, null);
    assert.equal(data.detail?.scope.id, "beta");
  });

  test("新 scope 请求淘汰全部旧 scope pending，第三 scope 不被阻塞", () => {
    let data = registerPending(
      initialMemoryCenterData(),
      { reqId: "a1", kind: "scope", scopeId: "alpha" },
      { replaceSameKind: true },
    );
    data = registerPending(data, { reqId: "b1", kind: "scope", scopeId: "beta" }, { replaceSameKind: true });
    data = registerPending(data, { reqId: "g1", kind: "scope", scopeId: "gamma" }, { replaceSameKind: true });
    assert.deepEqual(
      data.pending.map((row) => row.reqId),
      ["g1"],
    );
    assert.equal(data.activeScopeId, "gamma");
    assert.equal(data.detail, null);
  });

  test("beta 错误后 alpha 成功响应不得清掉 scopeError 或写 detail", () => {
    let data = registerPending(
      initialMemoryCenterData(),
      { reqId: "b1", kind: "scope", scopeId: "beta" },
      { replaceSameKind: true },
    );
    data =
      applyMemoryCenterResult(data, {
        type: "assistant_result",
        op: "memory_center_get",
        reqId: "b1",
        ok: false,
        error: "beta 挂了",
      }) ?? data;
    assert.equal(data.scopeError, "beta 挂了");
    assert.equal(data.overviewError, "");
    assert.equal(data.detail, null);

    const ignored =
      applyMemoryCenterResult(data, {
        type: "assistant_result",
        op: "memory_center_get",
        reqId: "a1",
        ok: true,
        data: detailPayload("alpha"),
      }) ?? null;
    assert.equal(ignored, null);
    assert.equal(data.scopeError, "beta 挂了");
    assert.equal(data.detail, null);
  });

  test("非 activeScopeReqId 的 scope 错误不得改写 scopeError", () => {
    let data = registerPending(
      initialMemoryCenterData(),
      { reqId: "b1", kind: "scope", scopeId: "beta" },
      { replaceSameKind: true },
    );
    data = registerPending(data, { reqId: "g1", kind: "scope", scopeId: "gamma" }, { replaceSameKind: true });
    data =
      applyMemoryCenterResult(data, {
        type: "assistant_result",
        op: "memory_center_get",
        reqId: "b1",
        ok: false,
        error: "旧 beta 错误",
      }) ?? data;
    assert.equal(data.scopeError, "");
  });

  test("并发 overview+personal：personal 成功、overview 失败，scope 仍可显示", () => {
    let data = registerPending(initialMemoryCenterData(), { reqId: "o1", kind: "overview" }, { replaceSameKind: true });
    data = registerPending(data, { reqId: "p1", kind: "scope", scopeId: "personal" }, { replaceSameKind: true });
    data =
      applyMemoryCenterResult(data, {
        type: "assistant_result",
        op: "memory_center_get",
        reqId: "p1",
        ok: true,
        data: detailPayload("personal"),
      }) ?? data;
    data =
      applyMemoryCenterResult(data, {
        type: "assistant_result",
        op: "memory_center_get",
        reqId: "o1",
        ok: false,
        error: "总览挂了",
      }) ?? data;
    assert.equal(data.detail?.scope.id, "personal");
    assert.equal(data.overviewError, "总览挂了");
    assert.equal(data.scopeError, "");
    assert.equal(detailForScope(data.detail, "personal")?.scope.id, "personal");
  });

  test("scope 失败不污染 overviewError", () => {
    let data = registerPending(initialMemoryCenterData(), { reqId: "o1", kind: "overview" }, { replaceSameKind: true });
    data =
      applyMemoryCenterResult(data, {
        type: "assistant_result",
        op: "memory_center_get",
        reqId: "o1",
        ok: true,
        data: {
          mode: "overview",
          overview: {
            personal: {
              validEntries: 1,
              invalidEntries: 0,
              coreFieldLines: 0,
              workPreferenceLines: 0,
              paused: false,
              coreBudget: 1,
              coreTokens: 0,
              workPreferenceBudget: 1,
            },
            scopes: [],
          },
        },
      }) ?? data;
    data = registerPending(data, { reqId: "b1", kind: "scope", scopeId: "beta" }, { replaceSameKind: true });
    data =
      applyMemoryCenterResult(data, {
        type: "assistant_result",
        op: "memory_center_get",
        reqId: "b1",
        ok: false,
        error: "scope fail",
      }) ?? data;
    assert.equal(data.overviewError, "");
    assert.equal(data.scopeError, "scope fail");
    assert.ok(data.overview);
  });

  test("detailForScope 不匹配时不展示旧 detail", () => {
    const detail = detailPayload("alpha").detail;
    assert.equal(detailForScope(detail, "beta"), null);
    assert.equal(detailForScope(detail, "alpha")?.scope.id, "alpha");
  });

  test("overview 响应写入并清除 pending", () => {
    const data = registerPending(
      initialMemoryCenterData(),
      { reqId: "r1", kind: "overview" },
      { replaceSameKind: true },
    );
    assert.ok(findPending(data, "r1"));
    const overview: MemoryCenterOverview = {
      personal: {
        validEntries: 2,
        invalidEntries: 1,
        coreFieldLines: 3,
        workPreferenceLines: 4,
        paused: false,
        coreBudget: 100,
        coreTokens: 10,
        workPreferenceBudget: 50,
      },
      scopes: [scope("ws", null, 2)],
    };
    const applied = applyMemoryCenterResult(data, {
      type: "assistant_result",
      op: "memory_center_get",
      reqId: "r1",
      ok: true,
      data: { mode: "overview", overview, payloadTruncated: true },
    });
    assert.ok(applied);
    assert.equal(applied!.overview?.personal.validEntries, 2);
    assert.equal(applied!.overviewPayloadTruncated, true);
    assert.equal(findPending(applied!, "r1"), undefined);
    assert.equal(applied!.loadingOverview, false);
  });

  test("scope 响应 payload scopeId 与 pending 不一致时不写入", () => {
    const data = registerPending(
      initialMemoryCenterData(),
      { reqId: "s1", kind: "scope", scopeId: "alpha" },
      { replaceSameKind: true },
    );
    const applied = applyMemoryCenterResult(data, {
      type: "assistant_result",
      op: "memory_center_get",
      reqId: "s1",
      ok: true,
      data: detailPayload("beta"),
    });
    assert.ok(applied);
    assert.equal(applied!.detail, null);
  });

  test("search 错误写入 searchError", () => {
    const data = registerPending(
      initialMemoryCenterData(),
      { reqId: "q1", kind: "search", query: "x" },
      { replaceSameKind: true },
    );
    const applied = applyMemoryCenterResult(data, {
      type: "assistant_result",
      op: "memory_center_search",
      reqId: "q1",
      ok: false,
      error: "bad",
    });
    assert.equal(applied!.searchError, "bad");
  });

  test("buildScopeTreeRows 按 parent 缩进层级", () => {
    const rows = buildScopeTreeRows([scope("root", null), scope("root/child", "root"), scope("personal", null)]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, "root");
    assert.equal(rows[0].depth, 0);
    assert.equal(rows[1].depth, 1);
  });

  test("pinnedOnlyItems 仅 pinned", () => {
    const items = [
      {
        id: "a",
        kind: "workspace_memory" as const,
        layer: "L2" as const,
        scopeId: "w",
        text: "A",
        refs: [],
        missingRefs: [],
        effectiveState: "hot" as const,
        pinned: false,
      },
      {
        id: "b",
        kind: "workspace_memory" as const,
        layer: "L2" as const,
        scopeId: "w",
        text: "B",
        refs: [],
        missingRefs: [],
        effectiveState: "hot" as const,
        pinned: true,
      },
    ];
    assert.deepEqual(
      pinnedOnlyItems(items).map((row) => row.id),
      ["b"],
    );
  });

  test("injectionRoundItems 来自 diagnostics.selectedIds", () => {
    const items = [
      {
        id: "a",
        kind: "workspace_memory" as const,
        layer: "L2" as const,
        scopeId: "w",
        text: "A",
        refs: [],
        missingRefs: [],
        effectiveState: "hot" as const,
        pinned: true,
      },
      {
        id: "b",
        kind: "workspace_memory" as const,
        layer: "L2" as const,
        scopeId: "w",
        text: "B",
        refs: [],
        missingRefs: [],
        effectiveState: "hot" as const,
        pinned: false,
      },
    ];
    const picked = injectionRoundItems(items, {
      total: 2,
      selected: 1,
      skippedBudget: 0,
      hotSelected: 1,
      coldRecalled: 0,
      terminalSkipped: 0,
      pinnedSelected: 0,
      relevantSelected: 1,
      strategy: "test",
      selectedIds: [{ id: "b", reason: "relevant" }],
    });
    assert.deepEqual(
      picked.map((row) => row.id),
      ["b"],
    );
  });

  test("filterItemsByState", () => {
    const items = [
      {
        id: "1",
        kind: "workspace_memory" as const,
        layer: "L2" as const,
        scopeId: "w",
        text: "x",
        refs: [],
        missingRefs: ["f"],
        effectiveState: "hot" as const,
        state: "hot" as const,
        revision: "r1",
      },
      {
        id: "2",
        kind: "workspace_memory" as const,
        layer: "L2" as const,
        scopeId: "w",
        text: "y",
        refs: [],
        missingRefs: [],
        effectiveState: "cold" as const,
        state: "cold" as const,
      },
    ];
    assert.equal(filterItemsByState(items, "cold").length, 1);
    assert.equal(filterItemsByState(items, "待核实").length, 1);
  });

  test("overviewPendingTotal", () => {
    assert.equal(overviewPendingTotal([scope("a", null, 1), scope("b", null, 2)]), 3);
  });

  test("resolveScopeLabel 优先 overview label", () => {
    assert.equal(resolveScopeLabel("notes", [scope("notes", null)]), "notes");
    assert.equal(resolveScopeLabel("missing", []), "missing");
  });

  test("replaceSameKind 注册时丢弃同 kind 旧 reqId", () => {
    let data = registerPending(
      initialMemoryCenterData(),
      { reqId: "old", kind: "overview" },
      { replaceSameKind: true },
    );
    data = registerPending(data, { reqId: "new", kind: "overview" }, { replaceSameKind: true });
    assert.equal(data.pending.length, 1);
    assert.equal(data.pending[0].reqId, "new");
    const stale = applyMemoryCenterResult(data, {
      type: "assistant_result",
      op: "memory_center_get",
      reqId: "old",
      ok: true,
      data: {
        mode: "overview",
        overview: {
          personal: {
            validEntries: 9,
            invalidEntries: 0,
            coreFieldLines: 0,
            workPreferenceLines: 0,
            paused: false,
            coreBudget: 1,
            coreTokens: 0,
            workPreferenceBudget: 1,
          },
          scopes: [],
        },
      },
    });
    assert.equal(stale, null);
  });
});

describe("memory center mutate reducer", () => {
  test("mutation 成功原子替换 detail", () => {
    const scopeSummary = scope("ws", null);
    let data = registerPending(initialMemoryCenterData(), {
      reqId: "m1",
      kind: "mutation",
      scopeId: "ws",
    });
    data.activeScopeId = "ws";
    data.activeMutationReqId = "m1";
    data.mutationScopeId = "ws";
    const detail: MemoryCenterScopeDetail = {
      scope: scopeSummary,
      items: [
        {
          id: "i1",
          kind: "workspace_memory",
          layer: "L2",
          scopeId: "ws",
          text: "new",
          refs: [],
          missingRefs: [],
          effectiveState: "hot",
          revision: "r2",
        },
      ],
      rules: [],
      diagnostics: null,
    };
    const applied = applyMemoryCenterResult(data, {
      type: "assistant_result",
      op: "memory_center_mutate",
      reqId: "m1",
      ok: true,
      data: { scope: "ws", action: "update", detail },
    });
    assert.ok(applied);
    assert.equal(applied!.detail?.items[0].text, "new");
    assert.equal(applied!.mutating, false);
  });

  test("mutation 畸形 data 不 throw", () => {
    let data = registerPending(initialMemoryCenterData(), {
      reqId: "mbad",
      kind: "mutation",
      scopeId: "ws",
    });
    data.activeScopeId = "ws";
    data.activeMutationReqId = "mbad";
    data.mutationScopeId = "ws";
    const applied = applyMemoryCenterResult(data, {
      type: "assistant_result",
      op: "memory_center_mutate",
      reqId: "mbad",
      ok: true,
      data: { scope: "ws", action: "update", detail: { scope: { id: 9 }, items: [], rules: [], diagnostics: null } },
    });
    assert.ok(applied);
    assert.match(applied!.mutationError, /无法解析/);
  });

  test("mutation conflict 刷新 detail", () => {
    let data = registerPending(initialMemoryCenterData(), {
      reqId: "m2",
      kind: "mutation",
      scopeId: "ws",
    });
    data.activeScopeId = "ws";
    data.activeMutationReqId = "m2";
    data.mutationScopeId = "ws";
    const detail: MemoryCenterScopeDetail = {
      scope: scope("ws", null),
      items: [
        {
          id: "i1",
          kind: "workspace_memory",
          layer: "L2",
          scopeId: "ws",
          text: "server",
          refs: [],
          missingRefs: [],
          effectiveState: "hot",
          revision: "r9",
        },
      ],
      rules: [],
      diagnostics: null,
    };
    const applied = applyMemoryCenterResult(data, {
      type: "assistant_result",
      op: "memory_center_mutate",
      reqId: "m2",
      ok: false,
      error: "内容已变化",
      data: { code: "conflict" as const, detail },
    });
    assert.ok(applied);
    assert.equal(applied!.mutationErrorCode, "conflict");
    assert.equal(applied!.detail?.items[0].revision, "r9");
  });
});

describe("memory center CSS contract", () => {
  test("关键 class 名稳定", () => {
    assert.equal(MEMORY_CENTER_CSS.root, "mc-root");
    assert.equal(MEMORY_CENTER_CSS.layoutThree, "mc-layout-three");
    assert.equal(MEMORY_CENTER_CSS.rowSelected, "mc-row-selected");
  });

  test("搜索 UI 不含 rule/document kind", () => {
    assert.deepEqual(Object.keys(SEARCHABLE_KIND_LABEL).sort(), ["personal", "work_preference", "workspace_memory"]);
  });

  test("drill-down 焦点契约常量", () => {
    assert.equal(MEMORY_CENTER_FOCUS.navTitle, "mc-focus-nav-title");
    assert.equal(MEMORY_CENTER_FOCUS.navCurrent, "mc-focus-nav-current");
    assert.equal(MEMORY_CENTER_FOCUS.middleTitle, "mc-focus-middle-title");
    assert.equal(MEMORY_CENTER_FOCUS.middleFromDetail, "mc-focus-middle-from-detail");
    assert.equal(MEMORY_CENTER_FOCUS.detailBack, "mc-focus-detail-back");
  });
});
