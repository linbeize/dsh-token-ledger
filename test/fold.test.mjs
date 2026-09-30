/**
 * token-ledger 投影单元离线自测：用合成事件流验证口径不变量。
 * 不依赖 dsh 运行时，只跑纯 fold。
 * 用法: node test/fold.test.mjs （在插件目录下跑）
 */
import { tokenLedgerProjectionDefinition as def } from "../index.mjs";

let failures = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}`);
    console.log(`       期望 ${e}`);
    console.log(`       实际 ${a}`);
  }
}

/** 构造一个 assistant/message 事件。 */
function assistant(seq, turn, step, provider, model, usage) {
  return {
    seq,
    type: "assistant/message",
    data: {
      turn,
      step,
      message: { role: "assistant", content: [], source: { kind: "model", provider, model } },
      stream: [],
      ...(usage === undefined ? {} : { usage }),
    },
  };
}

/** 构造一个 request/context 事件。 */
function requestContext(seq, provider, model, contextWindow) {
  return {
    seq,
    type: "request/context",
    data: { provider, model, ...(contextWindow === undefined ? {} : { contextWindow }) },
  };
}

/** 构造 llm/retry-started。 */
function retryStarted(seq, turn, step) {
  return { seq, type: "llm/retry-started", data: { retryId: "r", turn, step, retry: 1 } };
}

/** 跑完整 fold 并取线上值。 */
function run(events) {
  let state = def.init();
  for (const event of events) state = def.apply(state, event);
  return { state, wire: def.wire.viewSchema.parse(def.wire.view(state)) };
}

console.log("1) 空日志");
check("路由为空", run([]).wire.routes, []);
check("合计全零", run([]).wire.totals, {
  requests: 0, uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0,
});

console.log("2) 单路由单次请求");
const single = run([
  assistant(0, 0, 0, "p1", "m1", {
    inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheWriteTokens: 5,
  }),
]);
check("一条路由", single.wire.routes.length, 1);
check("请求数 1", single.wire.routes[0].requests, 1);
check("未缓存输入", single.wire.routes[0].uncachedInputTokens, 100);
check("缓存读", single.wire.routes[0].cacheReadTokens, 900);
check("缓存写", single.wire.routes[0].cacheWriteTokens, 5);
check("输出", single.wire.routes[0].outputTokens, 20);
check("合计请求数", single.wire.totals.requests, 1);
check("合计四桶", [
  single.wire.totals.uncachedInputTokens,
  single.wire.totals.cacheReadTokens,
  single.wire.totals.cacheWriteTokens,
  single.wire.totals.outputTokens,
], [100, 900, 5, 20]);

console.log("3) 同一次尝试的重复样本按 last-wins 替换，而不是累加");
const replaced = run([
  assistant(0, 0, 0, "p1", "m1", { inputTokens: 100, outputTokens: 20 }),
  assistant(1, 0, 0, "p1", "m1", { inputTokens: 100, outputTokens: 35 }),
]);
check("只有一次请求", replaced.wire.totals.requests, 1);
check("输出取后值", replaced.wire.totals.outputTokens, 35);

console.log("4) retry-started 关闭替换槽 —— 重试是新增计费");
const retried = run([
  assistant(0, 0, 0, "p1", "m1", { inputTokens: 100, outputTokens: 20 }),
  retryStarted(1, 0, 0),
  assistant(2, 0, 0, "p1", "m1", { inputTokens: 100, outputTokens: 35 }),
]);
check("计两次请求", retried.wire.totals.requests, 2);
check("输入累加", retried.wire.totals.uncachedInputTokens, 200);
check("输出累加", retried.wire.totals.outputTokens, 55);

console.log("5) 跨路由分组 —— 会话中途换模型");
const switched = run([
  assistant(0, 0, 0, "ds", "v4", { inputTokens: 100, outputTokens: 10 }),
  requestContext(1, "zai", "glm-5.3", 200000),
  assistant(2, 1, 0, "zai", "glm-5.3", { inputTokens: 200, outputTokens: 30 }),
]);
check("两条路由", switched.wire.routes.length, 2);
check("按总量降序（zai 300 > ds 110）", switched.wire.routes.map((r) => r.provider), ["zai", "ds"]);
check("合计请求数", switched.wire.totals.requests, 2);
check("合计输入", switched.wire.totals.uncachedInputTokens, 300);

console.log("6) 无消息来源的 attempt 回退到最近 request/context 的路由");
const fallback = run([
  requestContext(0, "p2", "m2"),
  {
    seq: 1,
    type: "assistant/attempt",
    data: { turn: 0, step: 0, stream: [{ type: "chunk", time: 1, chunk: { type: "usage", usage: { inputTokens: 7, outputTokens: 3 } } }] },
  },
]);
check("归属到 p2/m2", fallback.wire.routes.map((r) => `${r.provider}/${r.model}`), ["p2/m2"]);
check("计数正确", fallback.wire.totals.outputTokens, 3);

console.log("7) 归属不了就不记账（没有 request/context 的裸 attempt）");
const unattributable = run([
  {
    seq: 0,
    type: "assistant/attempt",
    data: { turn: 0, step: 0, stream: [{ type: "chunk", time: 1, chunk: { type: "usage", usage: { inputTokens: 7, outputTokens: 3 } } }] },
  },
]);
check("不产生路由", unattributable.wire.routes, []);
check("合计为零", unattributable.wire.totals.requests, 0);

console.log("8) 非法计数让整个样本作废，不写脏账");
const dirty = run([
  assistant(0, 0, 0, "p1", "m1", { inputTokens: -5, outputTokens: 10 }),
  assistant(1, 0, 0, "p1", "m1", { inputTokens: 1.5, outputTokens: 10 }),
]);
check("两次都作废", dirty.wire.routes, []);

console.log("9) reasoningTokens 只在每次请求都上报时才外发");
const partialReasoning = run([
  assistant(0, 0, 0, "p1", "m1", { inputTokens: 10, outputTokens: 5, reasoningTokens: 3 }),
  retryStarted(1, 0, 0),
  assistant(2, 0, 0, "p1", "m1", { inputTokens: 10, outputTokens: 5 }),
]);
check("参差不齐 → 不出现该字段", partialReasoning.wire.totals.reasoningTokens, undefined);
const fullReasoning = run([
  assistant(0, 0, 0, "p1", "m1", { inputTokens: 10, outputTokens: 5, reasoningTokens: 3 }),
  retryStarted(1, 0, 0),
  assistant(2, 0, 0, "p1", "m1", { inputTokens: 10, outputTokens: 5, reasoningTokens: 2 }),
]);
check("全部上报 → 合计 5", fullReasoning.wire.totals.reasoningTokens, 5);

console.log("10) 不关心的事件返回同引用（零下游工作）");
const base = def.init();
const sameRef = def.apply(base, { seq: 0, type: "turn/start", data: { turn: 0 } });
check("同引用", sameRef === base, true);

console.log("11) 状态可被 schema 回读（投影缓存持久化前提）");
const persisted = run([assistant(0, 0, 0, "p1", "m1", { inputTokens: 10, outputTokens: 5 })]);
const roundTripped = def.stateSchema.parse(JSON.parse(JSON.stringify(persisted.state)));
check("状态往返一致", def.wire.view.apply(null, [roundTripped]), def.wire.view(persisted.state));
check("状态是纯 JSON", JSON.parse(JSON.stringify(persisted.state)) !== undefined, true);

console.log("12) 路由表溢出时并入合并桶，状态有界");
const many = [];
for (let index = 0; index < 70; index += 1) {
  many.push(retryStarted(index * 2, 0, index));
  many.push(assistant(index * 2 + 1, 0, index, "p", `m${index}`, { inputTokens: 1, outputTokens: 1 }));
}
const overflow = run(many);
// 64 条真实路由先占满，其后的 6 条（i=64..69）并入唯一的合并桶。
check("线上行数 = 64 真实 + 1 合并", overflow.wire.routes.length, 65);
check("存在合并桶", overflow.wire.routes.some((r) => r.provider === "(other)"), true);
check("合并桶吃到 6 条路由", overflow.wire.routes.find((r) => r.provider === "(other)").requests, 6);
check("合计仍是 70 次请求", overflow.wire.totals.requests, 70);

console.log("13) 合并桶不参与替换 —— 溢出后合计不得被别的路由减掉");
// 先把路由表填满（64 条），让后续路由落入合并桶。
const overflowEvents = [];
for (let index = 0; index < 64; index += 1) {
  overflowEvents.push(retryStarted(index * 2, 0, index));
  overflowEvents.push(assistant(index * 2 + 1, 0, index, "p", `m${index}`, { inputTokens: 1, outputTokens: 1 }));
}
// 第 65、66 条路由都并入 (other)；同一步骤内两条不同路由的样本必须各记一次。
overflowEvents.push(retryStarted(200, 0, 90));
overflowEvents.push(assistant(201, 0, 90, "p", "mx", { inputTokens: 100, outputTokens: 10 }));
overflowEvents.push(retryStarted(202, 0, 91));
overflowEvents.push(assistant(203, 0, 91, "p", "my", { inputTokens: 7, outputTokens: 3 }));
const merged = run(overflowEvents);
check("合并桶计两次请求", merged.wire.routes.find((r) => r.provider === "(other)").requests, 2);
check("合并桶输入 = 107（未被替换掉）", merged.wire.routes.find((r) => r.provider === "(other)").uncachedInputTokens, 107);
check("合计请求 = 66", merged.wire.totals.requests, 66);
check("逐路由求和 == 合计", merged.wire.routes.reduce((acc, r) => acc + r.uncachedInputTokens, 0), merged.wire.totals.uncachedInputTokens);
check("无负值", merged.wire.routes.every((r) => r.uncachedInputTokens >= 0 && r.outputTokens >= 0), true);

console.log("14) 同一步骤内同一真实路由仍按 last-wins 替换（合并桶规则不得误伤）");
const stillReplaces = run([
  assistant(0, 0, 0, "p1", "m1", { inputTokens: 100, outputTokens: 20 }),
  assistant(1, 0, 0, "p1", "m1", { inputTokens: 100, outputTokens: 99 }),
]);
check("仍是一次请求", stillReplaces.wire.totals.requests, 1);
check("取后值", stillReplaces.wire.totals.outputTokens, 99);

console.log("");
console.log(failures === 0 ? "全部通过 ✓" : `${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
