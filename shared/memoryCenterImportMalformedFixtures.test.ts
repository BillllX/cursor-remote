import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, test } from "node:test";
import {
  parseMemoryCenterExportData,
  parseMemoryCenterImportApplyData,
  parseMemoryCenterImportPreviewData,
  parseMemoryCenterImportRollbackData,
} from "./memoryCenterImportParse.ts";

function malformedFixturePath() {
  const candidates = [
    resolve(process.cwd(), "shared/fixtures/memory-center-import-malformed.json"),
    resolve(process.cwd(), "../shared/fixtures/memory-center-import-malformed.json"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error("memory-center-import-malformed.json not found");
}

type MalformedFixtures = {
  memory_center_export: unknown[];
  memory_center_import_preview: unknown[];
  memory_center_import_apply: unknown[];
  memory_center_import_rollback: unknown[];
};

function loadFixtures(): MalformedFixtures {
  return JSON.parse(readFileSync(malformedFixturePath(), "utf8")) as MalformedFixtures;
}

describe("memory-center-import-malformed fixtures", () => {
  test("all export malformed samples rejected", () => {
    const fx = loadFixtures();
    for (const sample of fx.memory_center_export) {
      assert.equal(parseMemoryCenterExportData(sample), null);
    }
  });

  test("all preview malformed samples rejected", () => {
    const fx = loadFixtures();
    for (const sample of fx.memory_center_import_preview) {
      assert.equal(parseMemoryCenterImportPreviewData(sample), null);
    }
  });

  test("all apply malformed samples rejected", () => {
    const fx = loadFixtures();
    for (const sample of fx.memory_center_import_apply) {
      assert.equal(parseMemoryCenterImportApplyData(sample), null);
    }
  });

  test("all rollback malformed samples rejected", () => {
    const fx = loadFixtures();
    for (const sample of fx.memory_center_import_rollback) {
      assert.equal(parseMemoryCenterImportRollbackData(sample), null);
    }
  });
});
