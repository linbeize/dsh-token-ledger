/**
 * token-ledger — 按「提供方 / 模型」路由分组的全会话 Token 台账。
 *
 * 为什么需要它
 * ------------
 * 上游 `dsh-token-meter` 的两条投影回答的是「当前上下文有多满」：
 *   - `tokenUsage`     —— 全会话四个缓存桶的标量合计（不分路由）。
 *   - `contextPressure` —— 下一次请求的提示词压力与占用百分比。
 * 内置 UI 的用量气泡读的正是 `tokenUsage`，所以它只能给你一个总数：
 * 「本会话一共花了多少 token」，无法回答「换到 GLM 之后那一半花在谁身上」。
 *
 * 本插件补的是这个缺口：同一份持久日志，按 (provider, model) 分组记账。
 * 会话中途切换模型（`model/selection`）是常态，而账单是按路由开的。
 *
 * 数据来源与口径
 * --------------
 * 全部来自回放持久会话日志的纯 fold，与 token-meter 同源同口径，不做任何
 * 模型调用：
 *   - 样本：`assistant/message` 的 `data.usage`；缺失时回退到该次结算内嵌
 *     stream 的最后一个 `usage` chunk（`assistant/attempt` 走同一条回退）。
 *   - 归属：`assistant/message` 的 `message.source.provider/model`；没有消息
 *     来源的 `assistant/attempt` 回退到最近一条 `request/context` 的路由。
 *   - 替换：同一次尝试内的多次采样按 last-wins 替换（同一 turn/step/路由），
 *     `llm/retry-started` 关闭替换槽 —— 重试是真的又发了一次请求，它应当
 *     作为新增计费，而不是覆盖掉失败的那次。
 *   - 桶：`uncachedInputTokens` / `cacheReadTokens` / `cacheWriteTokens` /
 *     `outputTokens`，与 `tokenUsage` 投影逐字段同名同义，便于并排读。
 *
 * 为什么不复用 tokenUsage 再自己切分：那需要日志本身携带路由维度，而它的
 * 状态是标量合计，信息已经丢了。所以这里从事件流重新折一遍。
 *
 * 布局要求 —— 不要移动这些文件
 * ----------------------------
 * 本插件与 `web-proxy-trust` / `attachment-download` 一样，必须保留自己的
 * 目录 + 非空 `name`/`version` 的 package.json。Host 的
 * `plugin-package-inventory-deepseek` 会在每次模型请求时解析每个 active
 * entry 的归属 manifest；散放模块会向上落到 dsh 生成的
 * `profiles/web/package.json`（没有 `version`），导致每次模型请求
 * REQUEST_EXTENSION 失败。同一份 manifest 也承载 `dsh.client` 声明，
 * 浏览器半边由它被扫描到。
 *
 * 回退：删除 `cordis.patch.yml` 里的 token-ledger 行（或加
 * `config: { enabled: false }`），`patchReload=live` 保存即生效。
 */
import { z } from "zod";
import { lastAssistantStreamChunk } from "@deepseek-ai/dsh-llm";
import { GlobalLedger } from "./global.mjs";

/** 装载行 id 与插件名。 */
export const name = "token-ledger";

/** 全局台账的读取路由。 */
const ALL_LEDGER_PATH = "/api/token-ledger.all";

/**
 * 投影注册表是本插件的立足点。`commands` 不在此处硬注入：headless 组合
 * 可能没有命令面，缺它不该让整个投影失效 —— 命令走 apply 内的可选注入。
 */
export const inject = ["sessionProjections"];

/**
 * 真实路由行数上限。越过的路由全部并入唯一的合并桶，因此线上行数
 * 恒 ≤ ROUTE_LIMIT + 1 —— 状态有界，日志再长也不会让快照无限膨胀。
 */
const ROUTE_LIMIT = 64;

/** 合并桶的占位路由标识（仅在路由数溢出时出现）。 */
const OTHER_PROVIDER = "(other)";
const OTHER_MODEL = "*";

/** 路由 key：provider 与 model 之间用 NUL 分隔，两者都不含 NUL。 */
function routeKeyOf(provider, model) {
  return `${provider}\u0000${model}`;
}

/**
 * 路由 key 的展示标签。合并桶必须从 key 反推，而不是沿用第一个溢出行
 * 的真实路由名 —— 否则「并入合并桶」的账会挂在一个具体模型名下，读起来
 * 就像那个模型花了这么多，是纯粹的谎报。
 * @param key - 状态里的路由 key。
 * @returns 该行的 provider / model 标签。
 */
function labelsOf(key) {
  const separator = key.indexOf("\u0000");
  if (separator < 0) return { provider: key, model: "" };
  return { provider: key.slice(0, separator), model: key.slice(separator + 1) };
}

/** 安全非负整数判据：不安全即视为「没有这个数」，而不是当成 0。 */
function safeCount(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** 可选计数：缺席返回 undefined；在场但非法返回 null（表示样本不可用）。 */
function optionalCount(value) {
  if (value === undefined) return undefined;
  const count = safeCount(value);
  return count === undefined ? null : count;
}

/** 空桶（含请求计数）。 */
function emptyBuckets() {
  return {
    requests: 0,
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    reasoningReported: 0,
  };
}

/**
 * 把一次提供方用量样本归一成桶；任何不安全计数都让整个样本作废
 * （宁可不记，也不写脏账）。
 * @param usage - 提供方上报的用量记录。
 * @returns 桶，或 undefined 表示该样本不可用。
 */
function bucketsFromUsage(usage) {
  if (typeof usage !== "object" || usage === null) return undefined;
  const input = safeCount(usage.inputTokens);
  const output = safeCount(usage.outputTokens);
  if (input === undefined || output === undefined) return undefined;
  const cacheRead = optionalCount(usage.cacheReadTokens);
  const cacheWrite = optionalCount(usage.cacheWriteTokens);
  const reasoning = optionalCount(usage.reasoningTokens);
  if (cacheRead === null || cacheWrite === null || reasoning === null) return undefined;
  return {
    requests: 1,
    uncachedInputTokens: input,
    cacheReadTokens: cacheRead ?? 0,
    cacheWriteTokens: cacheWrite ?? 0,
    outputTokens: output,
    reasoningTokens: reasoning ?? 0,
    reasoningReported: reasoning === undefined ? 0 : 1,
  };
}

/**
 * 替换式累加：`current - previous + delta`。
 * `previous` 缺席即纯新增（请求计数 +1）。
 * @param current - 当前桶。
 * @param previous - 被替换掉的旧桶，或 undefined。
 * @param delta - 新样本桶。
 * @returns 新桶。
 */
function applyDelta(current, previous, delta) {
  const base = previous === undefined ? current : subtract(current, previous);
  return {
    requests: base.requests + delta.requests,
    uncachedInputTokens: base.uncachedInputTokens + delta.uncachedInputTokens,
    cacheReadTokens: base.cacheReadTokens + delta.cacheReadTokens,
    cacheWriteTokens: base.cacheWriteTokens + delta.cacheWriteTokens,
    outputTokens: base.outputTokens + delta.outputTokens,
    reasoningTokens: base.reasoningTokens + delta.reasoningTokens,
    reasoningReported: base.reasoningReported + delta.reasoningReported,
  };
}

/** 逐字段相减；调用方保证不会减出负数（减的是同一份已计入的桶）。 */
function subtract(current, other) {
  return {
    requests: current.requests - other.requests,
    uncachedInputTokens: current.uncachedInputTokens - other.uncachedInputTokens,
    cacheReadTokens: current.cacheReadTokens - other.cacheReadTokens,
    cacheWriteTokens: current.cacheWriteTokens - other.cacheWriteTokens,
    outputTokens: current.outputTokens - other.outputTokens,
    reasoningTokens: current.reasoningTokens - other.reasoningTokens,
    reasoningReported: current.reasoningReported - other.reasoningReported,
  };
}

/** 读取一条助手消息的模型路由；非模型来源返回 undefined。 */
function modelRouteOf(source) {
  if (typeof source !== "object" || source === null || source.kind !== "model") return undefined;
  const provider = typeof source.provider === "string" ? source.provider : "";
  const model = typeof source.model === "string" ? source.model : "";
  if (provider === "" || model === "") return undefined;
  return { provider, model };
}

/**
 * 取一个事件携带的用量样本（含路由归属候选）。
 * `assistant/message` 优先用消息自带的 `usage`，否则与 `assistant/attempt`
 * 一样读内嵌 stream 的最后一个 usage chunk。
 * @param event - 已提交的会话事件。
 * @returns 样本，或 undefined 表示该事件不携带用量。
 */
function sampleOf(event) {
  if (event.type !== "assistant/message" && event.type !== "assistant/attempt") return undefined;
  const inline = event.type === "assistant/message" ? event.data.usage : undefined;
  const usage = inline ?? lastAssistantStreamChunk(event.data.stream, "usage")?.usage;
  if (usage === undefined) return undefined;
  const route = event.type === "assistant/message" ? modelRouteOf(event.data.message.source) : undefined;
  return { usage, route };
}

/** 桶状态字段表（state 与 wire 共用一份形状描述）。 */
function bucketFields() {
  return {
    requests: z.number().int().nonnegative(),
    uncachedInputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative(),
    reasoningReported: z.number().int().nonnegative(),
  };
}

/** 持久化状态：路由账 + 合计 + 归属提示 + 替换槽。 */
const ledgerStateSchema = z.strictObject({
  routes: z.record(
    z.string(),
    z.strictObject({ provider: z.string().min(1), model: z.string().min(1), ...bucketFields() }),
  ),
  totals: z.strictObject(bucketFields()),
  /** 最近一条 `request/context` 的路由，供无来源的 attempt 归属。 */
  route: z
    .strictObject({ provider: z.string().min(1), model: z.string().min(1) })
    .nullable(),
  /** 替换槽：同一 turn/step/路由 的后续样本替换它，而不是累加。 */
  last: z
    .strictObject({
      turn: z.number().int().nonnegative(),
      step: z.number().int().nonnegative(),
      key: z.string(),
      buckets: z.strictObject(bucketFields()),
    })
    .nullable(),
});

/** 客户端可见桶：`reasoningTokens` 仅在每次请求都上报时才出现。 */
function wireBucketFields() {
  return {
    requests: z.number().int().nonnegative(),
    uncachedInputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative().optional(),
  };
}

const ledgerWireSchema = z.strictObject({
  routes: z.array(
    z.strictObject({ provider: z.string().min(1), model: z.string().min(1), ...wireBucketFields() }),
  ),
  totals: z.strictObject(wireBucketFields()),
});

/**
 * 把内部桶压成线上值。`reasoningReported` 是内部对账字段，不外发；
 * 只有它等于请求数（即每次请求都报过）时才给出推理 token —— 参差不齐的
 * 合计会被读成精确值，那是在说谎。
 */
function toWireBucket(entry) {
  const wired = {
    requests: entry.requests,
    uncachedInputTokens: entry.uncachedInputTokens,
    cacheReadTokens: entry.cacheReadTokens,
    cacheWriteTokens: entry.cacheWriteTokens,
    outputTokens: entry.outputTokens,
  };
  if (entry.requests > 0 && entry.reasoningReported === entry.requests) {
    wired.reasoningTokens = entry.reasoningTokens;
  }
  return wired;
}

/**
 * 桶的「已计费总量」：四个桶之和（推理是输出的子集，不重复计）。
 *
 * 客户端半边有一份同名同义的实现 —— 两处必须逐字对齐，否则命令行与面板
 * 会给出两个不同的「合计」，而用户没有任何办法判断哪个对。
 */
function billedTotal(bucket) {
  return (
    bucket.uncachedInputTokens + bucket.cacheReadTokens + bucket.cacheWriteTokens + bucket.outputTokens
  );
}

/**
 * `tokenLedger` 投影单元。
 *
 * 纯 fold：不关心的返回同引用（零下游工作），关心的返回新对象。
 * 状态是纯 JSON，因此可被投影缓存持久化。
 */
export const tokenLedgerProjectionDefinition = {
  key: "tokenLedger",
  stateVersion: 1,
  stateSchema: ledgerStateSchema,
  init: () => ({
    routes: {},
    totals: emptyBuckets(),
    route: null,
    last: null,
  }),
  apply: (state, event) => {
    if (event.type === "llm/retry-started") {
      const last = state.last;
      if (last === null || last.turn !== event.data.turn || last.step !== event.data.step) return state;
      return { ...state, last: null };
    }
    if (event.type === "request/context") {
      const provider = event.data.provider;
      const model = event.data.model;
      if (state.route !== null && state.route.provider === provider && state.route.model === model) {
        return state;
      }
      return { ...state, route: { provider, model } };
    }

    const sample = sampleOf(event);
    if (sample === undefined) return state;
    const buckets = bucketsFromUsage(sample.usage);
    if (buckets === undefined) return state;
    const route = sample.route ?? state.route;
    // 归属不了就不记账：宁缺一个数，也不把它塞给错误的路由。
    if (route === undefined || route === null) return state;

    const key = resolveKey(state.routes, route.provider, route.model);
    const label = labelsOf(key);
    const entry = state.routes[key];
    const { turn, step } = event.data;
    // 替换槽只在「同一步骤 + 同一路由 key」时命中。合并桶必须排除在外：
    // 多条真实路由共享 `(other)` 这一个 key，若让它们互相替换，后来的样本
    // 会减掉别条路由已经计过的账，合计当场变负。
    const sameRoute = label.provider !== OTHER_PROVIDER || label.model !== OTHER_MODEL;
    const previous =
      sameRoute &&
      state.last !== null &&
      state.last.turn === turn &&
      state.last.step === step &&
      state.last.key === key
        ? state.last.buckets
        : undefined;

    const current = entry ?? emptyBuckets();
    const next = applyDelta(current, previous, buckets);
    const routes = { ...state.routes, [key]: { provider: label.provider, model: label.model, ...next } };
    const totals = applyDelta(state.totals, previous, buckets);
    // 合并桶不进替换槽，因此它的下一个样本按新增计，不会误替。
    const nextLast = sameRoute ? { turn, step, key, buckets } : state.last;
    return { ...state, routes, totals, last: nextLast };
  },
  wire: {
    viewSchema: ledgerWireSchema,
    view: (state) => {
      // 稳定输出：总量降序，同量按 (provider, model) 升序，让同一份日志
      // 永远得到同一种顺序 —— 客户端可以直接逐行 diff。
      const ordered = Object.entries(state.routes).sort(([, left], [, right]) => {
        const delta = billedTotal(right) - billedTotal(left);
        if (delta !== 0) return delta;
        return routeKeyOf(left.provider, left.model) < routeKeyOf(right.provider, right.model) ? -1 : 1;
      });
      return {
        routes: ordered.map(([, entry]) => ({
          provider: entry.provider,
          model: entry.model,
          ...toWireBucket(entry),
        })),
        totals: toWireBucket(state.totals),
      };
    },
  },
};

/**
 * 解析路由落到哪一行：路由表未满时是新行，满了并入合并桶。
 * @param routes - 当前路由表。
 * @param provider - 提供方 id。
 * @param model - 模型 id。
 * @returns 路由 key。
 */
function resolveKey(routes, provider, model) {
  const key = routeKeyOf(provider, model);
  if (Object.hasOwn(routes, key)) return key;
  if (Object.keys(routes).length < ROUTE_LIMIT) return key;
  return routeKeyOf(OTHER_PROVIDER, OTHER_MODEL);
}

/** 千分位整数（不加本地化，保证日志/终端逐字节稳定）。 */
function groupDigits(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}

/** 缓存命中率：缓存读占提示侧三桶的比例；没有提示流量时为 null。 */
function cacheHitPercent(bucket) {
  const prompt =
    bucket.uncachedInputTokens + bucket.cacheReadTokens + bucket.cacheWriteTokens;
  if (prompt === 0) return null;
  return Math.round((bucket.cacheReadTokens / prompt) * 1000) / 10;
}

/** 一行桶的文本摘要（不含总量 —— 总量由调用方各自以合适的口径给出）。 */
function describeBucket(bucket) {
  const parts = [
    `请求 ${groupDigits(bucket.requests)}`,
    `未缓存输入 ${groupDigits(bucket.uncachedInputTokens)}`,
    `缓存读 ${groupDigits(bucket.cacheReadTokens)}`,
    `缓存写 ${groupDigits(bucket.cacheWriteTokens)}`,
    `输出 ${groupDigits(bucket.outputTokens)}`,
  ];
  if (bucket.reasoningTokens !== undefined) {
    parts.push(`其中推理 ${groupDigits(bucket.reasoningTokens)}`);
  }
  return parts.join(" · ");
}

/**
 * 把一个会话的完整事件流折成投影状态。
 *
 * 全局台账复用这一个函数，而不是自己重写一套 fold —— 口径同源，单会话与
 * 全局账才不可能对不上。
 * @param events - 该会话的完整事件序列。
 * @returns 投影状态（`routes` + `totals` + 归属提示 + 替换槽）。
 */
export function foldSessionState(events) {
  let state = tokenLedgerProjectionDefinition.init();
  for (const event of events) state = tokenLedgerProjectionDefinition.apply(state, event);
  return state;
}

/** JSON 响应助手。 */
function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * 全局台账路由的响应。
 *
 * 永不阻塞：`snapshot()` 是纯内存读，随时立即返回。只有显式带 `refresh=1`
 * 时才在后台推进一轮增量折叠 —— 冷启动 6 秒，不能塞进请求路径里等。
 * @param ctx - 宿主上下文。
 * @param globals - 全局台账服务。
 * @param request - 已鉴权的路由请求。
 * @returns JSON 快照。
 */
async function globalLedgerResponse(ctx, globals, request) {
  const url = new URL(request.url);
  if (url.searchParams.get("refresh") === "1") {
    // 不 await：本轮的刷新在后台跑，本次响应仍返回当前已知值。
    void globals.refresh(foldSessionState).catch(() => {});
  }
  return json(globals.snapshot(), 200);
}

/**
 * 渲染 `/tokens` 的人类可读台账。
 * @param ctx - 承载投影注册表的宿主上下文。
 * @param session - 命令接收方的实时会话。
 * @param rawInput - 命令名之后的原文（`all` / `json`）。
 * @param globals - 全局台账服务；缺省时 `all` 不可用。
 * @returns 命令结果。
 */
function renderLedgerCommand(ctx, session, rawInput, globals) {
  const args = rawInput.trim().toLowerCase().split(/\s+/u).filter((part) => part !== "");
  const wantsAll = args.includes("all");
  const wantsJson = args.includes("json");

  if (wantsAll) {
    if (globals === undefined) return { kind: "error", text: "全局台账未启用。" };
    const snapshot = globals.snapshot();
    if (wantsJson) return { kind: "success", text: JSON.stringify(snapshot, null, 2) };
    return { kind: "success", text: renderGlobalText(snapshot) };
  }

  const state = ctx.sessionProjections.stateOf(session, "tokenLedger");
  if (state === undefined) {
    return { kind: "error", text: "token-ledger 投影未注册（插件未启用或已被卸载）。" };
  }
  const wire = ledgerWireSchema.parse(tokenLedgerProjectionDefinition.wire.view(state));
  if (wantsJson) {
    return { kind: "success", text: JSON.stringify(wire, null, 2) };
  }

  const lines = [`Token 台账 · ${session.id}`];
  if (wire.routes.length === 0) {
    lines.push("", "本会话还没有任何提供方用量样本。");
  } else {
    // 总量单独一行给足强调，且与逐路由行不撞词；下面是四桶全拆。
    lines.push(
      "",
      `本会话合计  ${groupDigits(billedTotal(wire.totals))}`,
      `  ${describeBucket(wire.totals)}`,
    );
    const hit = cacheHitPercent(wire.totals);
    if (hit !== null) {
      const prompt =
        wire.totals.uncachedInputTokens + wire.totals.cacheReadTokens + wire.totals.cacheWriteTokens;
      lines.push(`  缓存命中率 ${hit}%（缓存读 ${groupDigits(wire.totals.cacheReadTokens)} / 提示 ${groupDigits(prompt)}）`);
    }
    lines.push("", `按路由（${wire.routes.length} 条）`);
    for (const route of wire.routes) {
      const routeTotal = billedTotal(route);
      const share = (routeTotal / Math.max(1, billedTotal(wire.totals))) * 100;
      lines.push(
        `  ${route.provider} / ${route.model}  —  ${share.toFixed(1)}%  ·  ${groupDigits(routeTotal)}`,
        `    ${describeBucket(route)}`,
      );
    }
    if (wire.routes.length >= ROUTE_LIMIT) {
      lines.push("", `注：路由数已达上限 ${ROUTE_LIMIT}，更早的少数路由已并入 ${OTHER_PROVIDER} / ${OTHER_MODEL}。`);
    }
  }

  // 实时压力与台账是两回事：台账是账（已花掉多少），压力是「下一次请求要
  // 花多少」。压力只有会话级概念，全局账里没有对应物。
  const meter = ctx.get("tokenMeter");
  if (meter !== undefined) {
    try {
      const measurement = meter.measure(session);
      lines.push(
        "",
        `当前压力  ${groupDigits(measurement.totalTokens)} token（表面 ${groupDigits(measurement.surfaceTokens)}，基线 ${measurement.baseline.kind}）`,
      );
    } catch {
      // 压力读数失败不影响台账本身：账已经算完。
    }
  }
  lines.push("", "（全部历史累计：/tokens all）");
  return { kind: "success", text: lines.join("\n") };
}

/**
 * 全局台账的文本渲染。
 * @param snapshot - 全局快照。
 * @returns 多行文本。
 */
function renderGlobalText(snapshot) {
  const lines = ["Token 台账 · 全部历史", ""];
  if (snapshot.sessions === 0 && snapshot.completedAt === null) {
    lines.push("尚未完成首次折叠，稍后再试（冷折叠约需数秒）。");
    if (snapshot.error !== null) lines.push(`错误：${snapshot.error}`);
    return lines.join("\n");
  }
  lines.push(
    `全部会话合计  ${groupDigits(billedTotal(snapshot.totals))}`,
    `  ${describeBucket(snapshot.totals)}`,
    `  会话数 ${snapshot.sessions}`,
  );
  const hit = cacheHitPercent(snapshot.totals);
  if (hit !== null) {
    const prompt =
      snapshot.totals.uncachedInputTokens +
      snapshot.totals.cacheReadTokens +
      snapshot.totals.cacheWriteTokens;
    lines.push(`  缓存命中率 ${hit}%（缓存读 ${groupDigits(snapshot.totals.cacheReadTokens)} / 提示 ${groupDigits(prompt)}）`);
  }
  lines.push("", `按路由（${snapshot.routes.length} 条）`);
  for (const route of snapshot.routes) {
    const routeTotal = billedTotal(route);
    const share = (routeTotal / Math.max(1, billedTotal(snapshot.totals))) * 100;
    lines.push(
      `  ${route.provider} / ${route.model}  —  ${share.toFixed(1)}%  ·  ${groupDigits(routeTotal)}`,
      `    ${describeBucket(route)}`,
    );
  }
  if (snapshot.stale) lines.push("", "（正在后台刷新，当前为上一轮结果）");
  if (snapshot.error !== null) lines.push("", `注：${snapshot.error}`);
  return lines.join("\n");
}

/**
 * 注册投影单元、全局台账路由与 `/tokens` 命令。
 * @param ctx - web profile 宿主上下文。
 * @param config - 装载行的可选 `{ enabled?: boolean }`。
 */
export function apply(ctx, config) {
  if (config?.enabled === false) return;
  ctx.sessionProjections.register(tokenLedgerProjectionDefinition);

  // 命令是可选的：没有命令面的组合照样拥有台账投影。
  ctx.inject(["commands"], (commandCtx) => {
    commandCtx.commands.register({
      name: "tokens",
      description: "按模型路由查看 Token 台账：/tokens 本会话，/tokens all 全部历史，加 json 输出原始数据",
      input: { hint: "[all] [json]" },
      handler: (invocation) =>
        renderLedgerCommand(ctx, invocation.agent.session, invocation.rawInput, globals),
    });
  });

  // ── 全局台账（跨 workspace 全部历史）────────────────────────────────
  // 走独立 HTTP 路由而不是投影系统：投影按 Session 隔离，装不下「所有会
  // 话之和」。浏览器半轮询这个路由。
  const globals = new GlobalLedger(ctx);
  ctx.inject(["connection"], (connectionCtx) => {
    connectionCtx.connection.fetch.register({
      path: ALL_LEDGER_PATH,
      methods: ["GET"],
      requestBody: "buffered",
      fetch: (request) => globalLedgerResponse(ctx, globals, request),
    });
  });

  // 首次折叠：延迟一小会儿再开跑，让进程先完成启动期工作。
  // 失败只是让面板显示 stale，不影响宿主。
  const timer = setTimeout(() => {
    void globals.refresh(foldSessionState).catch(() => {});
  }, 3000);
  if (typeof timer.unref === "function") timer.unref();
}
