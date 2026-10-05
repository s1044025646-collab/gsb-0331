import { DerError, ErrorCode } from './errors.js';

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    out += b.toString(16).padStart(2, '0');
  }
  return out.toUpperCase();
}

export function fromHex(text: string): Uint8Array {
  const cleaned = text.replace(/\s+/g, '').replace(/^0x/i, '');
  if (cleaned.length === 0) {
    throw new DerError(ErrorCode.INVALID_HEX, '十六进制文本为空', 0);
  }
  if (cleaned.length % 2 !== 0) {
    throw new DerError(
      ErrorCode.INVALID_HEX,
      '十六进制文本长度必须为偶数',
      cleaned.length,
    );
  }
  const bytes = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < cleaned.length; i += 2) {
    const pair = cleaned.slice(i, i + 2);
    if (!/^[0-9a-fA-F]{2}$/.test(pair)) {
      throw new DerError(
        ErrorCode.INVALID_HEX,
        `非法十六进制字符: "${pair}"`,
        i,
      );
    }
    bytes[i / 2] = Number.parseInt(pair, 16);
  }
  return bytes;
}
