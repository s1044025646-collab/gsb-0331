// 演示: 导入夹具 -> 打印树 -> 重编码核对 -> 展示失败诊断
const { execSync } = require("node:child_process");
const cli = (args) => {
  console.log(`\n$ node dist/src/cli.js ${args}`);
  try {
    console.log(execSync(`"${process.execPath}" dist/src/cli.js ${args}`, { encoding: "utf8" }).trim());
  } catch (e) {
    console.log((e.stdout || "").trim(), (e.stderr || "").trim());
  }
};
cli("import fixtures/sequence.der --name demo-seq");
cli("import fixtures/oid-large-first.der --name demo-oid");
cli("import fixtures/longlen-octets.der --name demo-long");
cli("list");
cli("tree 1");
cli("node 1 0");
cli("encode 1");
cli("parse 308005000000");
cli("export 1 data/demo-export.der");
cli("compare 1 1");
