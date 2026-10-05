import * as fs from "node:fs";
import * as path from "node:path";

const dir = path.join(process.cwd(), "fixtures");
fs.mkdirSync(dir, { recursive: true });

const fixtures: Record<string, string> = {
  // 手写 SEQUENCE { INTEGER 5, BOOLEAN TRUE, NULL }
  "sequence.der": "30080201010101ff0500",
  // 正整数 256 (需要前导 0x00)
  "integer-pos.der": "02020100",
  // 负整数 -1
  "integer-neg.der": "0201ff",
  // 长长度 OCTET STRING: 200 个 0xAB
  "longlen-octets.der": "0481c8" + "ab".repeat(200),
  // OID 2.999.3: 首合并分量 2*40+999=1079 -> base128 0x88 0x37 (>127)
  "oid-large-first.der": "0603883703",
  // UTF8String "你好"
  "utf8.der": "0c06e4bda0e5a5bd",
  // BIT STRING 6 个有效位 0xF0,未用位 2
  "bitstring.der": "030202f0",
  // 嵌套 SEQUENCE
  "nested.der": "300a30030201010500020100",
};

for (const [name, hex] of Object.entries(fixtures)) {
  fs.writeFileSync(path.join(dir, name), Buffer.from(hex, "hex"));
  fs.writeFileSync(path.join(dir, name + ".hex"), hex + "\n");
}
console.log(`已生成 ${Object.keys(fixtures).length} 个夹具到 fixtures/`);
