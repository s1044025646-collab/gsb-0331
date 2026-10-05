import { DerError, ErrorCode } from './errors.js';

export const MAX_SAFE_INT = BigInt(Number.MAX_SAFE_INTEGER);
export const MIN_SAFE_INT = BigInt(Number.MIN_SAFE_INTEGER);

export interface IntegerValue {
  bigint: bigint;
  decimal: string;
  withinSafeInteger: boolean;
}

export function decodeInteger(bytes: Uint8Array, valueOffset: number): IntegerValue {
  if (bytes.length === 0) {
    throw new DerError(ErrorCode.INTEGER_EMPTY, 'INTEGER 值不能为空', valueOffset);
  }
  if (bytes.length >= 2) {
    const first = bytes[0]!;
    const second = bytes[1]!;
    if (first === 0x00 && (second & 0x80) === 0) {
      throw new DerError(
        ErrorCode.INTEGER_NON_MINIMAL,
        'INTEGER 含不必要的前导 0x00',
        valueOffset,
      );
    }
    if (first === 0xff && (second & 0x80) !== 0) {
      throw new DerError(
        ErrorCode.INTEGER_NON_MINIMAL,
        'INTEGER 含不必要的前导 0xFF',
        valueOffset,
      );
    }
  }

  const negative = (bytes[0]! & 0x80) !== 0;
  let value = 0n;
  for (const b of bytes) {
    value = (value << 8n) | BigInt(b);
  }
  if (negative) {
    value -= 1n << BigInt(bytes.length * 8);
  }

  return {
    bigint: value,
    decimal: value.toString(),
    withinSafeInteger: value >= MIN_SAFE_INT && value <= MAX_SAFE_INT,
  };
}

export function encodeInteger(decimal: string): Uint8Array {
  let value: bigint;
  try {
    if (!/^[+-]?\d+$/.test(decimal.trim())) {
      throw new Error('bad');
    }
    value = BigInt(decimal.trim());
  } catch {
    throw new DerError(
      ErrorCode.INVALID_ARGUMENT,
      `无法解析为整数: ${decimal}`,
      0,
    );
  }

  if (value === 0n) {
    return Uint8Array.from([0x00]);
  }

  const byteCount = bigIntByteLength(value);
  const bytes = new Uint8Array(byteCount);
  let two = value;
  if (two < 0n) {
    two += 1n << BigInt(byteCount * 8);
  }
  for (let i = byteCount - 1; i >= 0; i--) {
    bytes[i] = Number(two & 0xffn);
    two >>= 8n;
  }
  return bytes;
}

function bigIntByteLength(value: bigint): number {
  const negative = value < 0n;
  let bits = 0;
  let v = negative ? ~value : value;
  while (v > 0n) {
    bits++;
    v >>= 1n;
  }
  const dataBits = negative ? bits + 1 : bits + 1;
  return Math.max(1, Math.ceil(dataBits / 8));
}
