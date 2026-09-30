/**
 * 用真实会话日志验证 token-ledger 与上游 tokenUsage 投影的口径一致性。
 *
 * 这是唯一有说服力的验证：同一份持久事件流，分别喂给
 *   1. token-ledger 的 tokenLedger 单元
 *   2. dsh-token-meter 的 tokenUsage 单元
 * 两者的「合计」必须逐字段相等 —— 若不等，说明本插件漏样本或多记。
 *
 * 日志是 zstd 压缩的 JSONL，事件按 seq 排列。
 *
 * 用法:
 *   node test/verify-against-meter.mjs <session.v3.jsonl.zstd>
 *
 * 需要能解析到 `@deepseek-ai/dsh-token-meter`：从 dsh 安装目录运行、或把它
 * 作为依赖装上、或用 DSH_TOKEN_METER 环境变量直接指向 usage-projection.js。
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { tokenLedgerProjectionDefinition as ledger } from "../index.mjs";

/**
 * 定位上游 tokenUsage 投影单元。优先环境变量，其次正常模块解析（在 dsh
 * 安装目录下运行时成立），最后回退到 dsh 的同级 node_modules。
 * @returns 已加载的模块命名空间。
 */
async function loadTokenUsage() {
  const override = process.env.DSH_TOKEN_METER;
  if (override !== undefined && override !== "") return import(pathToFileURL(override).href);

  try {
    return await import("@deepseek-ai/dsh-token-meter/lib/types/usage-projection.js");
  } catch (first) {
    // 回退：dsh 及其依赖常装在同一个 node_modules 里，从 dsh 自己的包目录
    // 逐级向上找 @deepseek-ai/dsh-token-meter。
    const require = createRequire(import.meta.url);
    let manifest;
    try {
      manifest = require.resolve("@deepseek-ai/dsh/package.json");
    } catch {
      console.error(
        "找不到 @deepseek-ai/dsh-token-meter。请从 dsh 安装目录运行，\n" +
          "或设置 DSH_TOKEN_METER=/path/to/dsh-token-meter/lib/types/usage-projection.js",
      );
      process.exit(2);
    }
    // 从 dsh/package.json 所在目录出发向上逐级尝试。
    const { dirname, join } = await import("node:path");
    const { existsSync } = await import("node:fs");
    let dir = dirname(manifest);
    for (;;) {
      const candidate = join(dir, "node_modules/@deepseek-ai/dsh-token-meter/lib/types/usage-projection.js");
      if (existsSync(candidate)) return import(pathToFileURL(candidate).href);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    throw first;
  }
}

const { tokenUsageProjectionDefinition: usage } = await loadTokenUsage();

const path = process.argv[2];
if (path === undefined) {
  console.error("用法: node verify-against-meter.mjs <session.v3.jsonl.zstd>");
  process.exit(2);
}

// zstd 解压后按行解析。注意：日志里有大字段，按行读足够。
const raw = execFileSync("zstd", ["-dc", path], { maxBuffer: 1024 * 1024 * 512 }).toString("utf8");
const events = [];
let skipped = 0;
for (const line of raw.split("\n")) {
  if (line.trim() === "") continue;
  try {
    events.push(JSON.parse(line));
  } catch {
    skipped += 1;
  }
}

console.log(`日志: ${path}`);
console.log(`事件: ${events.length} 条（跳过无法解析的 ${skipped} 行）`);

// 两份 fold 同时推进。
let ledgerState = ledger.init();
let usageState = usage.init();
for (const event of events) {
  ledgerState = ledger.apply(ledgerState, event);
  usageState = usage.apply(usageState, event);
}

const ledgerWire = ledger.wire.viewSchema.parse(ledger.wire.view(ledgerState));
const usageWire = usage.wire.viewSchema.parse(usage.wire.view(usageState));

const buckets = ["uncachedInputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens"];
console.log("");
console.log("上游 tokenUsage 合计:", JSON.stringify(usageWire));
console.log("本插件 totals:      ", JSON.stringify(ledgerWire.totals));

let mismatches = 0;
for (const bucket of buckets) {
  const mine = ledgerWire.totals[bucket];
  const theirs = usageWire[bucket];
  const mark = mine === theirs ? "ok  " : "差异";
  if (mine !== theirs) mismatches += 1;
  console.log(`  ${mark} ${bucket}: 本插件 ${mine} / 上游 ${theirs}`);
}

console.log("");
console.log(`路由数: ${ledgerWire.routes.length}`);
for (const route of ledgerWire.routes) {
  const total =
    route.uncachedInputTokens + route.cacheReadTokens + route.cacheWriteTokens + route.outputTokens;
  console.log(
    `  ${route.provider} / ${route.model}  请求 ${route.requests}  合计 ${total}` +
      `  (未缓存 ${route.uncachedInputTokens} / 缓存读 ${route.cacheReadTokens} / 缓存写 ${route.cacheWriteTokens} / 输出 ${route.outputTokens})`,
  );
}

// 逐路由求和必须回到合计 —— 分组不能漏账。
const sumByBucket = {};
for (const bucket of buckets) {
  sumByBucket[bucket] = ledgerWire.routes.reduce((acc, route) => acc + route[bucket], 0);
}
const sumMismatches = buckets.filter((b) => sumByBucket[b] !== ledgerWire.totals[b]);
console.log("");
console.log(
  sumMismatches.length === 0
    ? "逐路由求和 == 合计 ✓"
    : `逐路由求和不等于合计 ✗ 差异字段: ${sumMismatches.join(", ")}`,
);

const totalMismatch = mismatches !== 0 || sumMismatches.length !== 0;
console.log("");
console.log(totalMismatch ? "口径不一致 ✗" : "口径一致 ✓");
process.exit(totalMismatch ? 1 : 0);
