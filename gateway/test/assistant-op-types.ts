/**
 * assistant_op / assistant_result 类型级契约：带 @ts-expect-error 的行必须在 strict 下报错。
 * gateway `tsc` 包含本文件（见 gateway/tsconfig.json）。
 */
import { buildAssistantOpMessage } from "../../shared/assistantOp.ts";
import type { ClientMessage, ServerMessage } from "../../shared/protocol.ts";

const validSearch: ClientMessage = {
  type: "assistant_op",
  op: "memory_center_search",
  args: { query: "redis" },
};
const validGetBare: ClientMessage = { type: "assistant_op", op: "memory_center_get" };
const validGetScope: ClientMessage = { type: "assistant_op", op: "memory_center_get", args: { scope: "notes" } };
const validLegacy: ClientMessage = { type: "assistant_op", op: "todo_add", args: { text: "hi" } };
const validNoArgs: ClientMessage = { type: "assistant_op", op: "memory_export" };

const validHelperSearch: ClientMessage = buildAssistantOpMessage("memory_center_search", { query: "x" });
const validHelperLegacy: ClientMessage = buildAssistantOpMessage("todo_done", { id: "t1" });
const validHelperNoArgs: ClientMessage = buildAssistantOpMessage("push_test");

void validSearch;
void validGetBare;
void validGetScope;
void validLegacy;
void validNoArgs;
void validHelperSearch;
void validHelperLegacy;
void validHelperNoArgs;

// @ts-expect-error memory_center_search 缺 query
const badSearchNoQuery: ClientMessage = { type: "assistant_op", op: "memory_center_search", args: { scope: "x" } };

// @ts-expect-error memory_center_search 缺 args
const badSearchNoArgs: ClientMessage = { type: "assistant_op", op: "memory_center_search" };

// @ts-expect-error helper 缺 query
const badHelperSearch: ClientMessage = buildAssistantOpMessage("memory_center_search", { scope: "x" });

// @ts-expect-error helper 缺必填 search args
buildAssistantOpMessage("memory_center_search");

type McGetResult = Extract<ServerMessage, { type: "assistant_result"; op: "memory_center_get" }>;
type McSearchResult = Extract<ServerMessage, { type: "assistant_result"; op: "memory_center_search" }>;

const badGetData: McGetResult = {
  type: "assistant_result",
  op: "memory_center_get",
  ok: true,
  // @ts-expect-error get 的 data 不能用 search 形状
  data: { hits: [] },
};

const badSearchData: McSearchResult = {
  type: "assistant_result",
  op: "memory_center_search",
  ok: true,
  // @ts-expect-error search 的 data 不能用 get 形状
  data: { mode: "overview", overview: { personal: {} as never, scopes: [] } },
};

type McMutateOk = Extract<ServerMessage, { type: "assistant_result"; op: "memory_center_mutate"; ok: true }>;
type McMutateFail = Extract<ServerMessage, { type: "assistant_result"; op: "memory_center_mutate"; ok: false }>;

const mutateOk: McMutateOk = {
  type: "assistant_result",
  op: "memory_center_mutate",
  ok: true,
  data: {
    scope: "ws",
    action: "create",
    detail: {
      scope: {
        id: "ws",
        label: "ws",
        kind: "workspace_memory",
        layer: "L2",
        memoryCount: 0,
        hot: 0,
        cold: 0,
        done: 0,
        expired: 0,
        pinned: 0,
        missingRefs: 0,
        ruleFileCount: 0,
        tokenBudget: 0,
        injectionSelected: 0,
        injectionSkipped: 0,
        pendingCount: 0,
      },
      items: [],
      rules: [],
      diagnostics: null,
    },
  },
};

const mutateFail: McMutateFail = {
  type: "assistant_result",
  op: "memory_center_mutate",
  ok: false,
  error: "冲突",
  data: { code: "conflict" },
};

void badSearchNoQuery;
void badSearchNoArgs;
void badHelperSearch;
void badGetData;
void badSearchData;
void mutateOk;
void mutateFail;
