import type { MemoryCenterSnapshotV1 } from "./memoryCenterSnapshot.ts";

export type MemoryCenterImportChangeLayer =
  | "personal_core"
  | "personal_entries"
  | "personal_settings"
  | "work_preference"
  | "workspace_entries"
  | "workspace_structure"
  | "rules_inventory";

export type MemoryCenterImportChangeAction = "add" | "update" | "conflict" | "unchanged" | "skip";

export type MemoryCenterImportResolution = "keep_current" | "use_snapshot" | "duplicate";

export type MemoryCenterImportChangeSummary = {
  id?: string;
  scope?: string;
  section?: string;
  textPreview: string;
  revision?: string;
  checksum?: string;
};

export type MemoryCenterImportChange = {
  changeId: string;
  layer: MemoryCenterImportChangeLayer;
  action: MemoryCenterImportChangeAction;
  scope?: string;
  id?: string;
  reason?: string;
  current?: MemoryCenterImportChangeSummary;
  incoming?: MemoryCenterImportChangeSummary;
  allowedResolutions: MemoryCenterImportResolution[];
};

export type MemoryCenterImportWarning = {
  code: "unknown_scope" | "rules_changed" | "missing_refs" | "stale_refs" | "snapshot_warning";
  message: string;
  scope?: string;
};

export type MemoryCenterImportPreviewData = {
  planId: string;
  expiresAt: string;
  snapshotSummary: {
    exportedAt: string;
    schemaVersion: number;
    scopeCount: number;
    personalEntryCount: number;
    rulesCount: number;
    bytes: number;
    checksum: string;
  };
  changes: MemoryCenterImportChange[];
  warnings: MemoryCenterImportWarning[];
};

export type MemoryCenterImportPreviewErrorCode =
  | "invalid_path"
  | "read_failed"
  | "malformed_snapshot"
  | "size_limit"
  | "security";

export type MemoryCenterImportApplyResolution = {
  changeId: string;
  resolution: MemoryCenterImportResolution;
};

export type MemoryCenterImportApplyData = {
  importId: string;
  summary: {
    applied: number;
    skipped: number;
    conflictsResolved: number;
  };
  canRollback: true;
  overview?: unknown;
};

export type MemoryCenterImportApplyErrorCode =
  | "plan_not_found"
  | "plan_expired"
  | "cas_conflict"
  | "unresolved_conflict"
  | "invalid_resolution"
  | "duplicate_resolution"
  | "write_failed";

export type MemoryCenterImportRollbackData = {
  importId: string;
  status: "rolled_back" | "already_rolled_back";
};

export type MemoryCenterImportRollbackErrorCode = "not_found" | "not_latest" | "hash_conflict" | "write_failed";

export type MemoryCenterExportData = {
  relativePath: string;
  sha256: string;
  bytes: number;
  summary: {
    scopes: string[];
    personalEntries: number;
    workspaceScopes: number;
    rulesInventory: number;
  };
};

export type StoredImportPlan = {
  planId: string;
  createdAt: string;
  expiresAt: string;
  snapshotBytes: string;
  snapshotSha256: string;
  casHashes: Record<string, string>;
  changes: MemoryCenterImportChange[];
  warnings: MemoryCenterImportWarning[];
  snapshotSummary: MemoryCenterImportPreviewData["snapshotSummary"];
};

export type ImportPlanSnapshot = MemoryCenterSnapshotV1;
