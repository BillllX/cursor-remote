import type {
  AssistantOp,
  AssistantOpArgsMap,
  AssistantOpClientMessage,
  AssistantOpNoArgs,
  ClientMessage,
} from "./protocol.ts";

/** `buildAssistantOpMessage` / Web `op()` 的剩余参数（与 ClientMessage 分支一致）。 */
export type AssistantOpMessageRest<O extends AssistantOp> = O extends "memory_center_search"
  ? [args: AssistantOpArgsMap["memory_center_search"]]
  : O extends "memory_center_mutate"
    ? [args: AssistantOpArgsMap["memory_center_mutate"]]
    : O extends
          | "memory_center_restore"
          | "memory_center_suggestion_answer"
          | "memory_center_import_preview"
          | "memory_center_import_apply"
          | "memory_center_import_rollback"
      ? [args: AssistantOpArgsMap[O]]
      : O extends
            | "memory_center_get"
            | "memory_center_activity"
            | "memory_center_suggestions_get"
            | "memory_center_export"
        ? [args?: AssistantOpArgsMap[O]]
        : O extends AssistantOpNoArgs
          ? []
          : [args?: Record<string, unknown>];

export type AssistantOpMessageOf<O extends AssistantOp> = Extract<AssistantOpClientMessage, { op: O }>;

export type BuildAssistantOpMessage = {
  (
    operation: "memory_center_search",
    args: AssistantOpArgsMap["memory_center_search"],
  ): AssistantOpMessageOf<"memory_center_search">;
  (
    operation: "memory_center_mutate",
    args: AssistantOpArgsMap["memory_center_mutate"],
  ): AssistantOpMessageOf<"memory_center_mutate">;
  (
    operation: "memory_center_get",
    args?: AssistantOpArgsMap["memory_center_get"],
  ): AssistantOpMessageOf<"memory_center_get">;
  (
    operation: "memory_center_activity",
    args?: AssistantOpArgsMap["memory_center_activity"],
  ): AssistantOpMessageOf<"memory_center_activity">;
  (
    operation: "memory_center_restore",
    args: AssistantOpArgsMap["memory_center_restore"],
  ): AssistantOpMessageOf<"memory_center_restore">;
  (
    operation: "memory_center_suggestions_get",
    args?: AssistantOpArgsMap["memory_center_suggestions_get"],
  ): AssistantOpMessageOf<"memory_center_suggestions_get">;
  (
    operation: "memory_center_suggestion_answer",
    args: AssistantOpArgsMap["memory_center_suggestion_answer"],
  ): AssistantOpMessageOf<"memory_center_suggestion_answer">;
  (
    operation: "memory_center_export",
    args?: AssistantOpArgsMap["memory_center_export"],
  ): AssistantOpMessageOf<"memory_center_export">;
  (
    operation: "memory_center_import_preview",
    args: AssistantOpArgsMap["memory_center_import_preview"],
  ): AssistantOpMessageOf<"memory_center_import_preview">;
  (
    operation: "memory_center_import_apply",
    args: AssistantOpArgsMap["memory_center_import_apply"],
  ): AssistantOpMessageOf<"memory_center_import_apply">;
  (
    operation: "memory_center_import_rollback",
    args: AssistantOpArgsMap["memory_center_import_rollback"],
  ): AssistantOpMessageOf<"memory_center_import_rollback">;
  (operation: AssistantOpNoArgs): AssistantOpMessageOf<AssistantOpNoArgs>;
  (
    operation: Exclude<
      AssistantOp,
      | "memory_center_search"
      | "memory_center_mutate"
      | "memory_center_get"
      | "memory_center_activity"
      | "memory_center_restore"
      | "memory_center_suggestions_get"
      | "memory_center_suggestion_answer"
      | "memory_center_export"
      | "memory_center_import_preview"
      | "memory_center_import_apply"
      | "memory_center_import_rollback"
      | AssistantOpNoArgs
    >,
    args?: Record<string, unknown>,
  ): AssistantOpMessageOf<
    Exclude<
      AssistantOp,
      | "memory_center_search"
      | "memory_center_mutate"
      | "memory_center_get"
      | "memory_center_activity"
      | "memory_center_restore"
      | "memory_center_suggestions_get"
      | "memory_center_suggestion_answer"
      | "memory_center_export"
      | "memory_center_import_preview"
      | "memory_center_import_apply"
      | "memory_center_import_rollback"
      | AssistantOpNoArgs
    >
  >;
};

function newReqId() {
  return globalThis.crypto.randomUUID();
}

function buildAssistantOpMessageImpl(operation: AssistantOp, args?: Record<string, unknown>): AssistantOpClientMessage {
  const base = { type: "assistant_op" as const, op: operation, reqId: newReqId() };
  if (operation === "memory_center_search") {
    return { ...base, op: operation, args: args as AssistantOpArgsMap["memory_center_search"] };
  }
  if (operation === "memory_center_mutate") {
    return { ...base, op: operation, args: args as AssistantOpArgsMap["memory_center_mutate"] };
  }
  if (operation === "memory_center_get") {
    return args === undefined ? { ...base, op: operation } : { ...base, op: operation, args };
  }
  if (
    operation === "memory_center_activity" ||
    operation === "memory_center_suggestions_get" ||
    operation === "memory_center_export"
  ) {
    return args === undefined ? { ...base, op: operation } : { ...base, op: operation, args };
  }
  if (operation === "memory_center_import_preview") {
    return { ...base, op: operation, args: args as AssistantOpArgsMap["memory_center_import_preview"] };
  }
  if (operation === "memory_center_import_apply") {
    return { ...base, op: operation, args: args as AssistantOpArgsMap["memory_center_import_apply"] };
  }
  if (operation === "memory_center_import_rollback") {
    return { ...base, op: operation, args: args as AssistantOpArgsMap["memory_center_import_rollback"] };
  }
  if (operation === "memory_center_restore") {
    return { ...base, op: operation, args: args as AssistantOpArgsMap["memory_center_restore"] };
  }
  if (operation === "memory_center_suggestion_answer") {
    return { ...base, op: operation, args: args as AssistantOpArgsMap["memory_center_suggestion_answer"] };
  }
  if (operation === "memory_export" || operation === "push_test") {
    return { ...base, op: operation };
  }
  return args === undefined ? { ...base, op: operation } : { ...base, op: operation, args };
}

/** 构造类型安全的 assistant_op 客户端消息（Web / 脚本共用）。 */
export const buildAssistantOpMessage = buildAssistantOpMessageImpl as BuildAssistantOpMessage;

/** 泛型 send 包装：保持 op 与 args 关联。 */
export function sendAssistantOp(
  send: (message: ClientMessage) => void,
  ...params: Parameters<BuildAssistantOpMessage>
) {
  send(buildAssistantOpMessage(...params));
}
