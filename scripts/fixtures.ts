import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { encodeLength } from '../src/der/encoder-lib.js';

function tlv(tag: number, content: number[], constructed = false): number[] {
  return [(constructed ? tag | 0x20 : tag), ...encodeLength(content.length), ...content];
}

function integerBytes(value: number | bigint): number[] {
  let v = BigInt(value);
  if (v === 0n) {
    return [0x00];
  }
  const bytes: number[] = [];
  const negative = v < 0n;
  let bits = 0;
  let probe = negative ? ~v : v;
  while (probe > 0n) {
    bits++;
    probe >>= 1n;
  }
  const byteCount = Math.max(1, Math.ceil((bits + 1) / 8));
  if (negative) {
    v += 1n << BigInt(byteCount * 8);
  }
  let rest = v;
  for (let i = 0; i < byteCount; i++) {
    bytes.unshift(Number(rest & 0xffn));
    rest >>= 8n;
  }
  return bytes;
}

const booleanTrue = tlv(0x01, [0xff]);
const booleanFalse = tlv(0x01, [0x00]);
const integerPositive = tlv(0x02, integerBytes(127));
const integerNegative = tlv(0x02, integerBytes(-1));
const longOctetString = tlv(0x04, Array.from({ length: 200 }, (_, i) => i % 256));

const oidBigFirst: number[] = [];
{
  const combined = 2n * 40n + 800n;
  const chunks: number[] = [];
  let value = combined;
  do {
    chunks.unshift(Number(value & 0x7fn));
    value >>= 7n;
  } while (value > 0n);
  chunks.forEach((c, i) => oidBigFirst.push(i === chunks.length - 1 ? c : c | 0x80));
}
const oid = tlv(0x06, oidBigFirst);

const utf8 = tlv(0x0c, Array.from(new TextEncoder().encode('你好, ASN.1')));
const sequence = tlv(
  0x10,
  [...integerPositive, ...booleanFalse, ...oid, ...longOctetString],
  true,
);
const wrapper = tlv(0x10, [...sequence, ...integerNegative, ...utf8, ...booleanTrue], true);

export const fixtures: Record<string, number[]> = {
  'boolean-true': booleanTrue,
  'boolean-false': booleanFalse,
  'integer-positive': integerPositive,
  'integer-negative': integerNegative,
  'long-octet-string': longOctetString,
  'oid-big-first': oid,
  'utf8-hello': utf8,
  'nested-sequence': wrapper,
};

export function writeFixtures(dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of Object.entries(fixtures)) {
    writeFileSync(resolve(dir, `${name}.der`), Uint8Array.from(bytes));
  }
}

if (process.argv[1]?.match(/fixtures\.[jt]s$/)) {
  const outDir = resolve(process.cwd(), 'fixtures');
  writeFixtures(outDir);
  for (const [name, bytes] of Object.entries(fixtures)) {
    const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    process.stdout.write(`${name}: ${hex.slice(0, 80)}${hex.length > 80 ? '…' : ''}\n`);
  }
}
