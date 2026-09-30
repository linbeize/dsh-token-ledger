/**
 * token-ledger — 浏览器半边。
 *
 * 在会话头右侧的 utilities 座位挂一个按钮：点开是本会话按模型路由分组的
 * Token 台账。数据不来自 HTTP 轮询，而来自 Host 投影单元 `tokenLedger`：
 *
 *   - Host 半边 `index.mjs` 注册该投影单元，`stateVersion: 1`；
 *   - `dsh-api-session-controller` 的 `SessionControlController` 把每个
 *     key 的变化作为 control 帧推进浏览器（`onChanged` → `broadcast`），
 *     并在连接 baseline 里带一份快照；
 *   - 浏览器侧 `ProjectionValueStore` 按「seq 高者胜」合并，键缺失即
 *     `undefined`（表示能力缺席）；
 *   - 会话作用域座位自动带 `useProjection` 标准 hook（`ui-session` 的
 *     BUILTIN_SOURCE 声明 `keyedHooks: ["projection"]`），所以本组件只要
 *     声明座位就能拿到它，不需要自己订阅任何通道。
 *
 * 组件只读投影，不产生任何 HTTP 请求，也不写会话日志。
 *
 * 为什么手写工厂形式：本插件住在 profile 目录，而不是跑 tsdown 的包。
 * 它只 require 平台种子表里的模块（`react`、`react/jsx-runtime`、
 * `@deepseek-ai/dsh-client-ui-primitives`），因此不需要 `dsh.client.external`
 * 边，也就不会与构建产物漂移。
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-token-ledger",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react = require("react");
    var jsxRuntime = require("react/jsx-runtime");
    var primitives = require("@deepseek-ai/dsh-client-ui-primitives");

    var h = jsxRuntime.jsx;
    var hs = jsxRuntime.jsxs;
    var useState = react.useState;
    var useEffect = react.useEffect;
    var useCallback = react.useCallback;
    var useMemo = react.useMemo;
    var useRef = react.useRef;

    //#region styles
    var CSS = [
      ".tl_button{width:28px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:28px;flex:none;justify-content:center;align-items:center;padding:6px;display:inline-flex}",
      ".tl_button:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".tl_button svg{width:15px;height:15px}",
      ".tl_root{display:inline-flex;position:relative}",
      ".tl_panel{z-index:100;box-sizing:border-box;background:var(--dsw-specific-menu);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);width:400px;max-width:92vw;box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;border-radius:12px;padding:12px;font-size:12px;line-height:20px;position:absolute;top:calc(100% + 8px);right:0;display:flex;flex-direction:column;max-height:min(70vh,640px)}",
      ".tl_scroll{overflow-y:auto;overscroll-behavior:contain;min-height:0;margin:0 -12px;padding:0 12px}",
      ".tl_fixed{flex:none}",
      ".tl_divider{background:var(--dsw-alias-border-l2,#0000001f);height:1px;margin:12px 0 0}",
      ".tl_global{box-sizing:border-box;background:var(--dsw-specific-input-major,transparent);border:.5px solid var(--dsw-alias-border-l2,#0000001f);border-radius:12px;margin-top:10px;padding:10px 12px;flex:none;max-height:42vh;overflow-y:auto;overscroll-behavior:contain}",
      ".tl_globalHead{align-items:baseline;gap:6px;display:flex}",
      ".tl_globalLabel{color:var(--dsw-alias-label-primary);font-weight:600}",
      ".tl_badge{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;font-size:10px;line-height:14px;padding:1px 6px;flex:none}",
      ".tl_globalFoot{align-items:baseline;gap:10px;display:flex;margin-top:6px}",
      ".tl_meta{color:var(--dsw-alias-label-tertiary)}",
      ".tl_linkButton{color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:0;padding:0;font:inherit;flex:none;margin-left:auto}",
      ".tl_linkButton:hover{color:var(--dsw-alias-label-primary);text-decoration:underline}",
      ".tl_rowsCompact{gap:2px;margin-top:8px}",
      ".tl_routeLine{align-items:baseline;gap:6px;display:flex;min-width:0;padding:1px 0}",
      ".tl_lineTotal{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);flex:none}",
      ".tl_noteWarn{color:var(--dsw-alias-label-tertiary);font-size:11px}",
      ".tl_head{align-items:baseline;gap:6px;display:flex}",
      ".tl_title{color:var(--dsw-alias-label-primary);font-weight:600}",
      ".tl_subtitle{color:var(--dsw-alias-label-tertiary)}",
      ".tl_sectionLabel{color:var(--dsw-alias-label-tertiary);font-size:11px;margin:12px 0 6px;text-transform:uppercase;letter-spacing:.04em}",
      ".tl_card{box-sizing:border-box;background:var(--dsw-specific-input-major,transparent);border:.5px solid var(--dsw-alias-border-l2,#0000001f);border-radius:12px;margin-top:10px;padding:10px 12px}",
      ".tl_cardHead{align-items:baseline;gap:6px;display:flex}",
      ".tl_cardLabel{color:var(--dsw-alias-label-secondary)}",
      ".tl_cardTotal{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);margin-left:auto;font-size:18px;font-weight:600;line-height:24px}",
      ".tl_rows{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:10px}",
      ".tl_row{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2,#0000001f);border-radius:12px;padding:8px 10px}",
      ".tl_route{align-items:baseline;gap:6px;display:flex}",
      ".tl_provider{color:var(--dsw-alias-label-primary);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".tl_model{color:var(--dsw-alias-label-tertiary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".tl_share{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);margin-left:auto;flex:none}",
      ".tl_bar{background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;gap:1px;height:4px;margin:8px 0;display:flex;overflow:hidden}",
      ".tl_seg{border-radius:1px;flex:none;min-width:1px;height:100%}",
      ".tl_segInput{background:var(--dsw-static-neutral-bluish-400)}",
      ".tl_segCacheRead{background:var(--dsw-static-blue-450)}",
      ".tl_segCacheWrite{background:#a78bfa}",
      ".tl_segOutput{background:var(--dsw-alias-state-success-primary,#12b76a)}",
      ".tl_facts{margin:0;display:grid;grid-template-columns:auto 1fr;gap:2px 10px}",
      ".tl_facts dt{color:var(--dsw-alias-label-tertiary)}",
      ".tl_facts dd{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);margin:0;text-align:right}",
      ".tl_note{color:var(--dsw-alias-label-tertiary);font-size:12px;padding:6px 2px;margin:0}",
      ".tl_legend{color:var(--dsw-alias-label-tertiary);font-size:11px;margin:8px 0 0;display:flex;flex-wrap:wrap;gap:10px}",
      ".tl_legendItem{align-items:center;gap:4px;display:inline-flex}",
      ".tl_swatch{border-radius:2px;width:8px;height:8px;display:inline-block}",
    ].join("");

    var TAG_ID = "dsh-plugin-token-ledger/index.css";
    if (
      typeof document !== "undefined" &&
      document.querySelector("style[data-plugin-css=" + JSON.stringify(TAG_ID) + "]") === null
    ) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-plugin-token-ledger";
      tag.dataset.pluginCss = TAG_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }
    //#endregion

    //#region 口径
    /** 台账的四个互不重叠的桶（推理是输出的子集，不计入合计）。 */
    var BUCKETS = [
      { key: "uncachedInputTokens", label: "input", className: "tl_segInput" },
      { key: "cacheReadTokens", label: "cacheRead", className: "tl_segCacheRead" },
      { key: "cacheWriteTokens", label: "cacheWrite", className: "tl_segCacheWrite" },
      { key: "outputTokens", label: "output", className: "tl_segOutput" },
    ];

    /**
     * 已计费总量：四个互不重叠的桶求和。
     * @param bucket - 一条路由或合计的桶。
     * @returns 合计 token。
     */
    function billedTotal(bucket) {
      var total = 0;
      for (var index = 0; index < BUCKETS.length; index += 1) {
        total += bucket[BUCKETS[index].key] || 0;
      }
      return total;
    }

    /**
     * 精确计数，带千分位。
     *
     * 台账只给逐位读数，不做 K / M 缩略：这是账，不是仪表盘装饰。
     * 46,010,512 与 46.0M 之间的差别，正是这个面板存在的理由。
     * @param value - token 数。
     * @returns 逐位显示文本。
     */
    function formatExact(value) {
      return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    }

    /** 全局台账的读取路由（宿主半边注册）。 */
    var ALL_LEDGER_PATH = "/api/token-ledger.all";

    /**
     * 同源基准。非浏览器上下文（`origin === "null"`）下退到一个内部占位，
     * 与宿主其它插件一致 —— 那种场景下请求本就发不出去。
     * @returns 绝对 origin 或内部占位。
     */
    function hostBase() {
      var origin = globalThis.location && globalThis.location.origin;
      return origin !== undefined && origin !== "null" ? origin : "http://dsh.internal";
    }

    /** 全局折叠仍在进行时的重试间隔。 */
    var GLOBAL_RETRY_MS = 4000;

    /** 单次打开最多追赶几轮，避免面板开着时无限轮询。 */
    var GLOBAL_MAX_RETRIES = 6;

    /**
     * 读取跨会话的全局台账。
     *
     * 宿主侧是「立即返回 + 后台增量折叠」：冷折叠要几秒，绝不能塞进请求
     * 路径里等。所以这里拿到的可能是 `stale: true` 的上一轮结果 —— 那就
     * 隔几秒再追一次，追上就停。打开面板时先带 `refresh=1` 催一轮。
     *
     * 路由不存在（插件 host 半没挂上）时返回 `null`，面板据此整块隐藏而
     * 不是显示一个假的零。
     * @param sessionId - 当前会话 id，仅用于触发重渲染。
     * @param open - 面板是否打开；关闭时不发请求。
     * @returns `{ state, reload }`，state 为 null 表示能力缺席。
     */
    function useGlobalLedger(sessionId, open) {
      var [state, setState] = useState({ phase: "idle" });
      var [nonce, setNonce] = useState(0);
      var retriesRef = useRef(0);

      useEffect(
        function () {
          if (!open) return undefined;
          var controller = new AbortController();
          var live = true;
          var timer = null;

          var load = function (urge) {
            var url = new URL(ALL_LEDGER_PATH, hostBase());
            // 首轮与手动刷新时催宿主推进一轮增量折叠；后续轮询只取结果。
            if (urge === true) url.searchParams.set("refresh", "1");
            fetch(url.toString(), {
              method: "GET",
              signal: controller.signal,
              credentials: "same-origin",
              headers: { accept: "application/json" },
            })
              .then(function (response) {
                if (response.status === 404) return null;
                if (!response.ok) throw new Error("HTTP " + String(response.status));
                return response.json();
              })
              .then(function (body) {
                if (!live) return;
                if (body === null) {
                  setState({ phase: "absent" });
                  return;
                }
                setState({ phase: "ready", value: body });
                // 还在折叠就再追一轮；追上或超过上限就停。
                if (body.stale === true && retriesRef.current < GLOBAL_MAX_RETRIES) {
                  retriesRef.current += 1;
                  timer = setTimeout(function () {
                    if (live) load(false);
                  }, GLOBAL_RETRY_MS);
                }
              })
              .catch(function (error) {
                if (!live || controller.signal.aborted) return;
                setState({ phase: "error", error: error instanceof Error ? error.message : String(error) });
              });
          };

          retriesRef.current = 0;
          load(true);

          return function () {
            live = false;
            if (timer !== null) clearTimeout(timer);
            controller.abort();
          };
        },
        [open, sessionId, nonce],
      );

      var reload = useCallback(function () {
        retriesRef.current = 0;
        setNonce(function (value) {
          return value + 1;
        });
      }, []);

      return { state: state, reload: reload };
    }

    /**
     * 缓存命中率：缓存读占提示侧三桶的比例。
     * @param bucket - 桶。
     * @returns 百分数字符串，或 null 表示没有提示流量。
     */
    function cacheHitPercent(bucket) {
      var prompt =
        (bucket.uncachedInputTokens || 0) + (bucket.cacheReadTokens || 0) + (bucket.cacheWriteTokens || 0);
      if (prompt === 0) return null;
      return String(Math.round(((bucket.cacheReadTokens || 0) / prompt) * 1000) / 10);
    }

    /**
     * 纯文本兜底渲染，供按钮 tooltip 使用。
     * @param ledger - 台账值。
     * @param t - 本地化函数。
     * @returns 多行文本。
     */
    function plainText(ledger, t) {
      if (ledger === undefined) return "";
      var lines = [t("dialog.title") + " · " + formatExact(billedTotal(ledger.totals))];
      for (var index = 0; index < ledger.routes.length; index += 1) {
        var route = ledger.routes[index];
        lines.push(
          route.provider +
            "/" +
            route.model +
            " " +
            formatExact(billedTotal(route)) +
            " (" +
            String(route.requests) +
            " " +
            t("row.requests") +
            ")",
        );
      }
      return lines.join("\n");
    }
    //#endregion

    //#region 组件
    /**
     * 一条路由的堆叠占比条。
     * @param props - 路由桶与总量。
     * @returns 占比条元素。
     */
    function ShareBar(props) {
      var total = props.total;
      if (total <= 0) return null;
      var segments = [];
      for (var index = 0; index < BUCKETS.length; index += 1) {
        var bucket = BUCKETS[index];
        var value = props.bucket[bucket.key] || 0;
        if (value <= 0) continue;
        segments.push(
          h("div", {
            key: bucket.key,
            className: "tl_seg " + bucket.className,
            style: { width: String((value / total) * 100) + "%" },
          }),
        );
      }
      if (segments.length === 0) return null;
      return h("div", { className: "tl_bar", children: segments });
    }

    /**
     * 一条路由行。
     *
     * 每个标签都走 `t()`：面板在中英文界面下都必须整体是同一种语言，
     * 混排（英文按钮 + 中文行）读起来就像调试残留。
     * @param props - 路由值、占比与本地化函数。
     * @returns 列表行元素。
     */
    function RouteRow(props) {
      var route = props.route;
      var t = props.t;
      var total = billedTotal(route);
      var facts = factsFor(route, t);

      return h("li", {
        className: "tl_row",
        children: [
          hs("div", {
            className: "tl_route",
            children: [
              h("span", { className: "tl_provider", title: route.provider, children: route.provider }),
              h("span", { className: "tl_model", title: route.model, children: route.model }),
              h("span", {
                className: "tl_share",
                children: props.share.toFixed(1) + "%",
                title: formatExact(total) + " token",
              }),
            ],
          }),
          h(ShareBar, { bucket: route, total: total }),
          h("dl", {
            className: "tl_facts",
            children: facts.flatMap(function (fact) {
              return [
                h("dt", { key: fact.key + "-k", children: t(fact.key) }),
                h("dd", { key: fact.key + "-v", children: fact.value }),
              ];
            }),
          }),
        ],
      });
    }

    /**
     * 合计卡：全会话总量与四桶拆解，放在面板最上面。
     *
     * 这里才是这个面板存在的理由 —— 打开它最想看的就是「一共花了多少、
     * 花在哪个桶上」。所以总量给**精确逐位**读数而不是缩略值，四桶全部
     * 平铺，不留任何需要心算的余地：逐路由那几行加起来是下钻，不是
     * 用户该干的活。
     * @param props - 合计桶与本地化函数。
     * @returns 合计卡元素。
     */
    function TotalCard(props) {
      var totals = props.totals;
      var t = props.t;
      var total = billedTotal(totals);
      var facts = factsFor(totals, t);

      return hs("section", {
        className: "tl_card",
        children: [
          hs("div", {
            className: "tl_cardHead",
            children: [
              h("span", { className: "tl_cardLabel", children: t("summary.total") }),
              h("span", {
                className: "tl_cardTotal",
                title: formatExact(total) + " token",
                children: formatExact(total),
              }),
            ],
          }),
          h(ShareBar, { bucket: totals, total: total }),
          h("dl", {
            className: "tl_facts",
            children: facts.flatMap(function (fact) {
              return [
                h("dt", { key: fact.key + "-k", children: t(fact.key) }),
                h("dd", { key: fact.key + "-v", children: fact.value }),
              ];
            }),
          }),
        ],
      });
    }

    /**
     * 一个桶的展示条目。合计与逐路由共用，保证两处的行序、标签与口径
     * 完全一致 —— 否则上下对不上，读的人会开始怀疑哪个是真的。
     * @param bucket - 桶。
     * @param t - 本地化函数。
     * @returns 标签键与已格式化值的有序表。
     */
    function factsFor(bucket, t) {
      var hit = cacheHitPercent(bucket);
      var facts = [
        { key: "row.requests", value: String(bucket.requests) },
        { key: "bucket.input", value: formatExact(bucket.uncachedInputTokens) },
        { key: "bucket.cacheRead", value: formatExact(bucket.cacheReadTokens) },
      ];
      if (bucket.cacheWriteTokens > 0) {
        facts.push({ key: "bucket.cacheWrite", value: formatExact(bucket.cacheWriteTokens) });
      }
      facts.push({ key: "bucket.output", value: formatExact(bucket.outputTokens) });
      if (bucket.reasoningTokens !== undefined) {
        facts.push({ key: "row.reasoning", value: formatExact(bucket.reasoningTokens) });
      }
      if (hit !== null) facts.push({ key: "row.cacheHit", value: hit + "%" });
      return facts;
    }

    /**
     * 全局台账区块：跨所有 workspace、所有会话的累计。
     *
     * 这是整个面板最上面、也是最该先看的一块：单会话的账回答「这次花了
     * 多少」，全局账回答「一共花了多少、花在谁身上」。后者只有这里能给。
     *
     * 三种非就绪态都如实说清，绝不显示一个假的零：`absent` 是宿主没挂全局
     * 路由，`error` 是读失败，`stale` 是首轮折叠还没跑完。
     * @param props - 全局台账状态、路由展开开关与本地化函数。
     * @returns 全局摘要块。
     */
    function GlobalBlock(props) {
      var state = props.state;
      var t = props.t;

      if (state.phase === "absent") return null;

      var head = hs("div", {
        className: "tl_globalHead",
        children: [
          h("span", { className: "tl_globalLabel", children: t("global.title") }),
          state.phase === "ready" && state.value.stale === true
            ? h("span", { className: "tl_badge", title: t("global.refreshing"), children: t("global.refreshing") })
            : null,
        ],
      });

      if (state.phase === "idle" || state.phase === "loading") {
        return hs("section", {
          className: "tl_global",
          children: [head, h("p", { className: "tl_note", children: t("global.loading") })],
        });
      }
      if (state.phase === "error") {
        return hs("section", {
          className: "tl_global",
          children: [head, h("p", { className: "tl_note", children: t("global.error") })],
        });
      }

      var value = state.value;
      var total = billedTotal(value.totals);
      var facts = factsFor(value.totals, t);

      return hs("section", {
        className: "tl_global",
        children: [
          head,
          hs("div", {
            className: "tl_cardHead",
            children: [
              h("span", { className: "tl_cardLabel", children: t("global.total") }),
              h("span", {
                className: "tl_cardTotal",
                title: formatExact(total) + " token",
                children: formatExact(total),
              }),
            ],
          }),
          h(ShareBar, { bucket: value.totals, total: total }),
          h("dl", {
            className: "tl_facts",
            children: facts.flatMap(function (fact) {
              return [
                h("dt", { key: fact.key + "-k", children: t(fact.key) }),
                h("dd", { key: fact.key + "-v", children: fact.value }),
              ];
            }),
          }),
          // 会话数与路由下钻：默认收起，避免把「答案」挤下去。
          hs("div", {
            className: "tl_globalFoot",
            children: [
              h("span", {
                className: "tl_meta",
                children: t("global.sessions", { count: value.sessions, routes: value.routes.length }),
              }),
              h("button", {
                type: "button",
                className: "tl_linkButton",
                "aria-expanded": props.expanded,
                onClick: props.onToggleRoutes,
                children: props.expanded ? t("global.hideRoutes") : t("global.showRoutes"),
              }),
            ],
          }),
          props.expanded
            ? h("ul", {
                className: "tl_rows tl_rowsCompact",
                children: value.routes.map(function (route, index) {
                  var routeTotal = billedTotal(route);
                  return hs("li", {
                    key: route.provider + "/" + route.model + ":" + String(index),
                    className: "tl_routeLine",
                    children: [
                      h("span", { className: "tl_share", children: total > 0 ? ((routeTotal / total) * 100).toFixed(1) + "%" : "–" }),
                      h("span", { className: "tl_lineTotal", children: formatExact(routeTotal) }),
                      h("span", { className: "tl_provider", title: route.provider, children: route.provider }),
                      h("span", { className: "tl_model", title: route.model, children: route.model }),
                    ],
                  });
                }),
              })
            : null,
          value.error === null || value.error === undefined
            ? null
            : h("p", { className: "tl_note tl_noteWarn", title: value.error, children: t("global.partial") }),
        ],
      });
    }

    /**
     * 面板主体：固定的表头与合计卡 + 独立滚动的路由下钻。
     *
     * 分层是有意的：总量是「答案」，必须始终可见；路由列表是「下钻」，
     * 可以滚动。路由表最多 64 行，卡片不分层的话面板会直接冲出视口。
     * @param props - 台账值、全局状态与本地化函数。
     * @returns 面板内容。
     */
    function LedgerBody(props) {
      var ledger = props.ledger;
      var t = props.t;
      var total = billedTotal(ledger.totals);
      return hs(react.Fragment, {
        children: [
          // 固定区：全局账 + 本会话合计卡 + 图例，滚动时不动。
          hs("div", {
            className: "tl_fixed",
            children: [
              hs("div", {
                className: "tl_head",
                children: [
                  h("span", { className: "tl_title", children: t("dialog.title") }),
                  h("span", { className: "tl_subtitle", children: t("dialog.subtitle") }),
                ],
              }),
              h(GlobalBlock, {
                state: props.global,
                expanded: props.globalExpanded,
                onToggleRoutes: props.onToggleGlobalRoutes,
                t: t,
              }),
              // 单会话合计：明确标注范围，避免与上面的全局账混淆。
              h("p", { className: "tl_sectionLabel", children: t("summary.sessionTotal") }),
              ledger.routes.length === 0
                ? h("p", { className: "tl_note", children: t("state.empty") })
                : h(TotalCard, { totals: ledger.totals, t: t }),
              h("div", {
                className: "tl_legend",
                children: BUCKETS.map(function (bucket) {
                  return hs("span", {
                    key: bucket.key,
                    className: "tl_legendItem",
                    children: [
                      h("span", { className: "tl_swatch " + bucket.className, "aria-hidden": true }),
                      h("span", { children: t("bucket." + bucket.label) }),
                    ],
                  });
                }),
              }),
              // 分隔线收在固定区底部，滚动时它跟着摘要块一起留在原位。
              ledger.routes.length === 0
                ? null
                : h("div", { className: "tl_divider", "aria-hidden": true }),
            ],
          }),
          // 滚动区：只有本会话的逐路由明细。
          ledger.routes.length === 0
            ? null
            : hs("div", {
                className: "tl_scroll",
                children: [
                  h("p", { className: "tl_sectionLabel", children: t("summary.byRoute") }),
                  h("ul", {
                    className: "tl_rows",
                    children: ledger.routes.map(function (route, index) {
                      return h(RouteRow, {
                        key: route.provider + "/" + route.model + ":" + String(index),
                        route: route,
                        share: total > 0 ? (billedTotal(route) / total) * 100 : 0,
                        t: t,
                      });
                    }),
                  }),
                ],
              }),
        ],
      });
    }

    /**
     * 会话头按钮 + 台账面板。
     *
     * `useProjection("tokenLedger")` 由会话作用域座位的标准 hook 提供；
     * 键未注册时读到 `undefined`，此时按钮照常渲染但面板说明能力缺席 ——
     * 不静默消失，否则没人能看出是插件没挂上还是会话真的没有用量。
     * @param props - 座位注入的会话作用域 props（含 useProjection 与 t）。
     * @returns 按钮与面板。
     */
    function TokenLedgerAction(props) {
      var useProjection = props.useProjection;
      var t = props.t;
      var sessionId = props.sessionId;
      var ledger = useProjection === undefined ? undefined : useProjection("tokenLedger");
      var [open, setOpen] = useState(false);
      var [globalExpanded, setGlobalExpanded] = useState(false);
      var rootRef = useRef(null);
      // 全局账只在面板打开时读，避免常驻轮询。
      var globals = useGlobalLedger(sessionId, open);

      useEffect(
        function () {
          if (!open) return undefined;
          var onPointerDown = function (event) {
            if (event.target instanceof Node && rootRef.current !== null && rootRef.current.contains(event.target)) {
              return;
            }
            setOpen(false);
          };
          var onKeyDown = function (event) {
            if (event.key === "Escape") setOpen(false);
          };
          document.addEventListener("pointerdown", onPointerDown);
          document.addEventListener("keydown", onKeyDown);
          return function () {
            document.removeEventListener("pointerdown", onPointerDown);
            document.removeEventListener("keydown", onKeyDown);
          };
        },
        [open],
      );

      var label = t("header.open");
      var toggle = useCallback(function () {
        setOpen(function (value) {
          return !value;
        });
      }, []);

      return hs("span", {
        className: "tl_root",
        ref: rootRef,
        children: [
          h("button", {
            type: "button",
            className: "tl_button",
            "aria-label": label,
            "aria-haspopup": "dialog",
            "aria-expanded": open,
            title: ledger === undefined ? label : plainText(ledger, t),
            onClick: toggle,
            children: h(primitives.IconGaugeOutline16, {}),
          }),
          open
            ? h("div", {
                className: "tl_panel",
                role: "dialog",
                "aria-label": t("dialog.title"),
                children:
                  ledger === undefined
                    ? hs(react.Fragment, {
                        children: [
                          hs("div", {
                            className: "tl_head",
                            children: [
                              h("span", { className: "tl_title", children: t("dialog.title") }),
                              h("span", { className: "tl_subtitle", children: t("dialog.subtitle") }),
                            ],
                          }),
                          // 本会话投影缺席不等于全局账也缺席：两者是两套通道。
                          h(GlobalBlock, {
                            state: globals.state,
                            expanded: globalExpanded,
                            onToggleRoutes: function () {
                              setGlobalExpanded(function (value) {
                                return !value;
                              });
                            },
                            t: t,
                          }),
                          h("p", { className: "tl_note", children: t("state.absent") }),
                        ],
                      })
                    : h(LedgerBody, {
                        ledger: ledger,
                        global: globals.state,
                        globalExpanded: globalExpanded,
                        onToggleGlobalRoutes: function () {
                          setGlobalExpanded(function (value) {
                            return !value;
                          });
                        },
                        t: t,
                      }),
              })
            : null,
        ],
      });
    }
    //#endregion

    //#region 文案
    /** 本插件浏览器反馈自有的 locale 命名空间。 */
    var NS = "token-ledger";

    var zh = {
      "header.open": "Token 台账",
      "dialog.title": "Token 台账",
      "dialog.subtitle": "按模型路由分组",
      "state.absent": "宿主未注册 tokenLedger 投影：token-ledger 插件未启用，或本会话尚未产生用量样本。",
      "state.empty": "本会话还没有任何提供方用量样本。",
      "summary.total": "本会话合计",
      "global.title": "全部历史（跨所有会话）",
      "global.total": "累计总量",
      "global.loading": "正在折叠全部会话的日志…首次约需数秒。",
      "global.error": "读取全局台账失败。",
      "global.refreshing": "刷新中",
      "global.partial": "部分会话未能折叠，合计为已知部分。",
      "global.sessions": "{count} 个会话 · {routes} 条路由",
      "global.showRoutes": "展开逐路由",
      "global.hideRoutes": "收起",
      "summary.sessionTotal": "本会话",
      "summary.byRoute": "按路由",
      "summary.cacheHit": "缓存命中率 {percent}%（缓存读 {tokens}）",
      "row.requests": "请求",
      "row.reasoning": "其中推理",
      "row.cacheHit": "缓存命中率",
      "bucket.input": "未缓存输入",
      "bucket.cacheRead": "缓存读",
      "bucket.cacheWrite": "缓存写",
      "bucket.output": "输出",
    };

    var en = {
      "header.open": "Token ledger",
      "dialog.title": "Token ledger",
      "dialog.subtitle": "grouped by model route",
      "state.absent":
        "The host registered no tokenLedger projection: the token-ledger plugin is inactive, or this Session has no usage sample yet.",
      "state.empty": "This Session has no provider usage sample yet.",
      "summary.total": "Session total",
      "global.title": "All history (every Session)",
      "global.total": "Cumulative total",
      "global.loading": "Folding every Session log… the first run takes a few seconds.",
      "global.error": "Could not read the global ledger.",
      "global.refreshing": "refreshing",
      "global.partial": "Some Sessions could not be folded; the total covers the rest.",
      "global.sessions": "{count} Sessions · {routes} routes",
      "global.showRoutes": "Show by route",
      "global.hideRoutes": "Collapse",
      "summary.sessionTotal": "This Session",
      "summary.byRoute": "By route",
      "summary.cacheHit": "Cache hit {percent}% (cache read {tokens})",
      "row.requests": "requests",
      "row.reasoning": "of which reasoning",
      "row.cacheHit": "cache hit",
      "bucket.input": "uncached input",
      "bucket.cacheRead": "cache read",
      "bucket.cacheWrite": "cache write",
      "bucket.output": "output",
    };
    //#endregion

    //#region 插件装配
    /** 本浏览器插件需要的 cordis 服务。 */
    var inject = ["slots", "locale"];

    /**
     * 注册会话头 utilities 座位。`slots.inject` 会等待座位声明，
     * 因此与 ui-conversation 的激活顺序无约束。
     * @param ctx - 浏览器根上下文。
     */
    function apply(ctx) {
      ctx.effect(
        function () {
          return ctx.locale.register(NS, { zh: zh, en: en });
        },
        "token-ledger: dictionaries",
      );
      ctx.slots.inject("conversation.session.header.utilities", function () {
        return ctx.slots.register(
          {
            name: "conversation.session.header.utilities",
            id: "token-ledger",
            order: 30,
            locale: NS,
          },
          TokenLedgerAction,
        );
      });
    }
    //#endregion

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
