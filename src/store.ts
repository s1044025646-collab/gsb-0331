import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseDer, SUBSET_VERSION, DerNode, Diagnostic } from "./der";

export const DATA_DIR = path.join(process.cwd(), "data");
export const DB_PATH = path.join(DATA_DIR, "der.db");

export interface DocumentRow {
  id: number;
  name: string;
  version: number;
  sha256: string;
  size: number;
  subset_version: string;
  created_at: string;
}

export interface ReportRow {
  id: number;
  document_id: number;
  ok: number;
  diagnostics: string;
  tree: string | null;
  created_at: string;
}

export class Store {
  db: DatabaseSync;
  constructor(dbPath: string = DB_PATH) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        size INTEGER NOT NULL,
        bytes BLOB NOT NULL,
        subset_version TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(name, version)
      );
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id INTEGER NOT NULL REFERENCES documents(id),
        ok INTEGER NOT NULL,
        diagnostics TEXT NOT NULL,
        tree TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  importDocument(name: string, bytes: Buffer): { doc: DocumentRow; report: ReportRow; reused: boolean } {
    if (!name || name.length > 200) throw new Error("E_VALIDATION: 名称缺失或过长");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const existing = this.db.prepare("SELECT * FROM documents WHERE name = ? AND sha256 = ? ORDER BY version DESC")
      .get(name, sha256) as unknown as DocumentRow | undefined;
    if (existing) {
      const report = this.db.prepare("SELECT * FROM reports WHERE document_id = ? ORDER BY id DESC").get(existing.id) as unknown as ReportRow;
      return { doc: existing, report, reused: true };
    }
    const maxV = this.db.prepare("SELECT MAX(version) AS v FROM documents WHERE name = ?").get(name) as { v: number | null };
    const version = (maxV.v ?? 0) + 1;
    const result = parseDer(bytes);
    const insertDoc = this.db.prepare(
      "INSERT INTO documents (name, version, sha256, size, bytes, subset_version) VALUES (?, ?, ?, ?, ?, ?)");
    const insertReport = this.db.prepare(
      "INSERT INTO reports (document_id, ok, diagnostics, tree) VALUES (?, ?, ?, ?)");
    // 事务: 解析失败同样落库为失败报告,但不登记成功树;任一步失败整体回滚
    this.db.exec("BEGIN");
    try {
      const info = insertDoc.run(name, version, sha256, bytes.length, bytes, SUBSET_VERSION);
      const docId = Number(info.lastInsertRowid);
      insertReport.run(
        docId,
        result.ok ? 1 : 0,
        JSON.stringify(result.diagnostics),
        result.ok ? JSON.stringify(result.node) : null);
      this.db.exec("COMMIT");
      const doc = this.db.prepare("SELECT * FROM documents WHERE id = ?").get(docId) as unknown as DocumentRow;
      const report = this.db.prepare("SELECT * FROM reports WHERE document_id = ? ORDER BY id DESC").get(docId) as unknown as ReportRow;
      return { doc, report, reused: false };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  getDocument(id: number): DocumentRow | undefined {
    return this.db.prepare("SELECT id, name, version, sha256, size, subset_version, created_at FROM documents WHERE id = ?").get(id) as unknown as DocumentRow | undefined;
  }

  getBytes(id: number): Buffer | undefined {
    const row = this.db.prepare("SELECT bytes FROM documents WHERE id = ?").get(id) as { bytes: Buffer } | undefined;
    return row ? Buffer.from(row.bytes) : undefined;
  }

  listDocuments(): DocumentRow[] {
    return this.db.prepare("SELECT id, name, version, sha256, size, subset_version, created_at FROM documents ORDER BY id").all() as unknown as DocumentRow[];
  }

  getReport(documentId: number): ReportRow | undefined {
    return this.db.prepare("SELECT * FROM reports WHERE document_id = ? ORDER BY id DESC").get(documentId) as unknown as ReportRow | undefined;
  }

  getTree(documentId: number): DerNode | undefined {
    const r = this.getReport(documentId);
    if (!r || !r.ok || !r.tree) return undefined;
    return JSON.parse(r.tree) as DerNode;
  }

  getDiagnostics(documentId: number): Diagnostic[] | undefined {
    const r = this.getReport(documentId);
    if (!r) return undefined;
    return JSON.parse(r.diagnostics) as Diagnostic[];
  }

  close() { this.db.close(); }
}
