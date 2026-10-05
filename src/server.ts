import * as http from "node:http";
import { Store } from "./store";
import { parseDer, encodeNode, findNode, SUBSET_VERSION, MAX_TOTAL_BYTES } from "./der";
import { createHash } from "node:crypto";

function send(res: http.ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(data);
}

function sendErr(res: http.ServerResponse, status: number, code: string, message: string) {
  send(res, status, { error: { code, message } });
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_TOTAL_BYTES * 2) throw Object.assign(new Error("请求体过大"), { code: "E_SIZE_LIMIT" });
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function decodeInput(body: { hex?: string; base64?: string }): Buffer {
  if (typeof body.hex === "string") {
    const hex = body.hex.replace(/\s+/g, "");
    if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) throw Object.assign(new Error("hex 文本非法"), { code: "E_VALIDATION" });
    return Buffer.from(hex, "hex");
  }
  if (typeof body.base64 === "string") return Buffer.from(body.base64, "base64");
  throw Object.assign(new Error("需要 hex 或 base64 字段"), { code: "E_VALIDATION" });
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      // POST /documents  {name, hex|base64} 导入并解析
      if (req.method === "POST" && parts[0] === "documents" && parts.length === 1) {
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
        if (typeof body.name !== "string" || !body.name) return sendErr(res, 400, "E_VALIDATION", "缺少 name 字段");
        const bytes = decodeInput(body);
        if (bytes.length === 0) return sendErr(res, 400, "E_EMPTY_INPUT", "输入为空");
        if (bytes.length > MAX_TOTAL_BYTES) return sendErr(res, 413, "E_SIZE_LIMIT", "输入超过大小上限");
        const { doc, report, reused } = store.importDocument(body.name, bytes);
        return send(res, reused ? 200 : 201, { document: doc, ok: !!report.ok, diagnostics: JSON.parse(report.diagnostics), reused });
      }
      // GET /documents
      if (req.method === "GET" && parts[0] === "documents" && parts.length === 1) {
        return send(res, 200, { documents: store.listDocuments() });
      }
      const id = parts[0] === "documents" && parts[1] ? Number(parts[1]) : NaN;
      if (parts[0] === "documents" && !Number.isInteger(id)) return sendErr(res, 400, "E_VALIDATION", "文档 id 非法");
      if (parts[0] === "documents" && !store.getDocument(id)) return sendErr(res, 404, "E_NOT_FOUND", "文档不存在");

      // GET /documents/:id
      if (req.method === "GET" && parts.length === 2) {
        return send(res, 200, { document: store.getDocument(id) });
      }
      // GET /documents/:id/report
      if (req.method === "GET" && parts[2] === "report") {
        const r = store.getReport(id)!;
        return send(res, 200, { ok: !!r.ok, diagnostics: JSON.parse(r.diagnostics), tree: r.tree ? JSON.parse(r.tree) : null, subsetVersion: SUBSET_VERSION });
      }
      // GET /documents/:id/tree  带偏移的缩进树
      if (req.method === "GET" && parts[2] === "tree") {
        const tree = store.getTree(id);
        if (!tree) return sendErr(res, 409, "E_PARSE_FAILED", "该文档解析失败,无节点树");
        const { formatTree } = require("./der");
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        return res.end(formatTree(tree) + "\n");
      }
      // GET /documents/:id/nodes?path=0/1
      if (req.method === "GET" && parts[2] === "nodes") {
        const tree = store.getTree(id);
        if (!tree) return sendErr(res, 409, "E_PARSE_FAILED", "该文档解析失败,无节点树");
        const node = findNode(tree, url.searchParams.get("path") ?? "");
        if (!node) return sendErr(res, 404, "E_NOT_FOUND", "节点路径不存在");
        return send(res, 200, { node });
      }
      // POST /documents/:id/encode  由节点树重编码为规范 DER
      if (req.method === "POST" && parts[2] === "encode") {
        const tree = store.getTree(id);
        if (!tree) return sendErr(res, 409, "E_PARSE_FAILED", "该文档解析失败,无法重编码");
        const encoded = encodeNode(tree);
        const original = store.getBytes(id)!;
        return send(res, 200, {
          hex: encoded.toString("hex"),
          canonical: encoded.equals(original),
          note: "canonical 表示重编码字节与原始输入完全一致",
        });
      }
      // GET /documents/:id/compare?other=:id2  或 POST /documents/:id/compare {hex}
      if ((req.method === "GET" || req.method === "POST") && parts[2] === "compare") {
        const a = store.getBytes(id)!;
        let b: Buffer | undefined;
        if (req.method === "GET") {
          const other = Number(url.searchParams.get("other"));
          if (!Number.isInteger(other)) return sendErr(res, 400, "E_VALIDATION", "缺少 other 参数");
          b = store.getBytes(other);
          if (!b) return sendErr(res, 404, "E_NOT_FOUND", "对比文档不存在");
        } else {
          b = decodeInput(JSON.parse((await readBody(req)).toString("utf8") || "{}"));
        }
        return send(res, 200, {
          equal: a.equals(b),
          sha256A: createHash("sha256").update(a).digest("hex"),
          sha256B: createHash("sha256").update(b).digest("hex"),
        });
      }
      // GET /documents/:id/export  导出原始字节
      if (req.method === "GET" && parts[2] === "export") {
        const bytes = store.getBytes(id)!;
        res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="doc-${id}.der"` });
        return res.end(bytes);
      }
      // POST /parse  {hex|base64}  一次性严格解析(不落库)
      if (req.method === "POST" && parts[0] === "parse") {
        const bytes = decodeInput(JSON.parse((await readBody(req)).toString("utf8") || "{}"));
        return send(res, 200, parseDer(bytes));
      }
      return sendErr(res, 404, "E_NOT_FOUND", "路由不存在");
    } catch (e: any) {
      if (e?.code === "E_VALIDATION") return sendErr(res, 400, e.code, e.message);
      if (e?.code === "E_SIZE_LIMIT") return sendErr(res, 413, e.code, e.message);
      if (e instanceof SyntaxError) return sendErr(res, 400, "E_VALIDATION", "JSON 请求体非法");
      return sendErr(res, 500, "E_INTERNAL", String(e?.message ?? e));
    }
  });
}

export function startServer(port: number = Number(process.env.PORT ?? 0), dbPath?: string): Promise<{ server: http.Server; port: number; store: Store }> {
  const store = new Store(dbPath);
  const server = createServer(store);
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port, store });
    });
  });
}

if (require.main === module) {
  startServer().then(({ port }) => {
    console.log(`DER 检查服务已启动: http://127.0.0.1:${port} (子集版本 ${SUBSET_VERSION})`);
  });
}
