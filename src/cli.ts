#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DerService } from './service.js';
import { fromHex } from './der/hex.js';
import { bytesToHex } from './der/parser.js';
import { createApp, listenOnFreePort } from './server.js';
import { renderTree, valueSummary } from './render.js';
import { DerError, ErrorCode } from './der/errors.js';

const DATA_DIR = process.env.DER_DATA_DIR
  ? resolve(process.env.DER_DATA_DIR)
  : resolve(process.cwd(), 'data');
const DB_PATH = resolve(DATA_DIR, 'der.db');

function service(): DerService {
  return new DerService(DB_PATH);
}

async function readInput(args: Map<string, string>, positionals: string[]): Promise<{
  name: string;
  bytes: Uint8Array;
}> {
  const name = args.get('name') ?? 'input.der';
  const hex = args.get('hex');
  if (hex !== undefined) {
    return { name, bytes: fromHex(hex) };
  }
  const file = args.get('file') ?? positionals[0];
  if (!file) {
    throw new DerError(
      ErrorCode.INVALID_ARGUMENT,
      '需要 --hex "<十六进制>" 或 --file <路径>（也可直接给文件位置参数）',
      0,
    );
  }
  return { name, bytes: new Uint8Array(await readFile(resolve(file))) };
}

function printFailure(failure: {
  code: string;
  message: string;
  offset: number;
  parent: unknown;
}): void {
  process.stdout.write(`解析失败 [${failure.code}] @偏移 ${failure.offset}\n  ${failure.message}\n`);
  if (failure.parent) {
    process.stdout.write(`  父节点范围: ${JSON.stringify(failure.parent)}\n`);
  }
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0] ?? 'help';
  const rest = argv.slice(1);
  const { args, positionals } = parseArgs(rest);
  const svc = service();

  try {
    switch (command) {
      case 'import': {
        const input = await readInput(args, positionals);
        const result = svc.importBytes(input.name, input.bytes);
        process.stdout.write(
          `记录 #${result.id}  版本 v${result.version}  sha256=${result.sha256}\n`,
        );
        if (result.status === 'success' && result.report) {
          process.stdout.write(`${renderTree(result.report.root)}\n`);
          process.stdout.write(
            `\n原字节合法: 是；重编码规范: 是；重编码与原字节一致: ${
              result.reencodedMatchesRaw ? '是' : '否'
            }\n`,
          );
        } else if (result.error) {
          printFailure(result.error);
          process.stdout.write('（已作为失败诊断记录，不登记成功树）\n');
        }
        return 0;
      }
      case 'list': {
        for (const entry of svc.list()) {
          process.stdout.write(
            `#${String(entry.id).padStart(4)}  ${entry.status.padEnd(7)}  v?  ${
              entry.subsetVersion
            }  ${entry.name}  ${entry.sha256.slice(0, 12)}\n`,
          );
        }
        return 0;
      }
      case 'show': {
        const entry = svc.get(Number(args.get('id') ?? positionals[0]));
        if (!entry) {
          process.stdout.write('记录不存在\n');
          return 2;
        }
        process.stdout.write(
          `#${entry.id} 版本 v${entry.version} ${entry.status} ${entry.name}\n`,
        );
        if (entry.report) {
          process.stdout.write(`${renderTree(entry.report.root)}\n`);
        } else if (entry.error) {
          printFailure(entry.error);
        }
        return 0;
      }
      case 'node': {
        const id = Number(args.get('id') ?? positionals[0]);
        const path = args.get('path') ?? positionals[1] ?? '/';
        const node = svc.getNode(id, path);
        if (!node) {
          process.stdout.write(`节点路径不存在: ${path}\n`);
          return 2;
        }
        process.stdout.write(
          `${node.tagName} path=${node.path} [${node.start}-${node.end}) len=${node.valueLength}\n`,
        );
        process.stdout.write(`值解释: ${valueSummary(node)}\n`);
        process.stdout.write(`原始 TLV: ${node.rawHex}\n`);
        return 0;
      }
      case 'encode': {
        const id = Number(args.get('id') ?? positionals[0]);
        const entry = svc.get(id);
        if (!entry?.report) {
          process.stdout.write('找不到成功解析记录\n');
          return 2;
        }
        process.stdout.write(`规范重编码: ${entry.reencodedHex}\n`);
        process.stdout.write(`与原字节一致: ${entry.reencodedMatchesRaw ? '是' : '否'}\n`);
        return 0;
      }
      case 'compare': {
        const id = Number(args.get('id') ?? positionals[0]);
        const entry = svc.get(id);
        if (!entry) {
          process.stdout.write('记录不存在\n');
          return 2;
        }
        const raw = svc.getRaw(id);
        if (!raw || !entry.report) {
          process.stdout.write('失败记录无法进行成功树比较\n');
          return 2;
        }
        const same = bytesToHex(raw.bytes) === entry.reencodedHex;
        process.stdout.write(
          `原始字节 : ${bytesToHex(raw.bytes)}\n重编码   : ${entry.reencodedHex}\n逐字节一致: ${
            same ? '是' : '否'
          }\n`,
        );
        return same ? 0 : 1;
      }
      case 'export': {
        const id = Number(args.get('id') ?? positionals[0]);
        const out = args.get('out') ?? positionals[1];
        const raw = svc.getRaw(id);
        if (!raw) {
          process.stdout.write('记录不存在\n');
          return 2;
        }
        const target = out ?? `${raw.name}.der`;
        await writeFile(resolve(target), raw.bytes);
        process.stdout.write(`已导出 ${raw.bytes.length} 字节到 ${target}\n`);
        return 0;
      }
      case 'serve': {
        const preferred = Number(process.env.PORT ?? args.get('port') ?? 0);
        const app = createApp(svc);
        const port = await listenOnFreePort(app, Number.isFinite(preferred) ? preferred : 0);
        process.stdout.write(
          `ASN.1 DER 核验服务已启动: http://127.0.0.1:${port}  (数据目录 ${DATA_DIR})\n`,
        );
        await new Promise<void>(() => undefined);
        return 0;
      }
      case 'help':
      case '--help':
      case '-h': {
        process.stdout.write(USAGE);
        return 0;
      }
      default:
        process.stdout.write(`未知命令: ${command}\n\n${USAGE}`);
        return 2;
    }
  } catch (err) {
    if (err instanceof DerError) {
      process.stdout.write(`错误 [${err.code}] @${err.offset}: ${err.message}\n`);
      return 1;
    }
    throw err;
  } finally {
    svc.close();
  }
}

function parseArgs(tokens: string[]): {
  args: Map<string, string>;
  positionals: string[];
} {
  const args = new Map<string, string>();
  const positionals: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args.set(key, next);
        i++;
      } else {
        args.set(key, 'true');
      }
    } else {
      positionals.push(token);
    }
  }
  return { args, positionals };
}

const USAGE = `dercheck - 离线 ASN.1 DER 子集核验（API + CLI）

用法:
  dercheck import (--hex "3003020105" | --file path.der) [--name n]
  dercheck list
  dercheck show  <id>
  dercheck node  <id> [--path /0/1]
  dercheck encode <id>
  dercheck compare <id>
  dercheck export <id> [--out out.der]
  dercheck serve [--port 0]

环境变量:
  PORT           服务端口（默认 0 = 自动选择空闲端口）
  DER_DATA_DIR   数据目录（默认 ./data，SQLite 存于其中）
`;

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  },
);
