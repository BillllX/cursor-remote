// 长录音独立 SQLite WAL 表结构（每个租户独立数据库，物理隔离）
import type { DatabaseSync } from "node:sqlite";

export function initializeRecordingSchema(db: DatabaseSync) {
  db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  const version = Number(row?.user_version ?? 0);
  if (version !== 0 && version !== 1) {
    throw new Error(`长录音数据库版本不兼容：v${version}`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS recording_sessions (
      session_id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 1,
      revision INTEGER NOT NULL DEFAULT 1,
      provisional INTEGER NOT NULL DEFAULT 0,
      title TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      stopped_at INTEGER,
      route_kind TEXT NOT NULL,
      workspace_id TEXT,
      policy_json TEXT NOT NULL,
      policy_hash TEXT NOT NULL,
      format_json TEXT NOT NULL,
      capture_state TEXT NOT NULL,
      transfer_state TEXT NOT NULL,
      processing_state TEXT NOT NULL,
      coverage TEXT NOT NULL DEFAULT 'none',
      expected_chunks INTEGER NOT NULL DEFAULT 0,
      expected_total_frames INTEGER NOT NULL DEFAULT 0,
      expected_total_bytes INTEGER NOT NULL DEFAULT 0,
      audio_uploaded INTEGER NOT NULL DEFAULT 1,
      audio_expired INTEGER NOT NULL DEFAULT 0,
      raw_expires_at INTEGER,
      text_expires_at INTEGER,
      manifest_hash TEXT,
      transcript_revision INTEGER NOT NULL DEFAULT 0,
      result_revision INTEGER,
      missing_ranges_json TEXT NOT NULL DEFAULT '[]',
      last_error_json TEXT,
      next_attempt_at INTEGER,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_rec_sessions_updated ON recording_sessions(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_rec_sessions_provisional ON recording_sessions(device_id, provisional);

    CREATE TABLE IF NOT EXISTS recording_chunks (
      session_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      epoch_id TEXT NOT NULL,
      capture_start_frame INTEGER NOT NULL,
      valid_frame_count INTEGER NOT NULL,
      bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      mime TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      receipt_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expired INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_id, generation, seq)
    );

    CREATE INDEX IF NOT EXISTS idx_rec_chunks_receipt ON recording_chunks(receipt_id);

    CREATE TABLE IF NOT EXISTS recording_manifests (
      session_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      manifest_hash TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, generation)
    );

    CREATE TABLE IF NOT EXISTS recording_transcripts (
      session_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      source TEXT NOT NULL,
      locale TEXT NOT NULL,
      granularity TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, generation, revision)
    );

    CREATE TABLE IF NOT EXISTS recording_results (
      session_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      result_revision INTEGER NOT NULL,
      transcript_revision INTEGER NOT NULL,
      coverage TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, generation, result_revision)
    );

    CREATE TABLE IF NOT EXISTS recording_jobs (
      job_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      stage TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      lease_owner TEXT,
      lease_until INTEGER,
      next_attempt_at INTEGER NOT NULL,
      error_code TEXT,
      error_message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (session_id, generation, stage, input_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_rec_jobs_due ON recording_jobs(status, next_attempt_at);

    CREATE TABLE IF NOT EXISTS recording_deliveries (
      delivery_key TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      result_revision INTEGER NOT NULL,
      route_kind TEXT NOT NULL,
      workspace_id TEXT,
      status TEXT NOT NULL,
      target_receipt TEXT,
      workspace_batch_id TEXT,
      workspace_key TEXT,
      inbox_item_id TEXT,
      error TEXT,
      ack_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recording_upload_grants (
      grant_id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      device_id TEXT NOT NULL,
      namespace_prefix TEXT NOT NULL,
      route_kind TEXT NOT NULL,
      workspace_id TEXT,
      policy_json TEXT NOT NULL,
      policy_hash TEXT NOT NULL,
      max_chunk_bytes INTEGER NOT NULL,
      max_total_bytes INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_rec_grants_device ON recording_upload_grants(device_id, revoked_at);

    CREATE TABLE IF NOT EXISTS recording_tombstones (
      session_id TEXT PRIMARY KEY,
      generation INTEGER NOT NULL,
      deleted_at INTEGER NOT NULL,
      delete_linked_memories INTEGER NOT NULL DEFAULT 0,
      objects_purged INTEGER NOT NULL DEFAULT 0,
      index_purged INTEGER NOT NULL DEFAULT 0,
      deliveries_revoked INTEGER NOT NULL DEFAULT 0,
      local_cleanup_acked INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS recording_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      generation INTEGER,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      result TEXT NOT NULL,
      reason TEXT,
      created_at INTEGER NOT NULL
    );

    PRAGMA user_version=1;
  `);
}
