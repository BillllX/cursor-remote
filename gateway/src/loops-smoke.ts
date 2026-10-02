import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Loop 调度冒烟：审批中顺延、没拿到批准算一拍、沙箱只看部署配置。
 * 状态目录放在 gateway 目录下的临时子目录，跑完删除。
 */

const gatewayDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(resolve(gatewayDir, ".loops-smoke-"));
process.env.CURSOR_REMOTE_STATE_DIR = dir;
process.env.CURSOR_REMOTE_TENANTS_FILE = resolve(dir, "tenants.json");

let passed = 0;
let failed = 0;
function check(ok: boolean, label: string) {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

async function waitFor(ok: () => boolean, ms = 3000) {
  const until = Date.now() + ms;
  while (!ok() && Date.now() < until) await sleep(20);
  return ok();
}

type StoredRow = { chatId: string; nextAt: number; tick: number; lastSummary?: string; status: string };

try {
  writeFileSync(
    resolve(dir, "tenants.json"),
    JSON.stringify({
      tenants: [
        { id: "admin", name: "管理员", token: "t-admin", admin: true },
        { id: "billxu", name: "Bill", token: "t-bill" },
        { id: "alice", name: "BillXu", token: "t-alice" },
        { id: "carol", name: "Carol", token: "t-carol", sandbox: false },
        { id: "dave", name: "Dave", token: "t-dave" },
      ],
    }),
  );
  const start = Date.now();
  writeFileSync(
    resolve(dir, "loops.json"),
    JSON.stringify({
      loops: [
        { tenantId: "t", chatId: "busy", status: "armed", goal: "g", intervalSec: 60, tick: 0, nextAt: start },
        { tenantId: "t", chatId: "approve", status: "armed", goal: "g", intervalSec: 60, tick: 0, nextAt: start },
        { tenantId: "t", chatId: "cancel", status: "armed", goal: "g", intervalSec: 60, tick: 0, nextAt: start },
      ],
    }),
  );

  const { bindLoops } = await import("./loops.ts");
  const { sandboxEnabledForTenant, loadTenants, getTenant } = await import("./tenants.ts");

  const ticks: Array<{ chatId: string; status: string; summary: string; tick: number }> = [];
  const dispatched: string[] = [];

  bindLoops({
    busy: (_tenant, chatId) =>
      chatId === "busy" ? { reason: "上一拍的写入还在等你批准，本拍顺延。", retryMs: 60_000 } : false,
    dispatch: async (job) => {
      dispatched.push(job.chatId);
      if (job.chatId === "cancel") return { text: "", error: "deferred" };
      return { text: "改到一半", error: "approval" };
    },
    publish: (_tenant, message) => {
      if (message.type === "loop_tick") ticks.push(message);
    },
  });

  const readRows = () =>
    (JSON.parse(readFileSync(resolve(dir, "loops.json"), "utf8")) as { loops: StoredRow[] }).loops;
  const row = (chatId: string) => readRows().find((item) => item.chatId === chatId);

  const settled = await waitFor(
    () =>
      ["busy", "approve", "cancel"].every((chatId) => ticks.some((item) => item.chatId === chatId)) &&
      row("approve")?.tick === 1,
  );
  check(settled, "Loop：三个 Loop 都在时限内跑完第一拍");

  const busyRow = row("busy");
  check(ticks.find((item) => item.chatId === "busy")?.status === "skipped", "Loop：会话等审批时本拍顺延");
  check(!dispatched.includes("busy"), "Loop：等审批时不再发 prompt");
  check(Boolean(busyRow && busyRow.nextAt - start >= 55_000), "Loop：等审批的顺延间隔按 retryMs");
  check(busyRow?.tick === 0, "Loop：顺延不占拍数");

  const approveRow = row("approve");
  check(ticks.find((item) => item.chatId === "approve")?.status === "ran", "Loop：没拿到批准记为跑过一拍，不算失败");
  check(approveRow?.tick === 1, "Loop：没拿到批准占一拍");
  check(Boolean(approveRow?.lastSummary?.includes("批准")), "Loop：摘要说明没拿到批准");
  check(Boolean(approveRow && approveRow.nextAt - start >= 55_000), "Loop：没拿到批准后按正常间隔排下一拍");
  check(approveRow?.status === "armed", "Loop：没拿到批准后不停止");

  const cancelRow = row("cancel");
  check(cancelRow?.tick === 0, "Loop：没开跑不占拍数");
  check(
    Boolean(cancelRow && cancelRow.nextAt - start >= 25_000),
    "Loop：没开跑的重试间隔不短于 30 秒左右，不空转",
  );

  loadTenants();
  const sandbox = (id: string) => sandboxEnabledForTenant(getTenant(id));
  check(sandbox("admin") === false, "沙箱：平台管理员不进沙箱");
  check(sandbox("billxu") === false, "沙箱：id 为 billxu 的租户不进沙箱");
  check(sandbox("alice") === true, "沙箱：显示名叫 BillXu 不能绕过沙箱");
  check(sandbox("carol") === false, "沙箱：tenants.json 里 sandbox: false 不进沙箱");
  check(sandbox("dave") === true, "沙箱：普通租户进沙箱");
  check(sandboxEnabledForTenant(null) === true, "沙箱：没有租户时默认进沙箱");
} catch (err) {
  failed += 1;
  console.log(`FAIL  冒烟异常：${err instanceof Error ? err.message : String(err)}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
