import { DerNode } from './parser.js';
import { Tag } from './tags.js';
import { bytesToHex } from './parser.js';
import { DerError, ErrorCode } from './errors.js';
import { encodeInteger } from './integer.js';
import { encodeOid } from './oid.js';

export interface EncodeResult {
  bytes: Uint8Array;
  hex: string;
  canonical: boolean;
}

export function encodeNode(node: DerNode): EncodeResult {
  const bytes = encodeNodeRaw(node);
  const hex = bytesToHex(bytes);
  return { bytes, hex, canonical: true };
}

function encodeNodeRaw(node: DerNode): Uint8Array {
  let content: Uint8Array;
  switch (node.tag) {
    case Tag.BOOLEAN:
      content = Uint8Array.from([node.interpretation.kind === 'boolean' && node.interpretation.value ? 0xff : 0x00]);
      break;
    case Tag.INTEGER: {
      if (node.interpretation.kind !== 'integer') {
        throw new DerError(ErrorCode.INVALID_ARGUMENT, '节点解释类型不匹配', node.start);
      }
      content = encodeInteger(node.interpretation.decimal);
      break;
    }
    case Tag.NULL_:
      content = new Uint8Array(0);
      break;
    case Tag.OCTET_STRING:
      if (node.interpretation.kind !== 'octetString') {
        throw new DerError(ErrorCode.INVALID_ARGUMENT, '节点解释类型不匹配', node.start);
      }
      content = hexToBytes(node.interpretation.hex);
      break;
    case Tag.BIT_STRING: {
      if (node.interpretation.kind !== 'bitString') {
        throw new DerError(ErrorCode.INVALID_ARGUMENT, '节点解释类型不匹配', node.start);
      }
      const data = hexToBytes(node.interpretation.dataHex);
      content = concat([Uint8Array.from([node.interpretation.unusedBits]), data]);
      break;
    }
    case Tag.OBJECT_IDENTIFIER:
      if (node.interpretation.kind !== 'oid') {
        throw new DerError(ErrorCode.INVALID_ARGUMENT, '节点解释类型不匹配', node.start);
      }
      content = encodeOid(node.interpretation.dotted);
      break;
    case Tag.UTF8_STRING:
      if (node.interpretation.kind !== 'utf8') {
        throw new DerError(ErrorCode.INVALID_ARGUMENT, '节点解释类型不匹配', node.start);
      }
      content = new TextEncoder().encode(node.interpretation.text);
      break;
    case Tag.SEQUENCE:
      content = concat(node.children.map(encodeNodeRaw));
      break;
    default:
      throw new DerError(
        ErrorCode.UNSUPPORTED_TAG,
        `不支持重编码的标签 0x${node.tag.toString(16)}`,
        node.start,
      );
  }

  const tagByte = node.tag === Tag.SEQUENCE ? Tag.SEQUENCE | 0x20 : node.tag;
  return concat([Uint8Array.from([tagByte]), encodeLength(content.length), content]);
}

function encodeLength(length: number): Uint8Array {
  if (length < 0x80) {
    return Uint8Array.from([length]);
  }
  const bytes: number[] = [];
  let v = length;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return Uint8Array.from([0x80 | bytes.length, ...bytes]);
}

export function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) {
    total += p.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.replace(/\s+/g, '');
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
