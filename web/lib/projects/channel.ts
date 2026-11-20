import type { ProjectResult, ProjectEvent, ProjectNotice } from "@shared/projectTypes";
export type ProjectFrame = ProjectResult | ProjectEvent | ProjectNotice;
/** 每帧同步派发，不能用单个 React latest-message 状态覆盖并发 RPC 回包。 */
export class ProjectChannel {
  private listeners = new Set<(frame: ProjectFrame) => void>();
  publish(frame: ProjectFrame) {
    for (const listener of this.listeners) listener(frame);
  }
  subscribe(listener: (frame: ProjectFrame) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  clear() {
    this.listeners.clear();
  }
}
