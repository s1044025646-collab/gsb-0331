import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import { DerService } from '../src/service.js';
import { createApp } from '../src/server.js';

let dir: string;
let server: Server;
let base: string;
let svc: DerService;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'der-api-'));
  svc = new DerService(join(dir, 'der.db'));
  server = createApp(svc);
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  svc.close();
  await rm(dir, { recursive: true, force: true });
});

async function jsonRequest(path: string, init?: RequestInit): Promise<{
  status: number;
  body: any;
}> {
  const res = await fetch(`${base}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  return { status: res.status, body: await res.json() };
}

test('GET /health', async () => {
  const { status, body } = await jsonRequest('/health');
  assert.equal(status, 200);
  assert.equal(body.status, 'ok');
});

test('POST 导入合法 hex 并按路径查节点、重编码', async () => {
  const imported = await jsonRequest('/api/inputs', {
    method: 'POST',
    body: JSON.stringify({ name: 'api.der', hex: '300602012A0101FF' }),
  });
  assert.equal(imported.status, 201);
  assert.equal(imported.body.reencodedMatchesRaw, true);
  const id = imported.body.id;

  const node = await jsonRequest(`/api/inputs/${id}/node?path=/0`);
  assert.equal(node.status, 200);
  assert.equal(node.body.node.tagName, 'INTEGER');

  const reencoded = await jsonRequest(`/api/inputs/${id}/reencode`, { method: 'POST' });
  assert.equal(reencoded.body.matchesRaw, true);

  const listed = await jsonRequest('/api/inputs');
  assert.ok(listed.body.entries.some((entry: { id: number }) => entry.id === id));
});

test('损坏输入返回明确错误码与偏移，且可在报告端点读取失败记录', async () => {
  const imported = await jsonRequest('/api/inputs', {
    method: 'POST',
    body: JSON.stringify({ hex: '3003020500' }),
  });
  assert.equal(imported.status, 201);
  assert.equal(imported.body.status, 'failure');
  assert.match(imported.body.error.code, /TRUNCATED|CHILD_EXCEEDS_CONTAINER/);
  assert.equal(typeof imported.body.error.offset, 'number');

  const report = await jsonRequest(`/api/inputs/${imported.body.id}/report`);
  assert.equal(report.body.status, 'failure');
});

test('非法 hex 与未知路由的参数校验', async () => {
  const bad = await jsonRequest('/api/inputs', {
    method: 'POST',
    body: JSON.stringify({ hex: 'ZZ' }),
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'INVALID_HEX');

  const missing = await jsonRequest('/api/inputs', {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assert.equal(missing.body.error.code, 'INVALID_ARGUMENT');

  const notFound = await jsonRequest('/nope');
  assert.equal(notFound.status, 404);
});
