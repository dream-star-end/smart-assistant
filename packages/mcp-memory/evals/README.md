# Core 记忆检索私有回归集

这不是公开榜。公开长期记忆基准（LOCOMO / 厂商 Mem0 自评 / 部分 LongMemEval 用法）已经被第三方审计打穿：标准答案会错、LLM judge 会放行含糊错答、语料还能塞进现代上下文窗。本目录只提供**固定协议的私有回归**：改 `handleCoreSearch` 排序前后跑出可比数字。

被测对象：`packages/mcp-memory/src/memoryTools.ts` 的 `handleCoreSearch`。本目录只 import，不改那个文件。

## 怎么跑

在仓库根（能解析 `@openclaude/storage` 的那棵树）执行：

```bash
npx tsx packages/mcp-memory/evals/run.mjs
npx tsx packages/mcp-memory/evals/run.mjs --json
npx tsx packages/mcp-memory/evals/run.mjs --baseline packages/mcp-memory/evals/baseline-before.json
```

`run.mjs` 在没挂 tsx 时会自己找 worktree / donor 的 `tsx` 再 exec 一次。每次跑都把 `evals/fixtures/` 拷进临时 `OPENCLAUDE_HOME`，**不读真实 `~/.openclaude` 用户记忆**。

**跑 baseline 前必须确认 `packages/mcp-memory/src/memoryTools.ts` 处于未改状态**（例如 `diff packages/mcp-memory/src/memoryTools.ts` 相对 HEAD 为空，或与已知的 HEAD 副本对照）。若 worktree 里已经有检索改动，写进 `baseline-before.json` 的就不是真 baseline——本目录曾因此把并行 BM25 改动后的 0.750 误记成 HEAD。

A2 改完打分后对比：

```bash
npx tsx packages/mcp-memory/evals/run.mjs --json > /tmp/core-retrieval-after.json
npx tsx packages/mcp-memory/evals/run.mjs --baseline packages/mcp-memory/evals/baseline-before.json
```

看 delta：precision@3 / MRR 应上升，no-match 正确率应到 100%，平均命中数应降到库容量的 40% 以下。退出码 0 = PASS，非 0 = FAIL。

不要跑 `npm run check:v5`。本评测不是那个门。

## 协议（与 `run.mjs` 文件头一致）

| 项 | 值 |
|---|---|
| fixtureVersion | `2026-08-17.2`（`fixtures/VERSION`） |
| protocolVersion | `1.0.0` |
| agentId | `eval-core` |
| limit | 20（API 上限，命中数取全量不是分页） |
| top-k | 3（precision@3 / 展示） |
| 语义重排 | 关闭（清掉 `OPENCLAUDE_V3_MASTER_*`，保证可重复） |
| 命中口径 | 文本以 `Found N safe Core matches` 或 `No safe Core memories match` 为准；排序取 `path:` 的 basename |

## 指标

- **precision@3**：只在 `expect.kind=hit` 的用例上平均。单条 = `|top3 ∩ topFiles| / min(3, |topFiles|)`。`mustNotRank1` 命中或超过 `maxHits` 则记 0。
- **MRR**：第一条相关文档的 `1/rank`，同样在 hit 用例上平均；上述硬约束也会把 MRR 打成 0。
- **no-match 正确率**：`kind=no_match` 用例里真正返回 No match 的比例。
- **平均命中数**：30 条查询的 `Found N` 均值（No match 记 0）。
- **延迟**：单查询 wall time 的 P50 / P95。

`allowNoMatch: true`（目前只有 R03）：hit 用例若被覆盖率门槛直接拒，算作该条通过。这对应真实期望「相关条目排前 **或** No match」。

## 门槛依据

个人版真实库约 14 条、主题高度重叠。当前词袋打分会把「V5 / 上线 / Release / 模型 / the / is」这类高频词扩成近全库召回，并用路径字典序在同分时把长文档顶到第一。

门槛故意卡这三类不可接受行为，而不是刷一个好看的绝对分：

1. **precision@3 ≥ 0.8**：专名和明确主题至少要进前三；错 top-1 / 超 `maxHits` 直接零分，避免「feedback 碰巧第一但召回了 13 条」混过关。
2. **no-match 正确率 = 100%**：天气、库外产品名、股票、k8s 这类查询不得靠一个通用词漏一条进来。真实事故里 `今天天气怎么样` 已经 Found 1。
3. **平均命中数 ≤ 库容量的 40%**：14–15 条的库最多平均约 6 条。宽查询可以召回一个主题簇，不能把整库倒出来。

当前未改的 `memoryTools.ts` 应在这套协议上 **FAIL**。若 baseline 满分，说明用例太松，要重造语料而不是降门槛。

## 语料在测什么

合成语料，不拷贝真实记忆。分布对齐个人版：同主题高相似 ×2（各 3 条）、同体裁发布备忘录 ×7、feedback ×1、user ×1、reference ×0。

| 组 | 文件 | 想触发的失效 |
|---|---|---|
| HelixForge TPU OCR ×3 | `helixforge-tpu-ocr*.md` | 近重复词袋互相污染；只有 canonical 条有连续专名 |
| NovaPulse H3 / GPU ×3 | `novapulse-h3-*.md` `helixforge-gpu-capacity.md` | 长文 + 通用词抢 rank-1（对标 MiniMax H3） |
| 发布备忘录 ×7 | `release-*.md` | 同一模板（V5 / 已上线 / Release A/B / sha / bundle），主题不同 |
| feedback | `feedback-commercial-verify.md` | 「V5 商业版 验证流程」应只留这条，而不是 13 条 |
| user | `fixtures/user.md` | Opus 管理 / Grok 执行 |

种下的陷阱见 `fixtures/manifest.json` 的 `plantedTraps`。单条目标 600–2000 字节，中英混排。

## 加新用例

1. 只改 `evals/memory-retrieval.json` 和必要时的 `evals/fixtures/`。不要为了让评测变绿去改 `memoryTools.ts`。
2. 字段：`id, query, category, lang, expect, note`。`category` ∈ `exact | fuzzy | interference | unrelated`。四类都要有，中英文都要有。
3. `expect.kind` 只能是 `hit` 或 `no_match`。hit 必须带 `topFiles`（basename）。可选 `mustNotRank1`、`maxHits`、`allowNoMatch`。
4. 新 fixture 必须能服务至少一条会失败的基线行为，或锁住一条已修过的真实事故。不要加「随便一搜就中」的送分题。
5. 加文件后更新 `fixtures/manifest.json`。改了语料语义就升 `fixtures/VERSION` 和 JSON 里的 `fixtureVersion`，并重出一份 baseline。
6. 保持 30 条或同时改 runner 里的 `cases.length !== 30` 断言与本 README。更想加就扩到 30+N 并说明为什么旧 30 不够。
7. 文件名必须匹配 `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.md$`。frontmatter 需要 `name` / `description` / `type ∈ {user,feedback,project,reference}`。不要写 `scanMemoryContent` 会拒的注入句。
