import { DerError, ErrorCode } from './errors.js';

export function strictDecodeUtf8(bytes: Uint8Array, valueOffset: number): string {
  let result = '';
  let i = 0;

  while (i < bytes.length) {
    const b0 = bytes[i]!;
    let code: number;
    let extra: number;

    if (b0 <= 0x7f) {
      code = b0;
      extra = 0;
    } else if ((b0 & 0xe0) === 0xc0) {
      code = b0 & 0x1f;
      extra = 1;
      if (b0 < 0xc2) {
        throw new DerError(
          ErrorCode.UTF8_INVALID,
          '非法 UTF-8：过长 2 字节序列',
          valueOffset + i,
        );
      }
    } else if ((b0 & 0xf0) === 0xe0) {
      code = b0 & 0x0f;
      extra = 2;
    } else if ((b0 & 0xf8) === 0xf0) {
      code = b0 & 0x07;
      extra = 3;
      if (b0 > 0xf4) {
        throw new DerError(
          ErrorCode.UTF8_INVALID,
          '非法 UTF-8：码点超出范围',
          valueOffset + i,
        );
      }
    } else {
      throw new DerError(
        ErrorCode.UTF8_INVALID,
        `非法 UTF-8 前导字节 0x${b0.toString(16)}`,
        valueOffset + i,
      );
    }

    if (i + extra >= bytes.length) {
      throw new DerError(
        ErrorCode.UTF8_INVALID,
        '非法 UTF-8：序列被截断',
        valueOffset + i,
      );
    }

    for (let j = 1; j <= extra; j++) {
      const c = bytes[i + j]!;
      if ((c & 0xc0) !== 0x80) {
        throw new DerError(
          ErrorCode.UTF8_INVALID,
          `非法 UTF-8 后续字节 0x${c.toString(16)}`,
          valueOffset + i + j,
        );
      }
      code = (code << 6) | (c & 0x3f);
    }

    if (extra === 2 && code >= 0xd800 && code <= 0xdfff) {
      throw new DerError(
        ErrorCode.UTF8_INVALID,
        '非法 UTF-8：孤立代理项',
        valueOffset + i,
      );
    }
    if (code > 0x10ffff) {
      throw new DerError(
        ErrorCode.UTF8_INVALID,
        '非法 UTF-8：码点超出 U+10FFFF',
        valueOffset + i,
      );
    }

    if (code <= 0xffff) {
      result += String.fromCharCode(code);
    } else {
      const adjusted = code - 0x10000;
      result += String.fromCharCode(
        0xd800 + (adjusted >> 10),
        0xdc00 + (adjusted & 0x3ff),
      );
    }
    i += extra + 1;
  }

  return result;
}
