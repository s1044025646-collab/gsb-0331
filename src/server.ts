import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { DerService } from './service.js';
import { fromHex } from './der/hex.js';
import { DerError, ErrorCode } from './der/errors.js';
import { toJson } from './der/json.js';

export interface ApiError {
  error: {
    code: string;
    message: string;
    offset?: number;
    parent?: unknown;
  };
}

export function createApp(service: DerService): Server {
  return createServer((req, res) => {
    void handleRequest(req, res, service);
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  service: DerService,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (method === 'GET' && path === '/health') {
      return sendJson(res, 200, { status: 'ok' });
    }

    if (method === 'GET' && path === '/api/inputs') {
      return sendJson(res, 200, { entries: service.list() });
    }

    if (method === 'POST' && path === '/api/inputs') {
      const body = await readJson(req);
      const { name, bytes } = await extractInput(body);
      return sendJson(res, 201, service.importBytes(name, bytes));
    }

    const reportMatch = path.match(/^\/api\/inputs\/(\d+)\/report$/);
    if (method === 'GET' && reportMatch) {
      const entry = service.get(Number(reportMatch[1]));
      if (!entry) {
        return sendJson(res, 404, errorBody(ErrorCode.NOT_FOUND, '记录不存在', 0));
      }
      return sendJson(res, 200, entry);
    }

    const nodeMatch = path.match(/^\/api\/inputs\/(\d+)\/node$/);
    if (method === 'GET' && nodeMatch) {
      const id = Number(nodeMatch[1]);
      const nodePath = url.searchParams.get('path') ?? '/';
      const node = service.getNode(id, nodePath);
      if (!node) {
        return sendJson(
          res,
          404,
          errorBody(ErrorCode.PATH_NOT_FOUND, `节点路径不存在: ${nodePath}`, 0),
        );
      }
      return sendJson(res, 200, { node });
    }

    const rawMatch = path.match(/^\/api\/inputs\/(\d+)\/raw$/);
    if (method === 'GET' && rawMatch) {
      const raw = service.getRaw(Number(rawMatch[1]));
      if (!raw) {
        return sendJson(res, 404, errorBody(ErrorCode.NOT_FOUND, '记录不存在', 0));
      }
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader(
        'content-disposition',
        `attachment; filename="${encodeURIComponent(raw.name)}.der"`,
      );
      res.end(Buffer.from(raw.bytes));
      return;
    }

    const reencodeMatch = path.match(/^\/api\/inputs\/(\d+)\/reencode$/);
    if (method === 'POST' && reencodeMatch) {
      const entry = service.get(Number(reencodeMatch[1]));
      if (!entry) {
        return sendJson(res, 404, errorBody(ErrorCode.NOT_FOUND, '记录不存在', 0));
      }
      if (!entry.report) {
        return sendJson(
          res,
          409,
          errorBody(
            entry.error?.code ?? ErrorCode.INVALID_ARGUMENT,
            '失败记录无成功节点树可供重编码',
            entry.error?.offset ?? 0,
            entry.error?.parent ?? null,
          ),
        );
      }
      return sendJson(res, 200, {
        reencodedHex: entry.reencodedHex,
        canonical: entry.reencodedCanonical,
        matchesRaw: entry.reencodedMatchesRaw,
      });
    }

    return sendJson(res, 404, errorBody(ErrorCode.NOT_FOUND, `未知路由 ${method} ${path}`, 0));
  } catch (err) {
    if (err instanceof DerError) {
      return sendJson(res, 400, errorBody(err.code, err.message, err.offset, err.parent));
    }
    return sendJson(
      res,
      400,
      errorBody(ErrorCode.INVALID_ARGUMENT, err instanceof Error ? err.message : String(err), 0),
    );
  }
}

async function extractInput(body: Record<string, unknown>): Promise<{
  name: string;
  bytes: Uint8Array;
}> {
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'input.der';
  if (typeof body.hex === 'string') {
    return { name, bytes: fromHex(body.hex) };
  }
  if (typeof body.base64 === 'string') {
    return { name, bytes: new Uint8Array(Buffer.from(body.base64, 'base64')) };
  }
  if (typeof body.file === 'string') {
    const content = await readFile(body.file);
    return { name, bytes: new Uint8Array(content) };
  }
  throw new DerError(
    ErrorCode.INVALID_ARGUMENT,
    '请求体必须提供 hex、base64 或 file 字段之一',
    0,
  );
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 4 * 1024 * 1024) {
      throw new DerError(ErrorCode.INPUT_TOO_LARGE, '请求体超过 4 MiB 上限', size);
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) {
    throw new DerError(ErrorCode.INVALID_ARGUMENT, '请求体为空', 0);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new DerError(ErrorCode.INVALID_ARGUMENT, '请求体不是合法 JSON', 0);
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = toJson(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function errorBody(
  code: string,
  message: string,
  offset: number,
  parent: unknown = null,
): ApiError {
  return { error: { code, message, offset, parent } };
}

export async function listenOnFreePort(
  server: Server,
  preferredPort: number,
): Promise<number> {
  const tryListen = (port: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolve((server.address() as AddressInfo).port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });

  try {
    return await tryListen(preferredPort);
  } catch (err) {
    if (preferredPort !== 0 && (err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      return tryListen(0);
    }
    throw err;
  }
}
