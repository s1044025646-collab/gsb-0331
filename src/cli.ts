import * as fs from "node:fs";
import { Store } from "./store";
import { parseDer, encodeNode, findNode, formatTree, SUBSET_VERSION } from "./der";
import { startServer } from "./server";

function readInput(arg: string): Buffer {
  if (fs.existsSync(arg)) {
    const raw = fs.readFileSync(arg);
    const text = raw.toString("utf8").trim();
    if (/^[0-9a-fA-F\s]+$/.test(text) && text.replace(/\s+/g, "").length % 2 === 0 && !text.includes("\0")) {
      // 十六进制文本文件
      return Buffer.from(text.replace(/\s+/g, ""), "hex");
    }
    return raw; // 二进制文件
  }
  const hex = arg.replace(/\s+/g, "");
  if (/^[0-9a-fA-F]*$/.test(hex) && hex.length % 2 === 0) return Buffer.from(hex, "hex");
  die(`无法读取输入: ${arg} (既不是文件也不是合法 hex)`);
}

function die(msg: string): never {
  console.error(`错误: ${msg}`);
  process.exit(1);
}

function need(args: string[], i: number, what: string): string {
  if (i >= args.length) die(`缺少参数: ${what}`);
  return args[i];
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const store = new Store();
  switch (cmd) {
    case "import": {
      const file = need(args, 0, "文件或hex");
      const nameIdx = args.indexOf("--name");
      const name = nameIdx >= 0 ? args[nameIdx + 1] : file.replace(/[\\/]/g, "_");
      const bytes = readInput(file);
      const { doc, report, reused } = store.importDocument(name, bytes);
      console.log(`${reused ? "已存在(复用)" : "已导入"} 文档 #${doc.id} 名称=${doc.name} 版本=${doc.version} sha256=${doc.sha256.slice(0, 16)}…`);
      console.log(`解析: ${report.ok ? "成功" : "失败"}`);
      if (!report.ok) console.log(JSON.stringify(JSON.parse(report.diagnostics), null, 2));
      break;
    }
    case "parse": {
      const bytes = readInput(need(args, 0, "文件或hex"));
      const r = parseDer(bytes);
      if (r.ok) { console.log("解析成功:"); console.log(formatTree(r.node!)); }
      else { console.log("解析失败:"); console.log(JSON.stringify(r.diagnostics, null, 2)); process.exitCode = 2; }
      break;
    }
    case "list":
      for (const d of store.listDocuments()) console.log(`#${d.id} ${d.name} v${d.version} ${d.size}B sha256=${d.sha256.slice(0, 16)}… ${d.created_at}`);
      break;
    case "tree": {
      const tree = store.getTree(Number(need(args, 0, "文档id")));
      if (!tree) die("文档不存在或解析失败,无节点树");
      console.log(formatTree(tree));
      break;
    }
    case "node": {
      const id = Number(need(args, 0, "文档id"));
      const path = need(args, 1, "节点路径(如 0/2)");
      const tree = store.getTree(id);
      if (!tree) die("文档不存在或解析失败");
      const node = findNode(tree, path);
      if (!node) die(`节点路径不存在: ${path}`);
      console.log(JSON.stringify(node, null, 2));
      break;
    }
    case "encode": {
      const tree = store.getTree(Number(need(args, 0, "文档id")));
      if (!tree) die("文档不存在或解析失败,无法重编码");
      const encoded = encodeNode(tree);
      const original = store.getBytes(Number(args[0]))!;
      console.log(encoded.toString("hex"));
      console.log(`与原始字节一致: ${encoded.equals(original)}`);
      break;
    }
    case "compare": {
      const a = store.getBytes(Number(need(args, 0, "文档id A")));
      const b = store.getBytes(Number(need(args, 1, "文档id B")));
      if (!a || !b) die("文档不存在");
      console.log(`字节一致: ${a.equals(b)}`);
      break;
    }
    case "export": {
      const bytes = store.getBytes(Number(need(args, 0, "文档id")));
      if (!bytes) die("文档不存在");
      const out = need(args, 1, "输出文件");
      fs.writeFileSync(out, bytes);
      console.log(`已导出 ${bytes.length} 字节到 ${out}`);
      break;
    }
    case "report": {
      const r = store.getReport(Number(need(args, 0, "文档id")));
      if (!r) die("文档不存在");
      console.log(JSON.stringify({ ok: !!r.ok, diagnostics: JSON.parse(r.diagnostics) }, null, 2));
      break;
    }
    case "serve": {
      const pIdx = args.indexOf("--port");
      const port = pIdx >= 0 ? Number(args[pIdx + 1]) : 0;
      const { port: actual } = await startServer(port);
      console.log(`DER 检查服务已启动: http://127.0.0.1:${actual} (子集版本 ${SUBSET_VERSION})`);
      return; // 保持运行
    }
    default:
      console.log(`ASN.1 DER 子集检查工具 (${SUBSET_VERSION})
用法:
  import <文件|hex> [--name 名称]   导入并严格解析(入库)
  parse <文件|hex>                 一次性严格解析(不入库)
  list                             列出已导入文档
  tree <id>                        显示带偏移的缩进树
  node <id> <路径>                 查询节点(如 0/1)
  encode <id>                      由节点树重编码为规范 DER(hex)
  compare <idA> <idB>              比较两份原始字节
  export <id> <输出文件>           导出原始字节
  report <id>                      查看解析报告/诊断
  serve [--port 端口]              启动 HTTP API(默认选择空闲端口)`);
  }
  store.close();
}

main().catch((e) => die(String(e?.message ?? e)));
