import {
  WORKSPACE_SHARE_ASK_TIMEOUT_MS,
  type WorkspaceShareRequest,
  type WorkspaceShareResult,
} from "@shared/workspaceShare";

export class WorkspaceShareClient {
  private readonly pending = new Map<string, { settle: (frame: WorkspaceShareResult) => void; cancel: () => void }>();
  request<T>(
    send: (message: WorkspaceShareRequest) => void,
    action: Omit<WorkspaceShareRequest, "type" | "requestId">,
  ): Promise<T> {
    const requestId = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        this.pending.delete(requestId);
      };
      const cancel = () => {
        finish();
        reject(new Error("共享连接已断开"));
      };
      const timer = setTimeout(
        () => {
          finish();
          reject(new Error("共享请求超时，请重试"));
        },
        action.action === "ask" ? WORKSPACE_SHARE_ASK_TIMEOUT_MS + 10_000 : 12_000,
      );
      this.pending.set(requestId, {
        cancel,
        settle: (frame) => {
          finish();
          if (frame.ok) resolve(frame.data as T);
          else reject(Object.assign(new Error(frame.error || "共享操作未完成"), { code: frame.code }));
        },
      });
      send({ type: "workspace_share", requestId, ...action });
    });
  }
  resolve(frame: WorkspaceShareResult) {
    this.pending.get(frame.requestId)?.settle(frame);
  }
  clear() {
    for (const entry of this.pending.values()) entry.cancel();
  }
}
