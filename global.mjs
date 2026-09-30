/**
 * token-ledger 的全局台账：跨所有 workspace、所有会话的累计。
 *
 * 为什么不在投影系统里做
 * ----------------------
 * `sessionProjections` 是按 Session 实例隔离的（每个 unit 对每个 Session 持
 * 一份 cell）。「所有会话的总量」不是任何一个 Session 的属性，所以它天然
 * 不属于投影系统。这里走独立通道：宿主侧周期性折叠 + 一条 HTTP 路由，浏览器
 * 半轮询。
 *
 * 代价与取舍
 * ----------
 * 实测本机 77 个可读会话 / 约 99K 事件 / 323MB 解压后 JSON，全量冷折叠约
 * 6.5 秒。这个数字决定了设计：
 *
 *   1. **必须缓存**。绝不能每次请求重折。
 *   2. **必须增量**。`sessionPersistence.list()` 给出的 `revision` 是判据：
 *      只有 revision 变化的会话才重折，其余直接复用上一轮的路由账。
 *   3. **必须可取消 + 有界**。折叠在后台跑，失败不拖垮宿主；上一轮还在跑
 *      时新请求直接复用旧结果，不排队堆积。
 *
 * 口径与单会话台账**逐字一致**：同一个 `tokenLedgerProjectionDefinition.apply`
 * 折出的每个会话路由账，在这里按路由相加。差异只有一处，且是刻意的：全局
 * 账没有 `ROUTE_LIMIT` 溢出桶 —— 单会话溢出是「防快照膨胀」，全局账本来就
 * 是人类要看的全貌，路由种类再多也必须逐条列出。
 */

/** 全局折叠的并发上限：避免一次性打满磁盘 IO。 */
const FOLD_CONCURRENCY = 4;

/**
 * 空桶。字段与单会话台账完全同名 —— 两处必须能直接相加。
 * @returns 零值桶。
 */
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

/** 两个桶逐字段相加。 */
function addBuckets(left, right) {
  return {
    requests: left.requests + right.requests,
    uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    reasoningReported: left.reasoningReported + right.reasoningReported,
  };
}

/**
 * 把一个会话的投影状态并进全局路由表。
 *
 * 直接复用单会话 unit 的状态形状（`routes` + `totals`），因此口径不可能
 * 漂移：全局账就是「每个会话各自的账相加」。推理 token 的对账字段
 * `reasoningReported` 也一并相加，于是「是否每个请求都报了推理」这个判据
 * 在全局层面依然成立。
 * @param into - 累积中的全局路由表（原地修改）。
 * @param state - 一个会话折出的投影状态。
 */
function mergeSessionState(into, state) {
  for (const [key, entry] of Object.entries(state.routes)) {
    const current = into.get(key) ?? { provider: entry.provider, model: entry.model, ...emptyBuckets() };
    into.set(key, {
      provider: current.provider,
      model: current.model,
      ...addBuckets(current, entry),
    });
  }
}

/**
 * 全局台账服务：增量折叠 + 结果缓存。
 *
 * 生命周期由插件 fiber 拥有。`snapshot()` 永远立即返回（可能返回上一轮
 * 结果），`refresh()` 在后台推进。这个「永不等」的取舍是刻意的：面板轮询
 * 不该被 6 秒的冷折叠阻塞，第一次请求拿到 `stale: true` 也远比转圈强。
 */
export class GlobalLedger {
  /**
   * @param ctx - 宿主上下文（惰性读取 sessionPersistence / sessionQuery）。
   */
  constructor(ctx) {
    this.ctx = ctx;
    /** 每个会话折出的路由账，键为 sessionId → { routes: Map, ... }。 */
    this.perSession = new Map();
    /** 每个会话折叠时用的 revision，用于判断是否需要重折。 */
    this.revisions = new Map();
    /** 最近一次成功折叠的完成时间。 */
    this.completedAt = null;
    /** 最近一次折叠的失败计数与最后一条错误，供面板如实显示。 */
    this.lastError = null;
    /** 是否有一轮折叠在进行中。 */
    this.running = false;
    /** 累计折叠过的会话数（含重折），仅用于诊断。 */
    this.foldCount = 0;
  }

  /**
   * 当前已知的全局台账。立即返回，不做 IO。
   * @returns 快照；从未折叠过时 `total` 为零且 `stale` 为 true。
   */
  snapshot() {
    const routes = new Map();
    for (const state of this.perSession.values()) mergeSessionState(routes, state);
    let totals = emptyBuckets();
    for (const entry of routes.values()) totals = addBuckets(totals, entry);

    // 稳定排序：总量降序，同量按 provider/model 升序（与单会话台账同规则）。
    const ordered = [...routes.entries()].sort(([, left], [, right]) => {
      const delta = billedOf(right) - billedOf(left);
      if (delta !== 0) return delta;
      return `${left.provider}/${left.model}` < `${right.provider}/${right.model}` ? -1 : 1;
    });

    return {
      sessions: this.perSession.size,
      routes: ordered.map(([, entry]) => ({
        provider: entry.provider,
        model: entry.model,
        requests: entry.requests,
        uncachedInputTokens: entry.uncachedInputTokens,
        cacheReadTokens: entry.cacheReadTokens,
        cacheWriteTokens: entry.cacheWriteTokens,
        outputTokens: entry.outputTokens,
        ...(entry.requests > 0 && entry.reasoningReported === entry.requests
          ? { reasoningTokens: entry.reasoningTokens }
          : {}),
      })),
      totals: {
        requests: totals.requests,
        uncachedInputTokens: totals.uncachedInputTokens,
        cacheReadTokens: totals.cacheReadTokens,
        cacheWriteTokens: totals.cacheWriteTokens,
        outputTokens: totals.outputTokens,
        ...(totals.requests > 0 && totals.reasoningReported === totals.requests
          ? { reasoningTokens: totals.reasoningTokens }
          : {}),
      },
      completedAt: this.completedAt,
      stale: this.running || this.completedAt === null,
      error: this.lastError,
      folds: this.foldCount,
    };
  }

  /**
   * 推进一轮增量折叠。已有轮次在跑时立即返回（不排队）。
   * @param foldSession - 把一个会话的事件折成投影状态的函数。
   * @returns 本轮是否真的跑了。
   */
  async refresh(foldSession) {
    if (this.running) return false;
    const persistence = this.ctx.get("sessionPersistence");
    const query = this.ctx.get("sessionQuery");
    if (persistence === undefined || query === undefined) {
      this.lastError = "sessionPersistence 或 sessionQuery 未挂载，无法枚举历史会话。";
      return false;
    }
    this.running = true;
    try {
      const snapshots = await persistence.list();
      // 变化的会话：revision 与上轮不同，或是本轮新出现的。
      const changed = snapshots.filter((snap) => {
        const id = snap.header.id;
        return this.revisions.get(id) !== snap.revision;
      });

      // 后台按小并发折，避免一次性打满磁盘。
      const queue = [...changed];
      const worker = async () => {
        while (queue.length > 0) {
          const snap = queue.shift();
          if (snap === undefined) return;
          try {
            const log = await query.readSession(snap.header.id);
            // 复用单会话单元的 fold：口径同源，不可能漂移。
            let state = foldSession(log.events);
            this.perSession.set(snap.header.id, state);
            this.revisions.set(snap.header.id, snap.revision);
            this.foldCount += 1;
          } catch (error) {
            // 单个会话读不出来不拖垮整轮：跳过它，但记下最后一次错误。
            this.lastError = `会话 ${snap.header.id} 折叠失败：${error instanceof Error ? error.message : String(error)}`;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(FOLD_CONCURRENCY, queue.length) }, worker));

      // 清理已消失的会话（被删除/归档），否则账会永远多算它。
      const liveIds = new Set(snapshots.map((snap) => snap.header.id));
      for (const id of [...this.perSession.keys()]) {
        if (!liveIds.has(id)) {
          this.perSession.delete(id);
          this.revisions.delete(id);
        }
      }
      this.completedAt = new Date().toISOString();
      if (changed.length === 0) this.lastError = null;
      return true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      this.running = false;
    }
  }
}

/** 桶的已计费总量（四个互不重叠的桶之和）。 */
function billedOf(bucket) {
  return (
    bucket.uncachedInputTokens + bucket.cacheReadTokens + bucket.cacheWriteTokens + bucket.outputTokens
  );
}
