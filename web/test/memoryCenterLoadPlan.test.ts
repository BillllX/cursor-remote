import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { memoryCenterLoadPlan } from "../components/assistant/useMemoryCenter";

describe("记忆中心加载契约", () => {
  test("打开 personal 或 workspace scope 且 overview 缺失时并行加载两者", () => {
    assert.deepEqual(
      memoryCenterLoadPlan({
        active: true,
        searchActive: false,
        navId: "personal",
        hasOverview: false,
        loadingOverview: false,
        loadingScope: false,
      }),
      [undefined, "personal"],
    );
    assert.deepEqual(
      memoryCenterLoadPlan({
        active: true,
        searchActive: false,
        navId: "projects/app",
        hasOverview: false,
        loadingOverview: false,
        loadingScope: false,
      }),
      [undefined, "projects/app"],
    );
  });

  test("pending 或已有数据不会重复请求；搜索中仍补 overview 但不抢 scope", () => {
    assert.deepEqual(
      memoryCenterLoadPlan({
        active: true,
        searchActive: false,
        navId: "personal",
        hasOverview: false,
        loadingOverview: true,
        detailScopeId: "personal",
        loadingScope: false,
      }),
      [],
    );
    assert.deepEqual(
      memoryCenterLoadPlan({
        active: true,
        searchActive: true,
        navId: "projects/app",
        hasOverview: false,
        loadingOverview: false,
        loadingScope: false,
      }),
      [undefined],
    );
    assert.deepEqual(
      memoryCenterLoadPlan({
        active: false,
        searchActive: false,
        navId: "personal",
        hasOverview: false,
        loadingOverview: false,
        loadingScope: false,
      }),
      [],
    );
  });
});
