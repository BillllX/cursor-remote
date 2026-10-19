// 线程回合列表的纯逻辑：哪些回合要渲染、各行依赖前一有效回合的派生值、哪些旧回合可以让浏览器跳过渲染。
// 抽成纯函数是为了单测，也让 Thread 每次渲染只扫一遍（原先每行都要 O(n) 地回头找前一有效回合）。
import { incompleteTurn, turnSuperseded } from "./turns";
import type { Turn } from "./types";

/** 末尾这几个回合永远不启用 content-visibility：贴底滚动、流式输出、提问卡片都发生在这里 */
export const LIVE_TAIL_TURNS = 6;

export type TurnRowPlan = {
  turn: Turn;
  /** 和前一个有效回合的用户消息相同（重试产生的续写），不再重复画用户气泡 */
  hideUser: boolean;
  /** 是否整个列表（含被取代的回合）的最后一个：问答卡片只有它能作答 */
  isLast: boolean;
  /** 可以让浏览器跳过屏外渲染（content-visibility:auto）；已结算且不在末尾几轮 */
  deferrable: boolean;
};

/** 一次扫描得出每个可见回合的行信息；被后一轮取代的失败回合不出现在结果里 */
export function planTurnRows(turns: readonly Turn[], liveTail: number = LIVE_TAIL_TURNS): TurnRowPlan[] {
  const rows: TurnRowPlan[] = [];
  let prev: Turn | undefined;
  const settledUntil = turns.length - liveTail;
  for (let index = 0; index < turns.length; index += 1) {
    if (turnSuperseded(turns as Turn[], index)) continue;
    const turn = turns[index];
    const prevUser = prev?.user.trim();
    rows.push({
      turn,
      hideUser: Boolean(
        prevUser && prevUser === turn.user.trim() && prev && !incompleteTurn(prev) && !incompleteTurn(turn),
      ),
      isLast: index === turns.length - 1,
      deferrable: index < settledUntil && !turn.running && !turn.queued && !turn.pendingTool,
    });
    prev = turn;
  }
  return rows;
}

const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/** 估算文本占几行：中日韩字符按“宽字符”算，每行容纳的字符数更少 */
function lineCount(text: string, charsPerLine: number): number {
  if (!text) return 0;
  let lines = 0;
  for (const raw of text.split("\n")) {
    // 空行（段落间隔）渲染出来只是一段 margin，不是整行
    if (!raw) {
      lines += 0.5;
      continue;
    }
    const width = CJK.test(raw) ? charsPerLine * 0.55 : charsPerLine;
    lines += Math.max(1, Math.ceil(raw.length / width));
  }
  return lines;
}

/**
 * 估算一个回合渲染后的高度（像素），给 contain-intrinsic-size 当占位高度。
 * 只求量级接近、避免滚动条剧烈跳动；真实高度渲染过一次后浏览器会用 `auto` 记住。
 */
export function estimateTurnHeight(turn: Turn, hideUser: boolean): number {
  let height = 18; // 回合底部间距
  if (!hideUser) height += 24 + lineCount(turn.user, 60) * 24 + (turn.images?.length ? 120 : 0);
  height += 16 + lineCount(turn.assistant, 90) * 24;
  height += turn.tools.length * 36;
  if (turn.todos?.length) height += turn.todos.length * 26;
  if (turn.thinking) height += 32;
  return Math.min(4000, Math.max(80, Math.round(height)));
}
