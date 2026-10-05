import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDer, encodeNode, findNode, MAX_DEPTH } from "../src/der";

const H = (hex: string) => Buffer.from(hex, "hex");

test("SEQUENCE 手工字节: 偏移与值", () => {
  const r = parseDer(H("30080201010101ff0500"));
  assert.equal(r.ok, true);
  const n = r.node!;
  assert.equal(n.tagName, "SEQUENCE");
  assert.equal(n.offset, 0);
  assert.equal(n.length, 8);
  assert.equal(n.end, 10);
  const [i, b, z] = n.children!;
  assert.deepEqual([i.offset, i.length, i.value], [2, 1, 1]);
  assert.deepEqual([b.offset, b.value], [5, true]);
  assert.deepEqual([z.offset, z.value], [8, null]);
});

test("INTEGER 正数需要前导 00 时合法", () => {
  const r = parseDer(H("02020100"));
  assert.equal(r.ok, true);
  assert.equal(r.node!.value, 256);
});

test("INTEGER 负数 -1 与大数", () => {
  assert.equal(parseDer(H("0201ff")).node!.value, -1);
  assert.equal(parseDer(H("020180")).node!.value, -128);
  const big = parseDer(H("02090123456789abcdef00"));
  assert.equal(big.ok, true);
  assert.equal(big.node!.value, BigInt("0x0123456789abcdef00").toString(10));
});

test("拒绝非最短 INTEGER", () => {
  assert.equal(parseDer(H("0202007f")).diagnostics[0].code, "E_INTEGER_NON_MINIMAL");
  assert.equal(parseDer(H("0202ff80")).diagnostics[0].code, "E_INTEGER_NON_MINIMAL");
  assert.equal(parseDer(H("0200")).diagnostics[0].code, "E_INTEGER_EMPTY");
});

test("BOOLEAN 非规范真值与长度", () => {
  assert.equal(parseDer(H("010101")).diagnostics[0].code, "E_BOOLEAN_NONCANONICAL");
  assert.equal(parseDer(H("010200ff")).diagnostics[0].code, "E_BOOLEAN_LENGTH");
  assert.equal(parseDer(H("0101ff")).node!.value, true);
  assert.equal(parseDer(H("010100")).node!.value, false);
});

test("NULL 长度必须为 0", () => {
  assert.equal(parseDer(H("0500")).ok, true);
  assert.equal(parseDer(H("050100")).diagnostics[0].code, "E_NULL_LENGTH");
});

test("不定长度被拒绝", () => {
  assert.equal(parseDer(H("308005000000")).diagnostics[0].code, "E_INDEFINITE_LENGTH");
});

test("非最短长度被拒绝", () => {
  assert.equal(parseDer(H("048103aabbcc")).diagnostics[0].code, "E_NON_MINIMAL_LENGTH");
  assert.equal(parseDer(H("048200c8" + "ab".repeat(200))).diagnostics[0].code, "E_NON_MINIMAL_LENGTH");
});

test("长长度 OCTET STRING 合法", () => {
  const r = parseDer(H("0481c8" + "ab".repeat(200)));
  assert.equal(r.ok, true);
  assert.equal(r.node!.length, 200);
  assert.equal(r.node!.headerLength, 3);
});

test("截断与越界", () => {
  assert.equal(parseDer(H("0202ff")).diagnostics[0].code, "E_CONTENT_OVERRUN");
  assert.equal(parseDer(H("02")).diagnostics[0].code, "E_TRUNCATED");
  // 子值越过容器结尾
  assert.equal(parseDer(H("3004020501ff")).diagnostics[0].code, "E_CONTENT_OVERRUN");
});

test("尾部多余字节", () => {
  const d = parseDer(H("0500ff")).diagnostics[0];
  assert.equal(d.code, "E_TRAILING_BYTES");
  assert.equal(d.offset, 2);
});

test("SEQUENCE 内容必须恰好占满", () => {
  // 内容长度 3 但只有一个 2 字节子节点后剩 1 字节无法解析
  assert.equal(parseDer(H("3003050000")).ok, false);
});

test("不支持的标签与构造位", () => {
  assert.equal(parseDer(H("1a00")).diagnostics[0].code, "E_UNSUPPORTED_TAG"); // 通用16? 不,0x1a=通用26 不支持
  assert.equal(parseDer(H("8200")).diagnostics[0].code, "E_UNSUPPORTED_TAG"); // 上下文类
  assert.equal(parseDer(H("1f00")).diagnostics[0].code, "E_UNSUPPORTED_TAG"); // 高标签号
  assert.equal(parseDer(H("2101ff")).diagnostics[0].code, "E_BAD_CONSTRUCTED"); // 构造位错误的 BOOLEAN
  assert.equal(parseDer(H("1000")).diagnostics[0].code, "E_BAD_CONSTRUCTED"); // 原始形式的 SEQUENCE
});

test("BIT STRING 填充位", () => {
  assert.equal(parseDer(H("030202f0")).ok, true);
  assert.equal(parseDer(H("030202f1")).diagnostics[0].code, "E_BITSTRING_PADDING");
  assert.equal(parseDer(H("030108")).diagnostics[0].code, "E_BITSTRING_UNUSED_RANGE");
  assert.equal(parseDer(H("030105")).diagnostics[0].code, "E_BITSTRING_UNUSED_RANGE");
  assert.equal(parseDer(H("0300")).diagnostics[0].code, "E_BITSTRING_EMPTY");
});

test("UTF8String 严格校验", () => {
  assert.equal(parseDer(H("0c06e4bda0e5a5bd")).node!.value, "你好");
  assert.equal(parseDer(H("0c01ff")).diagnostics[0].code, "E_UTF8_INVALID");
  assert.equal(parseDer(H("0c02c080")).diagnostics[0].code, "E_UTF8_INVALID"); // 过长编码
});

test("OCTET STRING 保留任意字节", () => {
  const r = parseDer(H("0402fffe"));
  assert.equal(r.ok, true);
  assert.equal(r.node!.value, "fffe");
});

test("OID 首合并分量 >127 及非最短", () => {
  const r = parseDer(H("0603883703"));
  assert.equal(r.ok, true);
  assert.equal(r.node!.value, "2.999.3");
  assert.equal(parseDer(H("06012a")).node!.value, "1.2");
  assert.equal(parseDer(H("060188")).diagnostics[0].code, "E_OID_TRUNCATED"); // 0x88 延续未结束
  assert.equal(parseDer(H("06028001")).diagnostics[0].code, "E_OID_NON_MINIMAL");
});

test("嵌套 SEQUENCE 与路径查询", () => {
  const r = parseDer(H("300a30030201010500020100"));
  assert.equal(r.ok, true);
  const inner = findNode(r.node!, "0");
  assert.equal(inner!.tagName, "SEQUENCE");
  assert.equal(findNode(r.node!, "0/0")!.value, 1);
  assert.equal(findNode(r.node!, "1")!.value, null);
  assert.equal(findNode(r.node!, "2")!.value, 0);
  assert.equal(findNode(r.node!, "9"), undefined);
});

test("合法输入重编码字节完全相同", () => {
  const cases = [
    "30080201010101ff0500", "02020100", "0201ff", "0500",
    "0481c8" + "ab".repeat(200), "0603883703", "0c06e4bda0e5a5bd",
    "030202f0", "300a30030201010500020100", "0101ff",
    "02090123456789abcdef00",
  ];
  for (const hex of cases) {
    const r = parseDer(H(hex));
    assert.equal(r.ok, true, hex);
    assert.equal(encodeNode(r.node!).toString("hex"), hex);
  }
});

test("嵌套深度上限", () => {
  let hex = "0500";
  for (let i = 0; i < MAX_DEPTH + 2; i++) {
    const len = hex.length / 2;
    hex = "30" + len.toString(16).padStart(2, "0") + hex;
  }
  assert.equal(parseDer(H(hex)).diagnostics[0].code, "E_DEPTH_LIMIT");
});

test("空输入", () => {
  assert.equal(parseDer(H("")).diagnostics[0].code, "E_EMPTY_INPUT");
});
