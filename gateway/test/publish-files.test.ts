import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test, type TestContext } from "node:test";
import { log } from "../src/log.ts";
import { clearPersisted, readGen, writeGen, writeTokenFile } from "../src/publish.ts";

const root = mkdtempSync(join(tmpdir(), "cr-publish-files-"));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const tenant = () => {
  const stateDir = join(root, `t${(n += 1)}`);
  return { id: `t${n}`, stateDir, workspaceRoot: join(stateDir, "workspace") };
};

describe("publish 状态文件", () => {
  test("口令文件原子写：0600 权限，覆盖旧的宽权限文件，目录里不留临时文件", () => {
    const dir = join(root, "token");
    const file = join(dir, "sub", "publish-token");
    writeTokenFile(file, "a".repeat(64));
    assert.equal(readFileSync(file, "utf8"), `${"a".repeat(64)}\n`);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    chmodSync(file, 0o644);
    writeTokenFile(file, "b".repeat(64));
    assert.equal(readFileSync(file, "utf8"), `${"b".repeat(64)}\n`);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(join(dir, "sub")), ["publish-token"]);
  });

  test("publish-gen 原子写，读回同一个值", () => {
    const t = tenant();
    writeGen(t, 3);
    writeGen(t, 4);
    assert.equal(readGen(t), 4);
    assert.deepEqual(readdirSync(t.stateDir), ["publish-gen"]);
  });

  test("clearPersisted：文件不存在不报，其它删除失败 warn", (t: TestContext) => {
    const warn = t.mock.method(log, "warn", () => {});
    const gone = tenant();
    clearPersisted(gone);
    assert.equal(warn.mock.callCount(), 0);

    const ok = tenant();
    mkdirSync(ok.stateDir, { recursive: true });
    writeFileSync(join(ok.stateDir, "publish.json"), "{}");
    clearPersisted(ok);
    assert.deepEqual(readdirSync(ok.stateDir), []);
    assert.equal(warn.mock.callCount(), 0);

    // publish.json 是目录时 unlink 报 EISDIR/EPERM
    const bad = tenant();
    mkdirSync(join(bad.stateDir, "publish.json"), { recursive: true });
    clearPersisted(bad);
    assert.equal(warn.mock.callCount(), 1);
  });
});
