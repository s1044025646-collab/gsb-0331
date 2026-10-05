import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface InputRow {
  id: number;
  sha256: string;
  name: string;
  raw: Buffer;
  subset_version: string;
  status: 'success' | 'failure';
  report_json: string | null;
  error_json: string | null;
  created_at: string;
}

export function openDatabase(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA foreign_keys=ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS inputs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sha256 TEXT NOT NULL,
      name TEXT NOT NULL,
      raw BLOB NOT NULL,
      subset_version TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('success','failure')),
      report_json TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_inputs_sha ON inputs(sha256);
  `);
  return db;
}
