import { createHash } from "node:crypto";

function stable(prefix: string, source: string) {
  return `${prefix}_${createHash("sha256").update(source).digest("hex").slice(0, 32)}`;
}

/** 所有执行身份只从已经提交的事实派生，崩溃重放不会再造一套身份。 */
export const runIdForTrigger = (eventKey: string) => stable("crun", eventKey);
export const taskIdForTrigger = (eventKey: string, actorId: string) => stable("ctask", `${eventKey}\0${actorId}`);
export const coordinatorChatIdForRun = (runId: string) => stable("chat", `${runId}\0coordinator`);
export const delegationIdForTask = (taskId: string, attempt: number) =>
  stable("d", `${taskId}\0${attempt}\0delegation`);
export const childChatIdForTask = (taskId: string, attempt: number) => stable("chat", `${taskId}\0${attempt}\0child`);
export const eventIdForKey = (eventKey: string) => stable("evt", eventKey);
