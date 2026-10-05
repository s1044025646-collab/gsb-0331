import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../src/store";
import { encodeNode } from "../src/der";

function tmpDb() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "der-")), "test.db");
}

test("导入成功文档并读取报告与重编码", () => {
  const s = new Store(tmpDb());
  const { doc, report } = s.importDocument("seq", Buffer.from("30080201010101ff0500", "hex"));
  assert.equal(doc.version, 1);
  assert.equal(report.ok, 1);
  const tree = s.getTree(doc.id)!;
  assert.equal(tree.tagName, "SEQUENCE");
  assert.equal(encodeNode(tree).toString("hex"), "30080201010101ff0500");
  assert.deepEqual(s.getBytes(doc.id)!.toString("hex"), "30080201010101ff0500");
  s.close();
});

test("失败诊断保留偏移与父范围,不登记成功树", () => {
  const s = new Store(tmpDb());
  const { report } = s.importDocument("bad", Buffer.from("3004020501ff", "hex"));
  assert.equal(report.ok, 0);
  const diags = JSON.parse(report.diagnostics);
  assert.equal(diags[0].code, "E_CONTENT_OVERRUN");
  assert.equal(diags[0].offset, 2);
  assert.equal(diags[0].parentStart, 0);
  assert.equal(diags[0].parentEnd, 6);
  assert.equal(s.getTree(1), undefined);
  s.close();
});

test("相同内容复用,修改输入创建新版本", () => {
  const s = new Store(tmpDb());
  const a = s.importDocument("doc", Buffer.from("0500", "hex"));
  const b = s.importDocument("doc", Buffer.from("0500", "hex"));
  assert.equal(b.reused, true);
  assert.equal(b.doc.id, a.doc.id);
  const c = s.importDocument("doc", Buffer.from("0501", "hex") /* 非法 NULL,仍是新版本 */);
  assert.equal(c.reused, false);
  assert.equal(c.doc.version, 2);
  assert.equal(c.report.ok, 0);
  s.close();
});

test("重启后仍可读取旧报告与原始字节", () => {
  const db = tmpDb();
  const s1 = new Store(db);
  const { doc } = s1.importDocument("persist", Buffer.from("02020100", "hex"));
  s1.close();
  const s2 = new Store(db);
  const r = s2.getReport(doc.id)!;
  assert.equal(r.ok, 1);
  assert.equal(s2.getBytes(doc.id)!.toString("hex"), "02020100");
  assert.equal(s2.getTree(doc.id)!.value, 256);
  s2.close();
});

test("资源上限: 超大输入", () => {
  const s = new Store(tmpDb());
  const big = Buffer.alloc(1024 * 1024 + 1, 0x30);
  const { report } = s.importDocument("huge", big);
  assert.equal(report.ok, 0);
  assert.equal(JSON.parse(report.diagnostics)[0].code, "E_SIZE_LIMIT");
  s.close();
});
