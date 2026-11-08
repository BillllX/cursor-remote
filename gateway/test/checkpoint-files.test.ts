import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { CHECKPOINT_MAX_FILE_BYTES, checkpointFiles } from "../src/workspace/checkpoints.ts";

describe("checkpointFiles", () => {
  const root = mkdtempSync(join(tmpdir(), "checkpoint-files-"));
  after(() => rmSync(root, { recursive: true, force: true }));

  test("跳过大文件和读不到的路径，留下普通文件", () => {
    writeFileSync(join(root, "note.txt"), "hello");
    writeFileSync(join(root, "blob.bin"), Buffer.alloc(CHECKPOINT_MAX_FILE_BYTES + 1));
    const kept = checkpointFiles(root, ["note.txt", "blob.bin", "missing.txt", ""]);
    assert.deepEqual(kept, ["note.txt"]);
  });
});
