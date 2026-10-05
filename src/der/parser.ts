import { DerError, ErrorCode, ParentRange } from './errors.js';
import { Limits, DEFAULT_LIMITS } from './limits.js';
import { Tag, TAG_NAMES, SUPPORTED_PRIMITIVE_TAGS } from './tags.js';
import { strictDecodeUtf8 } from './utf8.js';
import { decodeOid, OidDecodeResult } from './oid.js';
import { decodeInteger, IntegerValue } from './integer.js';

export interface IntegerInterpretation extends IntegerValue {
  kind: 'integer';
}
export interface BooleanInterpretation {
  kind: 'boolean';
  value: boolean;
}
export interface NullInterpretation {
  kind: 'null';
}
export interface OctetStringInterpretation {
  kind: 'octetString';
  hex: string;
  length: number;
}
export interface BitStringInterpretation {
  kind: 'bitString';
  unusedBits: number;
  dataHex: string;
  effectiveBitLength: number;
}
export interface OidInterpretation extends OidDecodeResult {
  kind: 'oid';
}
export interface Utf8Interpretation {
  kind: 'utf8';
  text: string;
}
export interface SequenceInterpretation {
  kind: 'sequence';
  childCount: number;
}

export type Interpretation =
  | BooleanInterpretation
  | IntegerInterpretation
  | BitStringInterpretation
  | OctetStringInterpretation
  | NullInterpretation
  | OidInterpretation
  | Utf8Interpretation
  | SequenceInterpretation;

export interface DerNode {
  tag: number;
  tagName: string;
  constructed: boolean;
  start: number;
  headerEnd: number;
  valueStart: number;
  end: number;
  valueLength: number;
  path: string;
  rawHex: string;
  valueHex: string;
  interpretation: Interpretation;
  children: DerNode[];
}

export interface ParseReport {
  subsetVersion: string;
  inputLength: number;
  inputHex: string;
  root: DerNode;
  rawLegal: boolean;
}

export function parseDer(input: Uint8Array, limits: Limits = DEFAULT_LIMITS): ParseReport {
  if (input.length === 0) {
    throw new DerError(ErrorCode.EMPTY_INPUT, '输入为空', 0);
  }
  if (input.length > limits.maxInputBytes) {
    throw new DerError(
      ErrorCode.INPUT_TOO_LARGE,
      `输入 ${input.length} 字节超过上限 ${limits.maxInputBytes}`,
      input.length,
    );
  }

  const root = parseNode(input, 0, input.length, 0, '', limits, null);
  if (root.end !== input.length) {
    throw new DerError(
      ErrorCode.TRAILING_BYTES,
      `顶层值之后存在 ${input.length - root.end} 个多余字节`,
      root.end,
    );
  }
  return {
    subsetVersion: 'der-subset-1',
    inputLength: input.length,
    inputHex: bytesToHex(input),
    root,
    rawLegal: true,
  };
}

function parseNode(
  input: Uint8Array,
  start: number,
  containerEnd: number,
  depth: number,
  path: string,
  limits: Limits,
  parent: ParentRange | null,
): DerNode {
  if (start >= containerEnd) {
    throw new DerError(ErrorCode.TRUNCATED, '期望标签但已到容器结尾', start, parent);
  }

  const tagByte = input[start]!;
  const classBits = tagByte & 0xc0;
  const constructed = (tagByte & 0x20) !== 0;
  const tagNumber = tagByte & 0x1f;

  if (classBits !== 0) {
    throw new DerError(
      ErrorCode.UNSUPPORTED_TAG,
      `仅支持通用类标签，收到类位 0x${classBits.toString(16)}`,
      start,
      parent,
    );
  }
  if (tagNumber === 0x1f) {
    throw new DerError(
      ErrorCode.UNSUPPORTED_TAG,
      '不支持多字节标签号（高标签号形式）',
      start,
      parent,
    );
  }
  if (!SUPPORTED_PRIMITIVE_TAGS.has(tagNumber) && tagNumber !== Tag.SEQUENCE) {
    throw new DerError(
      ErrorCode.UNSUPPORTED_TAG,
      `不支持的标签 0x${tagNumber.toString(16).padStart(2, '0')}`,
      start,
      parent,
    );
  }
  if (tagNumber === Tag.SEQUENCE && !constructed) {
    throw new DerError(
      ErrorCode.BAD_CONSTRUCTED_BIT,
      'SEQUENCE 必须为构造形式（构造位为 1）',
      start,
      parent,
    );
  }
  if (tagNumber !== Tag.SEQUENCE && constructed) {
    throw new DerError(
      ErrorCode.BAD_CONSTRUCTED_BIT,
      `${TAG_NAMES[tagNumber]} 在本子集中必须为原始形式（构造位为 0）`,
      start,
      parent,
    );
  }

  let cursor = start + 1;
  if (cursor >= containerEnd) {
    throw new DerError(ErrorCode.TRUNCATED, '缺少长度字节', cursor, parent);
  }
  const firstLengthByte = input[cursor]!;
  let valueLength: number;
  let headerEnd: number;

  if (firstLengthByte === 0x80) {
    throw new DerError(
      ErrorCode.INDEFINITE_LENGTH,
      '拒绝不定长度（BER）形式',
      cursor,
      parent,
    );
  }

  if ((firstLengthByte & 0x80) === 0) {
    valueLength = firstLengthByte;
    headerEnd = cursor + 1;
  } else {
    const numBytes = firstLengthByte & 0x7f;
    if (numBytes === 0x7f || numBytes > 6) {
      throw new DerError(
        ErrorCode.NON_MINIMAL_LENGTH,
        `长度字段字节数 ${numBytes} 不被支持`,
        cursor,
        parent,
      );
    }
    const lengthStart = cursor + 1;
    if (lengthStart + numBytes > containerEnd) {
      throw new DerError(
        ErrorCode.TRUNCATED,
        '长度字段被截断',
        lengthStart,
        parent,
      );
    }
    let decoded = 0;
    for (let i = 0; i < numBytes; i++) {
      decoded = decoded * 256 + input[lengthStart + i]!;
    }
    if (numBytes > 1 && input[lengthStart]! === 0x00) {
      throw new DerError(
        ErrorCode.NON_MINIMAL_LENGTH,
        '长长度编码使用了非最短形式（前导 0x00）',
        lengthStart,
        parent,
      );
    }
    valueLength = decoded;
    headerEnd = lengthStart + numBytes;
    if (valueLength < 0x80) {
      throw new DerError(
        ErrorCode.NON_MINIMAL_LENGTH,
        '长度 < 128 时必须使用短长度形式',
        cursor,
        parent,
      );
    }
  }

  const valueStart = headerEnd;
  const end = valueStart + valueLength;

  if (!Number.isSafeInteger(valueLength) || valueStart > containerEnd || end > containerEnd) {
    throw new DerError(
      ErrorCode.CHILD_EXCEEDS_CONTAINER,
      '值区越过容器或顶层输入边界',
      Math.min(valueStart, containerEnd),
      parent,
    );
  }

  const value = input.subarray(valueStart, end);
  const selfRange: ParentRange = { path, start, end };
  let interpretation: Interpretation = { kind: 'null' };
  const children: DerNode[] = [];

  switch (tagNumber) {
    case Tag.BOOLEAN: {
      if (valueLength !== 1) {
        throw new DerError(
          ErrorCode.BOOLEAN_BAD_LENGTH,
          `BOOLEAN 长度必须为 1，实际 ${valueLength}`,
          valueStart,
          selfRange,
        );
      }
      const b = value[0]!;
      if (b !== 0x00 && b !== 0xff) {
        throw new DerError(
          ErrorCode.BOOLEAN_BAD_VALUE,
          `BOOLEAN 真值必须为 FF，假值为 00，实际 0x${b
            .toString(16)
            .padStart(2, '0')}`,
          valueStart,
          selfRange,
        );
      }
      interpretation = { kind: 'boolean', value: b === 0xff };
      break;
    }
    case Tag.INTEGER: {
      interpretation = { kind: 'integer', ...decodeInteger(value, valueStart) };
      break;
    }
    case Tag.BIT_STRING: {
      if (valueLength === 0) {
        throw new DerError(
          ErrorCode.BITSTRING_EMPTY,
          'BIT STRING 值不能为空（至少需含未用位数字节）',
          valueStart,
          selfRange,
        );
      }
      const unusedBits = value[0]!;
      if (unusedBits > 7) {
        throw new DerError(
          ErrorCode.BITSTRING_UNUSED_BITS_RANGE,
          `未用位数必须在 0..7，实际 ${unusedBits}`,
          valueStart,
          selfRange,
        );
      }
      const dataLength = valueLength - 1;
      if (dataLength === 0 && unusedBits !== 0) {
        throw new DerError(
          ErrorCode.BITSTRING_UNUSED_BITS_SINGLE_ZERO,
          '空 BIT STRING 的未用位数必须为 0',
          valueStart,
          selfRange,
        );
      }
      if (dataLength > 0 && unusedBits > 0) {
        const last = value[valueLength - 1]!;
        const padMask = (1 << unusedBits) - 1;
        if ((last & padMask) !== 0) {
          throw new DerError(
            ErrorCode.BITSTRING_UNUSED_BITS_NONZERO,
            `末字节 ${unusedBits} 个填充位必须为 0`,
            valueStart + valueLength - 1,
            selfRange,
          );
        }
      }
      interpretation = {
        kind: 'bitString',
        unusedBits,
        dataHex: bytesToHex(value.subarray(1)),
        effectiveBitLength: dataLength * 8 - unusedBits,
      };
      break;
    }
    case Tag.OCTET_STRING: {
      interpretation = { kind: 'octetString', hex: bytesToHex(value), length: valueLength };
      break;
    }
    case Tag.NULL_: {
      if (valueLength !== 0) {
        throw new DerError(
          ErrorCode.NULL_BAD_LENGTH,
          `NULL 长度必须为 0，实际 ${valueLength}`,
          valueStart,
          selfRange,
        );
      }
      interpretation = { kind: 'null' };
      break;
    }
    case Tag.OBJECT_IDENTIFIER: {
      interpretation = { kind: 'oid', ...decodeOid(value, valueStart) };
      break;
    }
    case Tag.UTF8_STRING: {
      interpretation = { kind: 'utf8', text: strictDecodeUtf8(value, valueStart) };
      break;
    }
    case Tag.SEQUENCE: {
      let childCursor = valueStart;
      let index = 0;
      while (childCursor < end) {
        if (depth + 1 > limits.maxDepth) {
          throw new DerError(
            ErrorCode.NESTING_TOO_DEEP,
            `嵌套深度超过上限 ${limits.maxDepth}`,
            childCursor,
            selfRange,
          );
        }
        const child = parseNode(
          input,
          childCursor,
          end,
          depth + 1,
          `${path}/${index}`,
          limits,
          selfRange,
        );
        children.push(child);
        childCursor = child.end;
        index++;
      }
      if (childCursor !== end) {
        throw new DerError(
          ErrorCode.CONTAINER_NOT_FULLY_OCCUPIED,
          'SEQUENCE 值区未被子节点完整占满',
          childCursor,
          selfRange,
        );
      }
      interpretation = { kind: 'sequence', childCount: children.length };
      break;
    }
  }

  return {
    tag: tagNumber,
    tagName: TAG_NAMES[tagNumber]!,
    constructed,
    start,
    headerEnd,
    valueStart,
    end,
    valueLength,
    path: path === '' ? '/' : path,
    rawHex: bytesToHex(input.subarray(start, end)),
    valueHex: bytesToHex(value),
    interpretation,
    children,
  };
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    out += b.toString(16).padStart(2, '0');
  }
  return out.toUpperCase();
}
