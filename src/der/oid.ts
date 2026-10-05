import { DerError, ErrorCode } from './errors.js';

export interface OidDecodeResult {
  arcs: bigint[];
  dotted: string;
}

export function decodeOid(bytes: Uint8Array, valueOffset: number): OidDecodeResult {
  if (bytes.length === 0) {
    throw new DerError(ErrorCode.OID_EMPTY, 'OBJECT IDENTIFIER 值不能为空', valueOffset);
  }

  const combined: bigint[] = [];
  let current = 0n;
  let usedBits = 0;
  let componentStart = 0;
  let sawContinuation = false;

  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    sawContinuation = (b & 0x80) !== 0;

    if (i === componentStart) {
      if (b === 0x80) {
        throw new DerError(
          ErrorCode.OID_NON_MINIMAL,
          'OBJECT IDENTIFIER 分量使用了非最短表示（前导 0x80）',
          valueOffset + i,
        );
      }
      usedBits = 7;
    } else {
      usedBits += 7;
      if (usedBits > 130) {
        throw new DerError(
          ErrorCode.OID_NON_MINIMAL,
          'OBJECT IDENTIFIER 分量过长',
          valueOffset + i,
        );
      }
    }

    current = (current << 7n) | BigInt(b & 0x7f);

    if (!sawContinuation) {
      combined.push(current);
      current = 0n;
      componentStart = i + 1;
    }
  }

  if (sawContinuation) {
    throw new DerError(
      ErrorCode.OID_UNTERMINATED,
      'OBJECT IDENTIFIER 最后一个分量未正常结束',
      valueOffset + bytes.length,
    );
  }

  const first = combined[0]!;
  let arc1: bigint;
  let arc2: bigint;
  if (first < 40n) {
    arc1 = 0n;
    arc2 = first;
  } else if (first < 80n) {
    arc1 = 1n;
    arc2 = first - 40n;
  } else {
    arc1 = 2n;
    arc2 = first - 80n;
  }

  const arcs = [arc1, arc2, ...combined.slice(1)];
  return { arcs, dotted: arcs.map((a) => a.toString()).join('.') };
}

export function encodeOid(dotted: string): Uint8Array {
  const parts = dotted.split('.');
  if (parts.length < 2) {
    throw new DerError(
      ErrorCode.OID_ENCODE_INVALID,
      'OID 至少需要两个弧',
      0,
    );
  }
  const arcs: bigint[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) {
      throw new DerError(ErrorCode.OID_ENCODE_INVALID, `OID 弧非法: ${p}`, 0);
    }
    arcs.push(BigInt(p));
  }
  const first = arcs[0]!;
  const second = arcs[1]!;
  if (first > 2n) {
    throw new DerError(ErrorCode.OID_FIRST_COMPONENT, 'OID 第一弧只能为 0、1、2', 0);
  }
  if (first < 2n && second >= 40n) {
    throw new DerError(
      ErrorCode.OID_FIRST_COMPONENT,
      'OID 前两弧的合并值不合法',
      0,
    );
  }

  const combinedValues = [first * 40n + second, ...arcs.slice(2)];
  const out: number[] = [];
  for (const value of combinedValues) {
    if (value < 0n) {
      throw new DerError(ErrorCode.OID_ENCODE_INVALID, 'OID 弧不能为负', 0);
    }
    const chunks: number[] = [];
    let v = value;
    do {
      chunks.unshift(Number(v & 0x7fn));
      v >>= 7n;
    } while (v > 0n);
    for (let i = 0; i < chunks.length; i++) {
      const last = i === chunks.length - 1;
      out.push(chunks[i]! | (last ? 0x00 : 0x80));
    }
  }
  return Uint8Array.from(out);
}
