import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DerService, resolvePath } from '../src/service.js';
import { fromHex } from '../src/der/hex.js';

let dir: string;
let dbPath: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'der-svc-'));
  dbPath = join(dir, 'der.db');
});

after(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(
    () => undefined,
  );
});

test('成功导入: 落库报告、原字节与版本', () => {
  const svc = new DerService(dbPath);
  const result = svc.importBytes('good.der', fromHex('3003020105'));
  assert.equal(result.status, 'success');
  assert.equal(result.version, 1);
  assert.equal(result.reencodedMatchesRaw, true);

  const loaded = svc.get(result.id)!;
  assert.equal(loaded.report!.inputHex, '3003020105');
  assert.equal(loaded.report!.subsetVersion, 'der-subset-1');
  const raw = svc.getRaw(result.id)!;
  assert.deepEqual([...raw.bytes], [0x30, 0x03, 0x02, 0x01, 0x05]);
  svc.close();
});

test('失败诊断: 保留错误偏移与父节点范围，不登记成功树', () => {
  const svc = new DerService(dbPath);
  const result = svc.importBytes('bad.der', fromHex('3006300402030500'));
  assert.equal(result.status, 'failure');
  assert.ok(result.error);
  assert.equal(typeof result.error!.offset, 'number');
  assert.ok(result.error!.parent);

  const direct = new DatabaseSync(dbPath);
  const row = direct
    .prepare('SELECT status, report_json, error_json FROM inputs WHERE id = ?')
    .get(result.id) as { status: string; report_json: string | null; error_json: string };
  assert.equal(row.status, 'failure');
  assert.equal(row.report_json, null);
  assert.match(row.error_json, /CHILD_EXCEEDS_CONTAINER/);
  direct.close();
  svc.close();
});

test('修改输入创建新版本（按相同 sha256 计数）', () => {
  const svc = new DerService(dbPath);
  const a = svc.importBytes('v.der', fromHex('020101'));
  const b = svc.importBytes('v.der', fromHex('020101'));
  const c = svc.importBytes('v.der', fromHex('020102'));
  assert.equal(a.version, 1);
  assert.equal(b.version, 2);
  assert.equal(c.version, 1);
  svc.close();
});

test('事务回滚: 同一失败导入不产生半条记录', () => {
  const svc = new DerService(dbPath);
  const before = (svc.list() ?? []).length;
  svc.importBytes('x.der', fromHex('010102'));
  const after = svc.list().length;
  assert.equal(after, before + 1);
  svc.close();
});

test('节点路径查询与旧报告重启后读取', () => {
  const svc = new DerService(dbPath);
  const imported = svc.importBytes('seq.der', fromHex('30080201050101FF0500'));
  const id = imported.id;
  const node = svc.getNode(id, '/1')!;
  assert.equal(node.tagName, 'BOOLEAN');
  assert.equal(resolvePath(imported.report!.root, '/2')!.tagName, 'NULL');
  assert.equal(svc.getNode(id, '/9'), null);
  svc.close();

  const reopened = new DerService(dbPath);
  const old = reopened.get(id)!;
  assert.equal(old.status, 'success');
  assert.equal(old.report!.root.children.length, 3);
  assert.equal(old.reencodedMatchesRaw, true);
  assert.ok(existsSync(dbPath));
  reopened.close();
});
