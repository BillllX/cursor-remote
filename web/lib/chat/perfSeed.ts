// 长会话测量用的造数据：纯函数，输出和线上回合同一形状（含 Markdown、代码块、工具卡、图片）
import type { Turn } from "./types";

export const PERF_TURN_PREFIX = "perf-";
export const PERF_LIVE_ID = `${PERF_TURN_PREFIX}live`;

// 1x1 透明 PNG，用来验证旧回合里的图片在 content-visibility 跳过渲染后仍能正常解码
const PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const PARAGRAPH =
  "这是第 {n} 轮的回答：先看 `web/components/chat/Thread.tsx`，再对照 reducer 里对未变回合返回同一引用的约定。" +
  "长会话里每个增量都会让整条线程重渲染，所以要把单个回合拆成带 memo 的行组件。";

/** 第 index 个已结束回合（index 从 0 起） */
export function makePerfTurn(index: number): Turn {
  const n = index + 1;
  const withCode = index % 3 === 0;
  const withTool = index % 4 === 1;
  const assistant =
    PARAGRAPH.replace("{n}", String(n)) +
    "\n\n" +
    "- 要点一：回调必须是稳定引用\n- 要点二：旧回合对象不变就不该重渲染\n- 要点三：滚动条不能跳\n" +
    (withCode ? "\n```ts\nexport function demo(n: number) {\n  return n * 2;\n}\n```\n" : "") +
    (index % 5 === 0 ? "\n| 列 A | 列 B |\n| --- | --- |\n| 1 | 2 |\n" : "");
  return {
    id: `${PERF_TURN_PREFIX}${String(n).padStart(4, "0")}`,
    user: `第 ${n} 个问题：这一轮要改哪里？`,
    assistant,
    thinking: "",
    tools: withTool
      ? [
          {
            callId: `perf-call-${n}`,
            name: "read_file",
            status: "completed",
            args: { path: `web/components/file-${n}.tsx` },
            result: { content: "export {}" },
          },
        ]
      : [],
    running: false,
    durationMs: 1200,
    status: "finished",
    // 第 2 轮带一张图：smoke 滚回顶部后检查它仍然解码成功
    images: index === 1 ? [{ mimeType: "image/png", data: PIXEL_PNG }] : undefined,
  };
}

/** count 个已结束回合 + 末尾 1 个运行中回合（等着收 text-delta） */
export function makePerfTurns(count: number): Turn[] {
  const turns: Turn[] = [];
  for (let i = 0; i < count; i += 1) turns.push(makePerfTurn(i));
  turns.push({
    id: PERF_LIVE_ID,
    user: "最后一个问题：现在开始流式输出",
    assistant: "",
    thinking: "",
    tools: [],
    running: true,
  });
  return turns;
}

export const isPerfTurn = (turn: Turn): boolean => turn.id.startsWith(PERF_TURN_PREFIX);

/** 把 local 里合成的回合接回 merged 的末尾（先去掉 merged 里同类回合，保持原有相对顺序）；没有合成回合时原样返回 merged */
export function keepPerfTurns(local: Turn[], merged: Turn[]): Turn[] {
  const perf = local.filter(isPerfTurn);
  if (!perf.length) return merged;
  return [...merged.filter((turn) => !isPerfTurn(turn)), ...perf];
}

/**
 * 合成的运行中回合可能被网关随后推来的快照 / 状态当成“已结束”结算掉（服务端并没有这个回合）。
 * 灌增量前调一次，把它重新置为运行中；已经在跑或不存在时原样返回 turns（引用不变，不触发渲染）。
 */
export function armPerfLive(turns: Turn[]): Turn[] {
  const index = turns.findIndex((turn) => turn.id === PERF_LIVE_ID);
  if (index < 0 || turns[index].running) return turns;
  const next = turns.slice();
  next[index] = { ...turns[index], running: true, queued: false, error: undefined, status: undefined };
  return next;
}
