import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { openDatabase } from './db.js';
import { parseDer, ParseReport, DerNode, bytesToHex } from './der/parser.js';
import { encodeNode } from './der/encoder.js';
import { DerError } from './der/errors.js';
import { SUBSET_VERSION, Limits, DEFAULT_LIMITS } from './der/limits.js';
import { toJson, fromJson } from './der/json.js';

export interface StoredFailure {
  code: string;
  message: string;
  offset: number;
  parent: unknown;
}

export interface ImportResult {
  id: number;
  sha256: string;
  status: 'success' | 'failure';
  version: number;
  name: string;
  report?: ParseReport;
  error?: StoredFailure;
  reencodedHex?: string;
  reencodedMatchesRaw: boolean;
  reencodedCanonical: boolean;
}

export interface ListEntry {
  id: number;
  sha256: string;
  name: string;
  status: 'success' | 'failure';
  subsetVersion: string;
  createdAt: string;
}

export class DerService {
  private readonly db: DatabaseSync;

  constructor(dbPath: string, private readonly limits: Limits = DEFAULT_LIMITS) {
    this.db = openDatabase(dbPath);
  }

  close(): void {
    this.db.close();
  }

  importBytes(name: string, bytes: Uint8Array): ImportResult {
    const sha256 = createHash('sha256').update(bytes).digest('hex');

    const insert = this.db.prepare(
      `INSERT INTO inputs (sha256, name, raw, subset_version, status, report_json, error_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const versionStmt = this.db.prepare(
      'SELECT COUNT(*) AS n FROM inputs WHERE sha256 = ? AND id <= ?',
    );

    const executeImport = (): ImportResult => {
      let report: ParseReport | null = null;
      let failure: StoredFailure | null = null;
      try {
        report = parseDer(bytes, this.limits);
      } catch (err) {
        if (err instanceof DerError) {
          failure = {
            code: err.code,
            message: err.message,
            offset: err.offset,
            parent: err.parent,
          };
        } else {
          failure = {
            code: 'UNEXPECTED_ERROR',
            message: err instanceof Error ? err.message : String(err),
            offset: 0,
            parent: null,
          };
        }
      }

      const status = report ? 'success' : 'failure';
      const info = insert.run(
        sha256,
        name,
        Buffer.from(bytes),
        SUBSET_VERSION,
        status,
        report ? toJson(report) : null,
        failure ? toJson(failure) : null,
      );
      const id = Number(info.lastInsertRowid);
      const version = Number(versionStmt.get(sha256, id)!.n);

      const result: ImportResult = {
        id,
        sha256,
        status,
        version,
        name,
        reencodedMatchesRaw: false,
        reencodedCanonical: false,
      };
      if (report) {
        result.report = report;
        const reencoded = encodeNode(report.root);
        result.reencodedHex = reencoded.hex;
        result.reencodedCanonical = reencoded.canonical;
        result.reencodedMatchesRaw = reencoded.hex === bytesToHex(bytes);
      } else {
        result.error = failure ?? undefined;
      }
      return result;
    };

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = executeImport();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  list(): ListEntry[] {
    return this.db
      .prepare(
        `SELECT id, sha256, name, status, subset_version AS subsetVersion,
                created_at AS createdAt
         FROM inputs ORDER BY id ASC`,
      )
      .all() as unknown as ListEntry[];
  }

  get(id: number): ImportResult | null {
    const row = this.db.prepare('SELECT * FROM inputs WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      return null;
    }
    const raw = new Uint8Array(row.raw as Buffer);
    const status = row.status as 'success' | 'failure';
    const sha256 = row.sha256 as string;
    const base: ImportResult = {
      id: Number(row.id),
      sha256,
      status,
      version: this.versionOf(sha256, Number(row.id)),
      name: row.name as string,
      reencodedMatchesRaw: false,
      reencodedCanonical: false,
    };
    if (status === 'success' && typeof row.report_json === 'string') {
      const report = fromJson<ParseReport>(row.report_json);
      base.report = report;
      const reencoded = encodeNode(report.root);
      base.reencodedHex = reencoded.hex;
      base.reencodedCanonical = reencoded.canonical;
      base.reencodedMatchesRaw = reencoded.hex === bytesToHex(raw);
    } else if (typeof row.error_json === 'string') {
      base.error = fromJson<StoredFailure>(row.error_json);
    }
    return base;
  }

  getNode(id: number, path: string): DerNode | null {
    const entry = this.get(id);
    if (!entry || !entry.report) {
      return null;
    }
    return resolvePath(entry.report.root, path);
  }

  getRaw(id: number): { name: string; bytes: Uint8Array } | null {
    const row = this.db.prepare('SELECT name, raw FROM inputs WHERE id = ?').get(id) as
      | { name: string; raw: Buffer }
      | undefined;
    if (!row) {
      return null;
    }
    return { name: row.name, bytes: new Uint8Array(row.raw) };
  }

  private versionOf(sha256: string, id: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM inputs WHERE sha256 = ? AND id <= ?')
      .get(sha256, id) as { n: number };
    return Number(row.n);
  }
}

export function resolvePath(root: DerNode, path: string): DerNode | null {
  if (path === '' || path === '/') {
    return root;
  }
  const normalized = path.startsWith('/') ? path.slice(1) : path;
  if (normalized === '') {
    return root;
  }
  const segments = normalized.split('/').map((segment) => Number(segment));
  if (segments.some((segment) => !Number.isInteger(segment) || segment < 0)) {
    return null;
  }
  let current: DerNode = root;
  for (const segment of segments) {
    const child = current.children[segment];
    if (!child) {
      return null;
    }
    current = child;
  }
  return current;
}
