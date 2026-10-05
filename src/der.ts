export const SUBSET_VERSION = "der-subset-1.0";

export const MAX_TOTAL_BYTES = 1024 * 1024;
export const MAX_DEPTH = 32;
export const MAX_LENGTH_OCTETS = 4;

export type TagName =
  | "BOOLEAN" | "INTEGER" | "BIT STRING" | "OCTET STRING"
  | "NULL" | "OBJECT IDENTIFIER" | "UTF8String" | "SEQUENCE";

export const TAGS: Record<number, { name: TagName; constructed: boolean }> = {
  0x01: { name: "BOOLEAN", constructed: false },
  0x02: { name: "INTEGER", constructed: false },
  0x03: { name: "BIT STRING", constructed: false },
  0x04: { name: "OCTET STRING", constructed: false },
  0x05: { name: "NULL", constructed: false },
  0x06: { name: "OBJECT IDENTIFIER", constructed: false },
  0x0c: { name: "UTF8String", constructed: false },
  0x10: { name: "SEQUENCE", constructed: true },
};

export interface Diagnostic {
  code: string;
  offset: number;
  message: string;
  parentStart?: number;
  parentEnd?: number;
  length?: number;
}

export class DerError extends Error {
  diag: Diagnostic;
  constructor(diag: Diagnostic) {
    super(diag.message);
    this.diag = diag;
  }
}

function fail(code: string, offset: number, message: string, extra?: Partial<Diagnostic>): never {
  throw new DerError({ code, offset, message, ...extra });
}

export interface DerNode {
  tag: number;
  tagName: TagName;
  offset: number;       // 标签起始偏移
  headerLength: number; // 标签+长度字节数
  length: number;       // 内容长度
  contentOffset: number;
  end: number;          // 节点结束偏移(不含)
  value?: unknown;      // 按类型解释的值
  children?: DerNode[];
}

export interface ParseResult {
  ok: boolean;
  node?: DerNode;
  diagnostics: Diagnostic[];
}

function parseLength(buf: Buffer, pos: number, end: number, nodeOffset: number): { length: number; next: number } {
  if (pos >= end) fail("E_TRUNCATED", pos, "长度字节缺失(截断)");
  const first = buf[pos];
  if (first === 0x80) fail("E_INDEFINITE_LENGTH", pos, "DER 不允许不定长度(0x80)");
  if (first < 0x80) return { length: first, next: pos + 1 };
  const numOctets = first & 0x7f;
  if (numOctets === 0) fail("E_INDEFINITE_LENGTH", pos, "非法长度形式");
  if (numOctets > MAX_LENGTH_OCTETS) fail("E_LENGTH_OVERFLOW", pos, `长度字段过长: ${numOctets} 字节(上限 ${MAX_LENGTH_OCTETS})`);
  if (pos + 1 + numOctets > end) fail("E_TRUNCATED", pos, "长长度字段被截断");
  if (buf[pos + 1] === 0x00) fail("E_NON_MINIMAL_LENGTH", pos + 1, "长度字段存在前导 0x00,非最短编码");
  let length = 0;
  for (let i = 0; i < numOctets; i++) length = length * 256 + buf[pos + 1 + i];
  if (length < 128) fail("E_NON_MINIMAL_LENGTH", pos, `长度 ${length} 应使用短形式编码`);
  if (length > MAX_TOTAL_BYTES) fail("E_SIZE_LIMIT", pos, `声明长度 ${length} 超过大小上限`);
  return { length, next: pos + 1 + numOctets };
}

function parseInteger(content: Buffer, off: number): bigint | number {
  let v = 0n;
  for (const b of content) v = (v << 8n) | BigInt(b);
  if (content[0] & 0x80) v -= 1n << BigInt(content.length * 8);
  if (v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER)) return Number(v);
  return v; // 返回 BigInt,序列化时转十进制字符串
}

function parseOid(content: Buffer, base: number): string {
  const arcs: bigint[] = [];
  let i = 0;
  while (i < content.length) {
    let v = 0n;
    let done = false;
    const start = i;
    while (i < content.length) {
      const b = content[i];
      if (i === start && b === 0x80) fail("E_OID_NON_MINIMAL", base + i, "OID 分量存在非最短表示(前导 0x80)");
      v = (v << 7n) | BigInt(b & 0x7f);
      i++;
      if ((b & 0x80) === 0) { done = true; break; }
    }
    if (!done) fail("E_OID_TRUNCATED", base + start, "OID 分量未结束(延续位未清零)");
    arcs.push(v);
  }
  if (arcs.length === 0) fail("E_OID_EMPTY", base, "OID 内容为空");
  const first = arcs[0];
  let a0: bigint, a1: bigint;
  if (first < 40n) { a0 = 0n; a1 = first; }
  else if (first < 80n) { a0 = 1n; a1 = first - 40n; }
  else { a0 = 2n; a1 = first - 80n; }
  const rest = arcs.slice(1);
  return [a0, a1, ...rest].join(".");
}

function parseNode(buf: Buffer, offset: number, end: number, depth: number, parent?: { start: number; end: number }): DerNode {
  if (depth > MAX_DEPTH) fail("E_DEPTH_LIMIT", offset, `嵌套深度超过上限 ${MAX_DEPTH}`);
  if (offset >= end) fail("E_TRUNCATED", offset, "期望子节点但已到容器末尾", parent ? { parentStart: parent.start, parentEnd: parent.end } : {});
  const tagByte = buf[offset];
  const cls = tagByte & 0xc0;
  const tagNum = tagByte & 0x1f;
  const constructed = (tagByte & 0x20) !== 0;
  if (cls !== 0) fail("E_UNSUPPORTED_TAG", offset, `仅支持通用类标签,收到类别位 0x${cls.toString(16)}`);
  if (tagNum === 0x1f) fail("E_UNSUPPORTED_TAG", offset, "不支持多字节(高标签号)编码");
  // 构造位与类型匹配检查
  const primSpec = TAGS[tagNum];
  if (!primSpec) fail("E_UNSUPPORTED_TAG", offset, `不支持的通用标签号 ${tagNum}`);
  if (primSpec.constructed !== constructed) {
    fail("E_BAD_CONSTRUCTED", offset, `${primSpec.name} 的构造位错误(期望 ${primSpec.constructed ? "构造" : "原始"})`);
  }
  const { length, next } = parseLength(buf, offset + 1, end, offset);
  const contentOffset = next;
  const nodeEnd = contentOffset + length;
  if (nodeEnd > end) {
    fail("E_CONTENT_OVERRUN", offset, `内容越界: 需要到偏移 ${nodeEnd},但边界为 ${end}`,
      parent ? { parentStart: parent.start, parentEnd: parent.end, length } : { length });
  }
  const content = buf.subarray(contentOffset, nodeEnd);
  const node: DerNode = {
    tag: tagByte, tagName: primSpec.name, offset,
    headerLength: contentOffset - offset, length, contentOffset, end: nodeEnd,
  };
  switch (primSpec.name) {
    case "BOOLEAN": {
      if (length !== 1) fail("E_BOOLEAN_LENGTH", offset, `BOOLEAN 长度必须为 1,实际 ${length}`, { length });
      const b = content[0];
      if (b !== 0x00 && b !== 0xff) fail("E_BOOLEAN_NONCANONICAL", contentOffset, `BOOLEAN 真值必须为 0xFF,实际 0x${b.toString(16).padStart(2, "0")}`);
      node.value = b === 0xff;
      break;
    }
    case "INTEGER": {
      if (length === 0) fail("E_INTEGER_EMPTY", offset, "INTEGER 内容为空");
      if (length > 1) {
        if (content[0] === 0x00 && content[1] < 0x80) fail("E_INTEGER_NON_MINIMAL", contentOffset, "INTEGER 存在不必要的前导 0x00");
        if (content[0] === 0xff && content[1] >= 0x80) fail("E_INTEGER_NON_MINIMAL", contentOffset, "INTEGER 存在不必要的前导 0xFF");
      }
      const v = parseInteger(content, contentOffset);
      node.value = typeof v === "bigint" ? v.toString(10) : v;
      break;
    }
    case "BIT STRING": {
      if (length === 0) fail("E_BITSTRING_EMPTY", offset, "BIT STRING 内容为空(缺少未用位计数字节)");
      const unused = content[0];
      if (unused > 7) fail("E_BITSTRING_UNUSED_RANGE", contentOffset, `未用位数 ${unused} 超出 0-7 范围`);
      if (length === 1 && unused !== 0) fail("E_BITSTRING_UNUSED_RANGE", contentOffset, "空位串的未用位数必须为 0");
      if (unused > 0) {
        const last = content[content.length - 1];
        const mask = (1 << unused) - 1;
        if ((last & mask) !== 0) fail("E_BITSTRING_PADDING", nodeEnd - 1, `末字节低 ${unused} 个填充位必须为 0`);
      }
      node.value = { unusedBits: unused, bits: content.subarray(1).toString("hex") };
      break;
    }
    case "OCTET STRING":
      node.value = content.toString("hex");
      break;
    case "NULL":
      if (length !== 0) fail("E_NULL_LENGTH", offset, `NULL 长度必须为 0,实际 ${length}`, { length });
      node.value = null;
      break;
    case "UTF8String": {
      const dec = new TextDecoder("utf-8", { fatal: true });
      try {
        node.value = dec.decode(content);
      } catch {
        fail("E_UTF8_INVALID", contentOffset, "UTF8String 包含损坏的 UTF-8 序列");
      }
      break;
    }
    case "OBJECT IDENTIFIER":
      node.value = parseOid(content, contentOffset);
      break;
    case "SEQUENCE": {
      const children: DerNode[] = [];
      let pos = contentOffset;
      while (pos < nodeEnd) {
        const child = parseNode(buf, pos, nodeEnd, depth + 1, { start: offset, end: nodeEnd });
        children.push(child);
        pos = child.end;
      }
      node.children = children;
      break;
    }
  }
  return node;
}

export function parseDer(buf: Buffer): ParseResult {
  try {
    if (buf.length === 0) fail("E_EMPTY_INPUT", 0, "输入为空");
    if (buf.length > MAX_TOTAL_BYTES) fail("E_SIZE_LIMIT", 0, `输入 ${buf.length} 字节超过上限 ${MAX_TOTAL_BYTES}`);
    const node = parseNode(buf, 0, buf.length, 0);
    if (node.end !== buf.length) {
      fail("E_TRAILING_BYTES", node.end, `顶层值结束后仍有 ${buf.length - node.end} 个多余字节`);
    }
    return { ok: true, node, diagnostics: [] };
  } catch (e) {
    if (e instanceof DerError) return { ok: false, diagnostics: [e.diag] };
    throw e;
  }
}

// ---------- 规范编码 ----------

function encodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  let n = length;
  while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function encodeOidArc(v: bigint): number[] {
  const out: number[] = [];
  let n = v;
  out.unshift(Number(n & 0x7fn));
  n >>= 7n;
  while (n > 0n) { out.unshift(0x80 | Number(n & 0x7fn)); n >>= 7n; }
  return out;
}

export function encodeNode(node: DerNode): Buffer {
  const tag = Buffer.from([node.tag]);
  let content: Buffer;
  switch (node.tagName) {
    case "BOOLEAN": content = Buffer.from([node.value ? 0xff : 0x00]); break;
    case "NULL": content = Buffer.alloc(0); break;
    case "INTEGER": {
      let v = BigInt(node.value as string | number);
      const bytes: number[] = [];
      if (v === 0n) bytes.push(0);
      else {
        const neg = v < 0n;
        while (neg ? v !== -1n : v !== 0n) { bytes.unshift(Number(v & 0xffn)); v >>= 8n; }
        if (!neg && (bytes[0] & 0x80)) bytes.unshift(0);
        if (neg && !(bytes[0] & 0x80)) bytes.unshift(0xff);
      }
      content = Buffer.from(bytes);
      break;
    }
    case "BIT STRING": {
      const bv = node.value as { unusedBits: number; bits: string };
      content = Buffer.concat([Buffer.from([bv.unusedBits]), Buffer.from(bv.bits, "hex")]);
      break;
    }
    case "OCTET STRING": content = Buffer.from(node.value as string, "hex"); break;
    case "UTF8String": content = Buffer.from(node.value as string, "utf8"); break;
    case "OBJECT IDENTIFIER": {
      const arcs = (node.value as string).split(".").map((s) => BigInt(s));
      if (arcs.length < 2) fail("E_OID_ENCODE", node.offset, "OID 至少需要两段");
      const first = arcs[0] * 40n + arcs[1];
      const bytes: number[] = [...encodeOidArc(first)];
      for (const a of arcs.slice(2)) bytes.push(...encodeOidArc(a));
      content = Buffer.from(bytes);
      break;
    }
    case "SEQUENCE":
      content = Buffer.concat((node.children ?? []).map(encodeNode));
      break;
  }
  return Buffer.concat([tag, encodeLength(content.length), content]);
}

// ---------- 节点路径查询 ----------

export function findNode(root: DerNode, path: string): DerNode | undefined {
  if (path === "" || path === "/") return root;
  const parts = path.replace(/^\//, "").split("/");
  let cur: DerNode | undefined = root;
  for (const p of parts) {
    if (!cur || !cur.children) return undefined;
    const idx = Number(p);
    if (!Number.isInteger(idx) || idx < 0 || idx >= cur.children.length) return undefined;
    cur = cur.children[idx];
  }
  return cur;
}

export function formatTree(node: DerNode, indent = 0): string {
  const pad = "  ".repeat(indent);
  let val = "";
  if (node.tagName === "SEQUENCE") val = `children=${node.children!.length}`;
  else if (node.tagName === "BIT STRING") {
    const bv = node.value as { unusedBits: number; bits: string };
    val = `unused=${bv.unusedBits} bits=${bv.bits}`;
  } else if (node.tagName === "OCTET STRING") {
    const hex = node.value as string;
    val = hex.length > 64 ? hex.slice(0, 64) + `…(${hex.length / 2}字节)` : hex;
  } else val = JSON.stringify(node.value);
  const head = `${pad}[${node.offset}] ${node.tagName} len=${node.length} (头${node.headerLength}B 内容@${node.contentOffset}-${node.end}) ${val}`;
  const kids = (node.children ?? []).map((c) => formatTree(c, indent + 1));
  return [head, ...kids].join("\n");
}
