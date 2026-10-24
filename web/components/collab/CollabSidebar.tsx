import { useMemo, useState } from "react";
import type { CollabRunState } from "@shared/protocol";
import { STATUS_LEGEND, statusAriaLabel } from "../../lib/productNavigation";
import type { CollabRoom } from "./collabState";
import { indicatorsForRoom } from "./collabView";
import styles from "./collab.module.css";

export function CollabSidebar({
  rooms,
  selectedConvId,
  runsForRoom,
  onSelect,
  onCreate,
}: {
  rooms: CollabRoom[];
  selectedConvId?: string;
  runsForRoom: (convId: string) => CollabRunState[];
  onSelect: (convId: string) => void;
  onCreate: () => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return rooms;
    return rooms.filter((room) => {
      const actors = room.actors.map((actor) => actor.displayName).join(" ");
      return `${room.title} ${actors}`.toLocaleLowerCase().includes(needle);
    });
  }, [query, rooms]);

  return (
    <aside className={styles.sidebar} aria-label="协作群列表">
      <div className={styles.sidebarTitle}>
        <strong>协作</strong>
        <button type="button" onClick={onCreate} aria-label="创建项目协作群">
          ＋ 新建
        </button>
      </div>
      <label className={styles.search}>
        <span className="sr-only">搜索群、Agent、任务</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索群、Agent、任务"
          type="search"
        />
      </label>
      <div className={styles.roomList}>
        {filtered
          .filter((room) => !room.archived)
          .map((room, index) => {
            const indicators = indicatorsForRoom(runsForRoom(room.convId));
            const selected = room.convId === selectedConvId;
            const preview =
              indicators.attention > 0
                ? `${indicators.attention} 项需要你处理`
                : indicators.running > 0
                  ? `${indicators.running} 项运行中`
                  : indicators.failed > 0
                    ? `${indicators.failed} 项失败`
                    : room.last?.kind === "collab" && room.last.body && "summary" in room.last.body
                      ? room.last.body.summary
                      : room.last?.kind === "text" && room.last.body && "text" in room.last.body
                        ? room.last.body.text
                        : index === 0
                          ? "描述目标，让 Agent 一起完成"
                          : "还没有消息";
            return (
              <button
                type="button"
                className={`${styles.roomRow}${selected ? ` ${styles.selected}` : ""}`}
                aria-current={selected ? "page" : undefined}
                key={room.convId}
                onClick={() => onSelect(room.convId)}
              >
                <span className={styles.roomAvatar} aria-hidden="true">
                  {room.title.slice(0, 1)}
                </span>
                <span className={styles.roomCopy}>
                  <span className={styles.roomName}>{room.title}</span>
                  <span className={styles.roomPreview}>{preview}</span>
                </span>
                <span className={styles.roomMarks}>
                  {indicators.attention ? (
                    <span title={statusAriaLabel("attention", indicators.attention)}>
                      {STATUS_LEGEND.attention.symbol}
                      <span className="sr-only">{statusAriaLabel("attention", indicators.attention)}</span>
                    </span>
                  ) : indicators.running ? (
                    <span title={statusAriaLabel("running", indicators.running)}>
                      {STATUS_LEGEND.running.symbol}
                      <span className="sr-only">{statusAriaLabel("running", indicators.running)}</span>
                    </span>
                  ) : null}
                  {room.unread > 0 ? (
                    <span className={styles.badge} aria-label={statusAriaLabel("unread", room.unread)}>
                      {room.unread > 99 ? "99+" : room.unread}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        {filtered.some((room) => room.archived) ? <div className={styles.archiveLabel}>已归档</div> : null}
        {filtered
          .filter((room) => room.archived)
          .map((room) => (
            <button
              type="button"
              className={`${styles.roomRow}${room.convId === selectedConvId ? ` ${styles.selected}` : ""}`}
              key={room.convId}
              onClick={() => onSelect(room.convId)}
            >
              <span className={styles.roomAvatar}>{room.title.slice(0, 1)}</span>
              <span className={styles.roomCopy}>
                <span className={styles.roomName}>{room.title}</span>
                <span className={styles.roomPreview}>已归档</span>
              </span>
            </button>
          ))}
        {!filtered.length ? (
          <div className={styles.listEmpty}>
            <strong>{rooms.length ? "没有匹配的协作群" : "正在创建小驳协作群"}</strong>
            <p>{rooms.length ? "换个关键词试试。" : "默认群会包含小驳和可用的工作区 Agent。"}</p>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
