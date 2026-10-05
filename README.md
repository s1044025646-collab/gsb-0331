# ASN.1 DER 子集解析与规范编码核验后端

离线运行的 ASN.1 DER（Distinguished Encoding Rules）子集字节检查服务，只提供 **HTTP API 与 CLI**，不含任何前端。
技术栈为 TypeScript + Node.js（内置 `node:sqlite`，SQLite 无需原生编译），在 Windows 本地直接运行；
不依赖 Docker、WSL、付费服务或外部在线 API，也不扫描系统证书库。

## 支持范围（子集版本 `der-subset-1`）

仅接受 **单字节通用类标签（class=00）**：

| 标签 | 类型 | 形式 | 说明 |
| --- | --- | --- | --- |
| `0x01` | BOOLEAN | 原始 | 长度必须为 1；`00` 为假、`FF` 为真，其它字节拒绝 |
| `0x02` | INTEGER | 原始 | 有符号二进制补码；拒绝空值、非最短前导 `00`/`FF`；超出安全整数时以十进制字符串呈现 |
| `0x03` | BIT STRING | 原始 | 首字节为末字节未用位数（0–7）；校验填充位为 0，空数据时未用位数必须为 0 |
| `0x04` | OCTET STRING | 原始 | 保留任意字节并以十六进制呈现，不自动当文本 |
| `0x05` | NULL | 原始 | 长度必须为 0 |
| `0x06` | OBJECT IDENTIFIER | 原始 | 自行实现 base-128 变长分量；首分量可为多字节；拒绝未结束分量与非最短表示，编号用精确整数 |
| `0x0C` | UTF8String | 原始 | 严格 UTF-8 校验，拒绝损坏/过长/代理项序列 |
| `0x10` | SEQUENCE | 构造 | 可任意嵌套；值区必须恰好由完整子节点占满 |

## 明确拒绝的内容

- 非通用类标签（application/context/private）、多字节标签号（`0x1F` 形式）、不在上表中的标签。
- 错误构造位：SEQUENCE 必须构造（`0x30`），其余支持类型必须原始（不带 `0x20`）。
- BER 兼容形式：不定长度（`0x80`）一律拒绝，不做任何 BER 恢复或按内容猜类型。
- 非最短长度：短长度可表示却用长长度、长长度前导 `0x00`。
- 截断、长度字段不完整、子值越过 SEQUENCE/顶层边界、容器未被子节点占满。
- 顶层值之后的任何尾部多余字节。
- 资源上限：默认输入 ≤ 1 MiB、嵌套深度 ≤ 64，在分配与深递归前检查。

规范核验分两个独立结论，不互相掩盖：

1. **原字节是否合法 DER**（严格解析结果）；
2. **用解析出的节点树重新编码得到的字节是否规范、是否与原字节逐字节相同**。

即使输入已被判定不合法，也不会通过“宽松读入再重编码”让它变干净；失败只保存诊断，不登记成功树。

## 目录与数据

```
src/der/      解析、编码、UTF-8、OID、INTEGER、错误码
src/server.ts HTTP API
src/cli.ts    CLI
src/service.ts SQLite 存储与版本管理
scripts/      夹具生成与演示
tests/        解析、存储事务、HTTP API 测试
fixtures/     手写 DER 夹具（npm run fixtures 生成）
data/         项目内数据目录，SQLite 位于 data/der.db（可用 DER_DATA_DIR 覆盖）
```

SQLite 表保存输入 SHA-256、原字节 BLOB、子集版本、成功解析报告 JSON 或失败诊断 JSON。
相同 SHA-256 再次导入会累积为同一输入的新版本；不同字节即新版本记录。
失败记录包含错误码、错误偏移与父节点范围，`report_json` 为空。

## 快速开始（Windows PowerShell）

需要 Node.js ≥ 22.5（已在 Node v25 验证；用到内置 `node:sqlite` 与 TypeScript 编译）。

```powershell
npm install
npm run build
npm test          # 运行全部测试（解析器 / SQLite 服务 / HTTP API）
npm run fixtures  # 在 fixtures/ 生成手写 DER 夹具
npm run demo      # 端到端演示：合法往返 + 多种损坏输入诊断
npm start         # 启动 HTTP 服务（默认自动选择空闲端口）
```

## CLI

编译后入口为 `dist/src/cli.js`（也可用 `npm link` 后使用 `dercheck`）：

```powershell
node dist/src/cli.js import --hex "300602012A0101FF" --name sample.der
node dist/src/cli.js import --file fixtures/nested-sequence.der
node dist/src/cli.js list
node dist/src/cli.js show 1
node dist/src/cli.js node 1 --path /0/1
node dist/src/cli.js encode 1
node dist/src/cli.js compare 1
node dist/src/cli.js export 1 --out out\copy.der
node dist/src/cli.js serve --port 8080
```

树输出带 `[start-end)` 偏移、值起始偏移与长度，例如：

```
[000-240) SEQUENCE len=237 val@003  SEQUENCE (4 个子节点)
  [003-219) SEQUENCE len=213 val@006  SEQUENCE (4 个子节点)
    [006-009) INTEGER len=1 val@008  INTEGER 127
    [012-016) OBJECT IDENTIFIER len=2 val@014  OID 2.800
    [016-219) OCTET STRING len=200 val@019  OCTET STRING (200 字节) …
```

## HTTP API

仅监听 `127.0.0.1`。端口取 `--port` / `PORT` 环境变量，默认 `0`（由系统分配空闲端口；
若指定端口被占用则自动回退到空闲端口）。

| 方法与路径 | 作用 |
| --- | --- |
| `GET /health` | 健康检查 |
| `POST /api/inputs` | 导入并严格解析。JSON 体含 `hex`、`base64` 或 `file`（项目内路径）之一，可选 `name` |
| `GET /api/inputs` | 列出全部记录（含成功/失败状态、子集版本、时间） |
| `GET /api/inputs/{id}/report` | 读取报告或失败诊断（可用于重启后查看旧记录） |
| `GET /api/inputs/{id}/node?path=/0/1` | 按节点路径查询节点、长度与值解释 |
| `POST /api/inputs/{id}/reencode` | 返回规范重编码十六进制、是否规范、是否与原字节一致 |
| `GET /api/inputs/{id}/raw` | 导出原始字节（`application/octet-stream`） |

错误响应统一为 `{ "error": { "code", "message", "offset", "parent" } }`，
常用错误码：`UNSUPPORTED_TAG`、`BAD_CONSTRUCTED_BIT`、`INDEFINITE_LENGTH`、
`NON_MINIMAL_LENGTH`、`TRUNCATED`、`CHILD_EXCEEDS_CONTAINER`、
`CONTAINER_NOT_FULLY_OCCUPIED`、`TRAILING_BYTES`、`NESTING_TOO_DEEP`、
`INTEGER_NON_MINIMAL`、`BOOLEAN_BAD_VALUE`、`BITSTRING_UNUSED_BITS_NONZERO`、
`UTF8_INVALID`、`OID_UNTERMINATED`、`OID_NON_MINIMAL`、`INVALID_HEX` 等。

```powershell
curl.exe -X POST http://127.0.0.1:<port>/api/inputs `
  -H "content-type: application/json" `
  -d '{\"hex\":\"300302012A\"}'
```

## 夹具与测试覆盖

手写夹具：嵌套 SEQUENCE、正/负 INTEGER、200 字节长长度 OCTET STRING、
首合并分量大于 127 的 OID（`2.800`，编码 `06 02 86 70`）、UTF-8 字符串、BOOLEAN。

测试覆盖：

- 非最短整数（前导 `00`/`FF`）、非规范 BOOLEAN 真值、不定长度、非最短长度；
- BIT STRING 坏填充位、未用位数越界；容器截断、子值越界、尾部多余字节；非法 UTF-8；
- OID 未结束分量与非最短 base-128；
- 手工已知 DER 的偏移与值断言；合法输入解析→重编码逐字节相同；
- 资源上限（深度/输入大小）、导入事务回滚、重启后旧报告读取、API 参数校验。

## 限制与假设

- 只实现题目所列 8 种类型与单字节通用标签；不支持 SET、CHOICE、ANY、BIT/OCTET STRING 构造编码等。
- 不做证书签发、密钥管理、ASN.1 模式（schema）编译、时间类型或 OID 名称数据库。
- 仅 DER，明确不兼容任意 BER 输入。
- 长度字段最多接受 6 个长度字节（32 位以上输入本就被 1 MiB 上限拒绝）。
- 服务仅绑定本地回环地址，定位为本地单机工具。
