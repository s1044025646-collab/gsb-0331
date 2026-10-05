import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDer, bytesToHex } from '../src/der/parser.js';
import { encodeNode } from '../src/der/encoder.js';
import { DerError } from '../src/der/errors.js';
import { fromHex } from '../src/der/hex.js';
import { parseDer as parseDerWithLimits } from '../src/der/parser.js';
import { Limits } from '../src/der/limits.js';

function parse(hex: string) {
  return parseDer(fromHex(hex));
}

test('BOOLEAN: 00 为假，FF 为真，长度必须为 1', () => {
  assert.equal(parse('010100').root.interpretation.kind, 'boolean');
  assert.equal((parse('0101FF').root.interpretation as { value: boolean }).value, true);
  assert.throws(() => parse('010101'), (e: DerError) => e.code === 'BOOLEAN_BAD_VALUE');
  assert.throws(() => parse('01020000'), (e: DerError) => e.code === 'BOOLEAN_BAD_LENGTH');
});

test('INTEGER: 正负号、补码与非最短前导字节', () => {
  const positive = parse('02017F').root.interpretation as { decimal: string };
  assert.equal(positive.decimal, '127');
  const negative = parse('0201FF').root.interpretation as { decimal: string };
  assert.equal(negative.decimal, '-1');
  assert.equal(parse('020200FF').root.interpretation.kind, 'integer');
  assert.throws(() => parse('0202007F'), (e: DerError) => e.code === 'INTEGER_NON_MINIMAL');
  assert.throws(() => parse('0202FFFF'), (e: DerError) => e.code === 'INTEGER_NON_MINIMAL');
  assert.throws(() => parse('0200'), (e: DerError) => e.code === 'INTEGER_EMPTY');
});

test('INTEGER: 超出安全整数范围时给出十进制字符串', () => {
  const huge = '020A0102030405060708090A';
  const node = parse(huge).root.interpretation as {
    withinSafeInteger: boolean;
    decimal: string;
  };
  assert.equal(node.withinSafeInteger, false);
  assert.match(node.decimal, /^\d+$/);
});

test('长长度: 200 字节 OCTET STRING 使用 0x81 0xC8', () => {
  const content = Array.from({ length: 200 }, () => 0x41).join('');
  const report = parse(`0481C8${content}`);
  assert.equal(report.root.valueLength, 200);
});

test('长度: 拒绝不定长度与非最短长长度', () => {
  assert.throws(() => parse('30800000'), (e: DerError) => e.code === 'INDEFINITE_LENGTH');
  assert.throws(() => parse('04817F41'), (e: DerError) => e.code === 'NON_MINIMAL_LENGTH');
  assert.throws(() => parse('048200054141414141'), (e: DerError) =>
    e.code === 'NON_MINIMAL_LENGTH',
  );
});

test('SEQUENCE: 子节点完整占满，嵌套偏移正确', () => {
  const hex = '30080201050101FF0500';
  const root = parse(hex).root;
  assert.equal(root.tagName, 'SEQUENCE');
  assert.equal(root.start, 0);
  assert.equal(root.end, 10);
  assert.equal(root.children.length, 3);
  assert.deepEqual(
    root.children.map((child) => [child.start, child.end]),
    [[2, 5], [5, 8], [8, 10]],
  );
  assert.equal(root.children[1]!.path, '/1');
});

test('SEQUENCE: 拒绝子值越界、容器截断与尾部多余字节', () => {
  assert.throws(() => parse('3003020205'), (e: DerError) =>
    e.code === 'CHILD_EXCEEDS_CONTAINER',
  );
  assert.throws(
    () => parse('30050201050101'),
    (e: DerError) =>
      e.code === 'TRUNCATED' || e.code === 'CHILD_EXCEEDS_CONTAINER',
  );
  assert.throws(() => parse('300302010500'), (e: DerError) => e.code === 'TRAILING_BYTES');
});

test('BIT STRING: 校验未用位范围与填充位必须为零', () => {
  assert.equal(parse('030200FF').root.interpretation.kind, 'bitString');
  const bs = parse('03020340').root.interpretation as { effectiveBitLength: number };
  assert.equal(bs.effectiveBitLength, 5);
  assert.throws(() => parse('03020800'), (e: DerError) =>
    e.code === 'BITSTRING_UNUSED_BITS_RANGE',
  );
  assert.throws(() => parse('03020341'), (e: DerError) =>
    e.code === 'BITSTRING_UNUSED_BITS_NONZERO',
  );
  assert.throws(() => parse('030101'), (e: DerError) =>
    e.code === 'BITSTRING_UNUSED_BITS_SINGLE_ZERO',
  );
});

test('UTF8String: 接受合法多字节，拒绝损坏序列', () => {
  const node = parse(`0C06${bytesToHex(new TextEncoder().encode('你好'))}`).root
    .interpretation as { text: string };
  assert.equal(node.text, '你好');
  assert.throws(() => parse('0C01FF'), (e: DerError) => e.code === 'UTF8_INVALID');
  assert.throws(() => parse('0C02E4BDA0'), (e: DerError) => e.code === 'UTF8_INVALID');
});

test('OID: 首个合并分量大于 127 的多字节解码与恢复', () => {
  const node = parse('0603883700').root.interpretation as { dotted: string };
  assert.equal(node.dotted, '2.999.0');
});

test('OID: 常见 OID、未结束分量与非最短表示', () => {
  const node = parse('06032A0306').root.interpretation as { dotted: string };
  assert.equal(node.dotted, '1.2.3.6');
  const standard = parse('06012A').root.interpretation as { dotted: string };
  assert.equal(standard.dotted, '1.2');
  assert.throws(() => parse('06022A80'), (e: DerError) =>
    e.code === 'OID_UNTERMINATED' || e.code === 'OID_NON_MINIMAL',
  );
  assert.throws(() => parse('0603808001'), (e: DerError) => e.code === 'OID_NON_MINIMAL');
});

test('标签与构造位: 拒绝不支持标签与错误构造位', () => {
  assert.throws(() => parse('0A0100'), (e: DerError) => e.code === 'UNSUPPORTED_TAG');
  assert.throws(() => parse('2200'), (e: DerError) => e.code === 'BAD_CONSTRUCTED_BIT');
  assert.throws(() => parse('1000'), (e: DerError) => e.code === 'BAD_CONSTRUCTED_BIT');
});

test('往返: 所有手工合法夹具重编码后字节完全相同', () => {
  const cases = [
    '0101FF',
    '010100',
    '02017F',
    '0201FF',
    '0500',
    '0603883700',
    '30080201050101FF0500',
    `0481C8${'41'.repeat(200)}`,
  ];
  for (const hex of cases) {
    const report = parse(hex);
    assert.equal(encodeNode(report.root).hex, hex);
  }
});

test('资源上限: 超深嵌套与超大输入被拒绝', () => {
  let content = [0x02, 0x01, 0x00];
  for (let i = 0; i < 10; i++) {
    content = [0x30, content.length, ...content];
  }
  const hex = Buffer.from(content).toString('hex').toUpperCase();
  const strictLimits: Limits = { maxInputBytes: 1_048_576, maxDepth: 4 };
  assert.throws(
    () => parseDerWithLimits(fromHex(hex), strictLimits),
    (e: DerError) => e.code === 'NESTING_TOO_DEEP',
  );
  assert.throws(
    () => parseDerWithLimits(new Uint8Array(2_000_000), strictLimits),
    (e: DerError) => e.code === 'INPUT_TOO_LARGE',
  );
});

test('NULL: 长度必须为零', () => {
  assert.equal(parse('0500').root.interpretation.kind, 'null');
  assert.throws(() => parse('050100'), (e: DerError) => e.code === 'NULL_BAD_LENGTH');
});
