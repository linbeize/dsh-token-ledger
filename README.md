# token-ledger

> 给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) 用的 Token 台账插件：**按模型路由分组**记账，并给出**跨全部历史会话的累计总量**。

上游 `dsh-token-meter` 的 `tokenUsage` 投影只给四个桶的标量合计，回答不了
两个问题：「换到 glm 之后那一半花在谁身上」和「我一共花了多少」。
本插件从同一份持久会话日志重折一遍，按 `(provider, model)` 分组记账。

## 效果

会话头右侧的仪表盘按钮，点开是完整台账：

```
全部历史（跨所有会话）
  累计总量            6,731,450,884
  请求 22,626 · 未缓存输入 168,105,010 · 缓存读 6,542,622,379 · 输出 20,723,495
  缓存命中率 97.5%
  135 个会话 · 16 条路由                    [展开逐路由]
    92.3%  6,216,384,127  provider-a/model-x
     3.0%    202,428,522  provider-a/model-y
     2.1%    144,124,279  provider-b/model-z
     ...

本会话
  本会话合计          133,243,127
  ...
```

单会话的账回答「这次花了多少」，全局账回答「一共花了多少、花在谁身上」。

## 三处出口

| 出口 | 形态 | 用途 |
|---|---|---|
| `tokenLedger` 投影单元 | 会话投影（`stateVersion: 1`） | 所有投影载体（control 帧 / baseline / 冷读）自动下发，浏览器随取随用 |
| 全局台账路由 | `GET /api/token-ledger.all` | 跨所有 workspace 的全部历史累计（JSON） |
| `/tokens [all] [json]` | 斜杠命令 | 终端里直接看；不产生模型消息，不污染上下文 |
| 会话头按钮 | 浏览器半边 | 面板：全局累计置顶 + 本会话逐路由明细 |

## 安装

```bash
# 1) 拿到插件目录，放进 profile 的 plugins/ 下
git clone https://github.com/linbeize/dsh-token-ledger ~/.dsh/profiles/web/plugins/token-ledger

# 2) 在 profile 的 cordis.patch.yml 里加一行装载声明
cat >> ~/.dsh/profiles/web/cordis.patch.yml <<'YAML'

- insert:
    - id: token-ledger
      name: ./plugins/token-ledger/index.mjs
YAML
```

`patchReload: live`，保存即生效。**新增文件后需要重启一次 `dsh web`**（热
加载对新增模块路径有缓存）；此后只改已有文件的逻辑，刷新页面即可。

回退：删掉那几行，或给装载行加 `config: { enabled: false }`。

### 布局要求 — 不要移动这些文件

必须保留独立目录 + 非空 `name`/`version` 的 `package.json`。Host 的
`plugin-package-inventory-deepseek` 会在每次模型请求时解析每个 active entry
的归属 manifest；散放模块会向上落到 dsh 生成的 `profiles/web/package.json`
（没有 `version`），导致每次模型请求 `REQUEST_EXTENSION` 失败。同一份
manifest 也承载 `dsh.client` 声明，浏览器半边由它被扫描到。

## 口径

全部来自回放持久日志的**纯 fold**，与 token-meter 同源同口径，不做任何模型
调用，也不写会话日志：

- **样本**：`assistant/message` 的 `data.usage`；缺失时回退到该次结算内嵌
  stream 的最后一个 `usage` chunk（`assistant/attempt` 走同一条回退）。
- **归属**：`assistant/message` 的 `message.source.provider/model`；没有消息
  来源的 `assistant/attempt` 回退到最近一条 `request/context` 的路由。
- **替换**：同一次尝试内的多次采样按 last-wins 替换；`llm/retry-started`
  关闭替换槽 —— 重试是真的又发了一次请求，作为新增计费，而不是覆盖掉失败
  的那次。
- **桶**：`uncachedInputTokens` / `cacheReadTokens` / `cacheWriteTokens` /
  `outputTokens`，与 `tokenUsage` 逐字段同名同义。推理 token 是输出的子集，
  不计入合计，且**仅在每次请求都上报过时才外发** —— 参差不齐的合计会被读成
  精确值，那是谎报。
- **宁缺勿脏**：计数不安全（负数、非整数、超安全整数）时整个样本作废；归属
  不了时不记账。宁可少一个数，也不把它挂到错误的路由名下。

### 有界性

- **单会话**：路由行数上限 64，越过的并入唯一的 `(other) / *` 桶，防止快照
  无限膨胀。合并桶不参与替换槽 —— 多条真实路由共享同一个 key，若让它们互相
  替换，后来的样本会减掉别条路由已计过的账，合计当场变负。
- **全局**：不做溢出合并。全局账本来就是人类要看的全貌，路由种类再多也逐条
  列出。

### 全局账的代价与取舍

实测 135 个会话 / 约 323MB 解压后 JSON，全量冷折叠约 6 秒。因此设计成
**立即返回 + 后台增量折叠**：

- `sessionPersistence.list()` 给出的 `revision` 是判据，只有变化的会话才重折。
- `snapshot()` 是纯内存读，永不阻塞；面板首次可能显示「刷新中」，几秒后自己
  追上。
- 折叠按小并发推进，单个会话读失败不拖垮整轮，但会在面板上如实显示
  「部分会话未能折叠」，不静默吞掉。

## 验证

```bash
cd ~/.dsh/profiles/web/plugins/token-ledger

# 纯 fold 口径不变量（合成事件流：替换 / 重试 / 跨路由 / 溢出 / 脏数据）
node test/fold.test.mjs

# 与上游 tokenUsage 投影逐字段对拍（真实会话日志）
node test/verify-against-meter.mjs <session.v3.jsonl.zstd>
```

对拍脚本拿同一份事件流分别喂给本插件与上游 `dsh-token-meter`，要求四桶合计
**逐字段相等**。在真实日志上跑过 25 个会话（含 6 个真实的跨模型切换），全部
相等。

若脚本找不到上游包，设置：

```bash
DSH_TOKEN_METER=/path/to/dsh-token-meter/lib/types/usage-projection.js
```

## 兼容性

在 `dsh 0.1.5-rc.2` 上开发与验证。用到的是公开 seam：
`ctx.sessionProjections.register`、`ctx.commands.register`、
`ctx.connection.fetch.register`、槽位
`conversation.session.header.utilities`。上游若改动这些接口，插件需要跟进。

## License

MIT
