import { enqueueProjectRun } from "./runs.ts";
import { projectPage } from "./page.ts";
import { randomUUID } from "node:crypto";
import { ProjectError, type ProjectRequest } from "../../../shared/projectTypes.ts";
import type { ProjectStoreCore } from "./store/core.ts";
export type ProjectChat = { project: string; id: string; title: string; actor: string; created: number; seq: number };
export type ProjectMessage = {
  seq: number;
  kind: string;
  actor: string | null;
  run: string | null;
  text: string;
  status: string;
  created: number;
};
export function appendProjectMessage(
  s: ProjectStoreCore,
  id: string,
  chat: string,
  kind: string,
  actor: string,
  text: string,
  run: string | null = null,
) {
  const c = s.one<ProjectChat>("SELECT * FROM chats WHERE project=? AND id=?", id, chat);
  if (!c) throw new ProjectError("NOT_ACCESSIBLE");
  const seq = c.seq + 1;
  s.exec(
    "INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?)",
    id,
    chat,
    seq,
    kind,
    actor,
    run,
    text,
    "completed",
    s.clock(),
  );
  s.exec("UPDATE chats SET seq=? WHERE project=? AND id=?", seq, id, chat);
  s.event(id, "message_added", { chatId: chat, messageSeq: seq });
  return seq;
}
export function projectChats(s: ProjectStoreCore, actor: string, r: ProjectRequest): unknown {
  const id = r.workspaceId!,
    a = r.payload;
  const read = r.action === "project_chat_read" || r.action === "project_read_set" || r.action === "project_pin_set";
  s.access(actor, id, read ? "viewer" : "editor", !read || r.action !== "project_chat_read");
  if (r.action === "project_chat_create") {
    const chatId = randomUUID();
    s.exec(
      "INSERT INTO chats(project,id,title,actor,created) VALUES(?,?,?,?,?)",
      id,
      chatId,
      String(a.title).trim(),
      actor,
      s.clock(),
    );
    s.event(id, "chat_created", { chatId });
    return { chatId, title: a.title };
  }
  const c = s.one<ProjectChat>("SELECT * FROM chats WHERE project=? AND id=?", id, String(a.chatId));
  if (!c) throw new ProjectError("NOT_ACCESSIBLE");
  if (r.action === "project_chat_read")
    return {
      items: projectPage(
        s.all<ProjectMessage>(
          "SELECT seq,kind,actor,run,text,status,created FROM messages WHERE project=? AND chat=? AND seq>? ORDER BY seq LIMIT ?",
          id,
          c.id,
          Number(a.afterMessageSeq || 0),
          Math.min(Number(a.limit || 50), 100),
        ),
      ),
      lastMessageSeq: c.seq,
    };
  if (r.action === "project_message_send") {
    if (!String(a.text).trim()) throw new ProjectError("BAD_REQUEST");
    const runId = a.runAgent ? enqueueProjectRun(s, actor, id, c.id, String(a.modelId || "")) : undefined;
    const messageSeq = appendProjectMessage(s, id, c.id, "user", actor, String(a.text));
    return { chatId: c.id, messageSeq, ...(runId ? { runId } : {}) };
  }
  s.exec("INSERT OR IGNORE INTO member_views VALUES(?,?,?,0,0)", id, actor, c.id);
  if (r.action === "project_read_set") {
    if (Number(a.lastReadMessageSeq) > c.seq) throw new ProjectError("BAD_REQUEST");
    s.exec(
      "UPDATE member_views SET read_seq=max(read_seq,?) WHERE project=? AND tenant=? AND chat=?",
      Number(a.lastReadMessageSeq),
      id,
      actor,
      c.id,
    );
  } else
    s.exec(
      "UPDATE member_views SET pinned=? WHERE project=? AND tenant=? AND chat=?",
      a.pinned ? 1 : 0,
      id,
      actor,
      c.id,
    );
  return { updated: true };
}
