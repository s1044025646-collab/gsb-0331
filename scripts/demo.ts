import { resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DerService } from '../src/service.js';
import { fromHex } from '../src/der/hex.js';
import { renderTree } from '../src/render.js';
import { writeFixtures } from './fixtures.js';

const demoDir = resolve(process.cwd(), 'data', 'demo');
mkdtempSync(join(tmpdir(), 'der-demo-'));
writeFixtures(resolve(demoDir, 'fixtures'));

const dbPath = resolve(demoDir, 'der.db');
const svc = new DerService(dbPath);

process.stdout.write('=== 合法嵌套 SEQUENCE ===\n');
const goodHex =
  '30120201050101FF06032A03060C036162630500';
const good = svc.importBytes('demo-good.der', fromHex(goodHex));
process.stdout.write(`#${good.id} status=${good.status} 往返一致=${good.reencodedMatchesRaw}\n`);
process.stdout.write(`${renderTree(good.report!.root)}\n\n`);

process.stdout.write('=== 损坏输入：非规范 BOOLEAN 真值 0x01 ===\n');
const badBool = svc.importBytes('bad-boolean.der', fromHex('010101'));
process.stdout.write(`#${badBool.id} status=${badBool.status} ${badBool.error!.code} @${badBool.error!.offset}\n\n`);

process.stdout.write('=== 损坏输入：尾部多余字节 ===\n');
const trailing = svc.importBytes('trailing.der', fromHex('02010500'));
process.stdout.write(`#${trailing.id} status=${trailing.status} ${trailing.error!.code} @${trailing.error!.offset}\n\n`);

process.stdout.write('=== 历史记录（失败不作为成功树） ===\n');
for (const entry of svc.list()) {
  process.stdout.write(`#${entry.id} ${entry.status} ${entry.name}\n`);
}

process.stdout.write(`\n演示数据库: ${dbPath}\n`);
svc.close();
