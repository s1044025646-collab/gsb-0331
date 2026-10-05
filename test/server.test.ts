import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startServer } from "../src/server";

let base = "";
let closeFn: () => void;

before(async () => {
  const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "der-api-")), "api.db");
  const { server, port } = await startServer(0, db);
  base = `http://127.0.0.1:${port}`;
  closeFn = () => server.close();
});
after(() => closeFn());

async function post(p: string, body: unknown) {
  const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
}

test("API 导入/报告/节点/编码/比较/导出", async () => {
  const hex = "30080201010101ff0500";
  const imp = await post("/documents", { name: "api-seq", hex });
  assert.equal(imp.status, 201);
  const id = imp.json.document.id;
  assert.equal(imp.json.ok, true);

  const rep = await fetch(`${base}/documents/${id}/report`).then((r) => r.json());
  assert.equal(rep.ok, true);
  assert.equal(rep.tree.children.length, 3);

  const node = await fetch(`${base}/documents/${id}/nodes?path=0`).then((r) => r.json());
  assert.equal(node.node.value, 1);
  assert.equal(node.node.offset, 2);

  const enc = await post(`/documents/${id}/encode`, {});
  assert.equal(enc.json.hex, hex);
  assert.equal(enc.json.canonical, true);

  const imp2 = await post("/documents", { name: "api-seq2", hex: "0500" });
  const cmp = await fetch(`${base}/documents/${id}/compare?other=${imp2.json.document.id}`).then((r) => r.json());
  assert.equal(cmp.equal, false);

  const exp = await fetch(`${base}/documents/${id}/export`);
  assert.equal(Buffer.from(await exp.arrayBuffer()).toString("hex"), hex);

  const tree = await fetch(`${base}/documents/${id}/tree`).then((r) => r.text());
  assert.match(tree, /\[0\] SEQUENCE len=8/);
});

test("API 失败诊断与参数校验", async () => {
  const bad = await post("/documents", { name: "bad", hex: "308005000000" });
  assert.equal(bad.json.ok, false);
  assert.equal(bad.json.diagnostics[0].code, "E_INDEFINITE_LENGTH");
  const id = bad.json.document.id;
  const enc = await post(`/documents/${id}/encode`, {});
  assert.equal(enc.status, 409);
  assert.equal(enc.json.error.code, "E_PARSE_FAILED");

  assert.equal((await post("/documents", { hex: "0500" })).json.error.code, "E_VALIDATION");
  assert.equal((await post("/documents", { name: "x", hex: "zz" })).json.error.code, "E_VALIDATION");
  assert.equal((await post("/documents", { name: "x", hex: "" })).json.error.code, "E_EMPTY_INPUT");
  const nf = await fetch(`${base}/documents/9999/report`);
  assert.equal(nf.status, 404);
});

test("一次性解析接口", async () => {
  const r = await post("/parse", { hex: "02020100" });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.node.value, 256);
});
