# ASN.1 DER 子集解析与规范编码核验后端

离线、本地运行的 ASN.1 DER 字节检查服务。接收小型二进制文件或十六进制文本,严格解析一个顶层值,返回嵌套节点树、原始偏移与规范性诊断,并可将受支持的节点树重新编码为规范 DER 用于往返核对。仅提供 HTTP API 与 CLI,无 UI。仅依赖 Node.js 内置模块(`node:sqlite`、`node:http`),不需要 Docker、WSL 或任何在线服务。

## 环境要求

- Windows 本地,Node.js >= 22.5(开发使用 Node 25 验证)
- 仅开发依赖 TypeScript(`npm install`)

## 快速开始

```powershell
npm install        # 安装 TypeScript 开发依赖
npm run build      # 编译 TypeScript 到 dist/
npm run fixtures   # 生成 fixtures/ 下的手工 DER 夹具
npm test           # 构建并运行全部测试
npm start          # 启动 HTTP API(默认选择空闲端口,PORT 环境变量可指定)
npm run cli -- --help   # CLI 帮助(实际命令见下)
npm run demo       # 端到端演示: 导入夹具、打印树、重编码核对、失败诊断
```

数据目录为项目内 `data/`(SQLite 数据库 `data/der.db`),只操作项目内夹具与产物,不扫描系统证书库。

## 支持的类型(单字节通用标签)

| 标签 | 类型 | 值解释 |
|------|------|--------|
| 0x01 | BOOLEAN | 长度必须为 1;`00`=假,`FF`=真,其他值报非规范真值 |
| 0x02 | INTEGER | 有符号二进制补码;拒绝空值与非最短前导 `00`/`FF`;超出安全整数范围时以十进制字符串返回 |
| 0x03 | BIT STRING | 首字节为末字节未用位数(0-7);校验填充位必须为 0,不混入有效位 |
| 0x04 | OCTET STRING | 保留任意字节(hex),不自动当文本 |
| 0x05 | NULL | 长度必须为 0 |
| 0x06 | OBJECT IDENTIFIER | 自行 base-128 变长解码,首合并分量可占多字节,恢复前两段;整数用 BigInt 保持精确 |
| 0x0C | UTF8String | 严格 UTF-8 校验(fatal 模式) |
| 0x30 | SEQUENCE | 构造类型,可嵌套;值区必须恰好由完整子节点占满 |

## 明确拒绝的格式

- 不定长度(0x80)、非最短长度编码(前导 0x00、可用短形式却用长形式)
- 截断的标签/长度/内容、子值越过容器结尾、顶层值之后的尾部多余字节
- 多字节高标签号(0x1F)、非通用类标签、未支持的通用标签号
- 构造位与类型不匹配(如构造形式的 BOOLEAN、原始形式的 SEQUENCE)
- 非最短 INTEGER、非规范 BOOLEAN 真值、BIT STRING 填充位非零、损坏 UTF-8
- OID 未结束分量、非最短分量表示
- 超过资源上限: 总大小 1 MiB、长度字段最多 4 字节、嵌套深度 32(在申请内存/递归前检查)

不做证书签发、密钥管理、ASN.1 模式编译或任意 BER 兼容解析;不根据内容猜测类型。

## 诊断与错误码

解析失败返回诊断数组,每项含 `code`、`offset`、`message`,容器内错误附 `parentStart`/`parentEnd`。主要错误码:
`E_EMPTY_INPUT` `E_SIZE_LIMIT` `E_DEPTH_LIMIT` `E_TRUNCATED` `E_INDEFINITE_LENGTH` `E_NON_MINIMAL_LENGTH` `E_LENGTH_OVERFLOW` `E_CONTENT_OVERRUN` `E_TRAILING_BYTES` `E_UNSUPPORTED_TAG` `E_BAD_CONSTRUCTED` `E_INTEGER_EMPTY` `E_INTEGER_NON_MINIMAL` `E_BOOLEAN_LENGTH` `E_BOOLEAN_NONCANONICAL` `E_NULL_LENGTH` `E_BITSTRING_EMPTY` `E_BITSTRING_UNUSED_RANGE` `E_BITSTRING_PADDING` `E_UTF8_INVALID` `E_OID_EMPTY` `E_OID_TRUNCATED` `E_OID_NON_MINIMAL` `E_VALIDATION` `E_NOT_FOUND` `E_PARSE_FAILED`

报告区分两件事: 原始字节是否合法(`ok` + `diagnostics`)与重新生成的字节是否规范(`encode` 的 `canonical` 字段)。损坏输入明确失败,绝不通过"先宽松读取再重编码"掩盖原输入不规范。

## HTTP API

默认监听 `127.0.0.1` 的空闲端口并在启动时打印;`PORT` 环境变量或 CLI `serve --port` 可指定。

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/documents` | 导入 `{name, hex 或 base64}`,严格解析并落库;相同内容复用,修改内容创建新版本 |
| GET | `/documents` | 列出文档(id、名称、版本、sha256、大小、子集版本) |
| GET | `/documents/:id` | 文档元信息 |
| GET | `/documents/:id/report` | 解析报告(诊断 + 成功时的节点树) |
| GET | `/documents/:id/tree` | 带偏移的缩进树(文本) |
| GET | `/documents/:id/nodes?path=0/1` | 按节点路径查询(空路径为根) |
| POST | `/documents/:id/encode` | 由节点树重编码为规范 DER,返回 hex 与 `canonical` |
| GET | `/documents/:id/compare?other=:id2` | 比较两份原始字节(附 sha256) |
| POST | `/documents/:id/compare` | 与请求体 `{hex}` 比较 |
| GET | `/documents/:id/export` | 导出原始字节(octet-stream) |
| POST | `/parse` | 一次性严格解析 `{hex 或 base64}`,不落库 |

## CLI

```powershell
npm run cli -- import <文件|hex> [--name 名称]   # 导入并严格解析(入库)
npm run cli -- parse <文件|hex>                  # 一次性严格解析(不入库)
npm run cli -- list                              # 列出文档
npm run cli -- tree <id>                         # 带偏移的缩进树
npm run cli -- node <id> <路径>                  # 查询节点,如 0/1
npm run cli -- encode <id>                       # 重编码为规范 DER 并核对原字节
npm run cli -- compare <idA> <idB>               # 比较原始字节
npm run cli -- export <id> <输出文件>            # 导出原始字节
npm run cli -- report <id>                       # 查看报告/诊断
npm run cli -- serve [--port 端口]               # 启动 HTTP API
```

输入参数可以是二进制文件、hex 文本文件或直接的内联 hex 字符串。SQLite 持久化保存输入摘要(sha256)、原字节、子集版本与解析结果,重启后仍可核对同一份原始字节;失败诊断保留错误偏移与父节点范围,不登记成成功树。

## 夹具与测试

`npm run fixtures` 生成 `fixtures/`: 手写 SEQUENCE、正/负 INTEGER、长长度(200 字节)OCTET STRING、首合并分量大于 127 的 OID(`2.999.3`)、UTF8String、BIT STRING、嵌套 SEQUENCE,均附 `.hex` 文本。

测试(`npm test`,29 个用例)覆盖: 手工已知 DER 字节的偏移与值核对、非最短整数、非规范真值、不定长度、坏填充位、容器截断、尾部多余字节、非法 UTF-8、OID 截断/非最短、合法输入重编码字节完全相同、损坏输入明确失败、资源上限(大小/深度)、相同内容复用与修改后新版本、失败不登记成功树、重启后读取旧报告。

## 目录结构

```
src/der.ts      核心: 严格 DER 解析器、规范编码器、路径查询、树格式化
src/store.ts    SQLite 持久化(文档 + 报告,事务导入)
src/server.ts   HTTP API(node:http)
src/cli.ts      命令行入口
test/           node:test 测试
scripts/        夹具生成与演示脚本
fixtures/       手工 DER 夹具
data/           SQLite 数据目录(运行时生成)
```

## 已知限制

- 仅单字节通用标签的 8 种类型;不支持上下文/应用/私有类标签、高标签号、SET、PrintableString 等其余类型
- 仅 DER 严格子集,不做 BER 兼容(不定长度、构造形式原始类型一律拒绝)
- 单值解析: 输入必须恰好是一个顶层值
- `node:sqlite` 目前为实验性 API,启动时会打印一次实验警告(脚本中已抑制)
