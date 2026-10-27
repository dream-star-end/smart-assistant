# 试点：对话回合 → egress → 计费（个人版，方案 §9.4）

> 状态：**S0 开工（只读观测）**。P2b 两道门的测试部分已全绿，但设计《ARCH_P2B_FUND_ENTRY_GATES.md》仍是“待评审”，所以按 §9.4，本试点的计费部分只读观测，路由部分不改策略。设计批准前不动任何资金写路径。

## 1. 范围（一个提供方、一条结算路径）

| 项 | 取值 | 理由 |
|---|---|---|
| 模型 / 提供方 | `deepseek-v4-flash` / `opencodego`（`model_catalog` active 行自 2026-10-21，上游 `deepseek-v4.1-flash`） | 个人版近 7 天回合量最大（268 回合、1069 次计费调用，7 个用户），每边 ≥ 200 回合的样本要求能满足 |
| 引擎 | `ccb` | |
| egress | `packages/commercial/src/http/proxy/index.ts`（Anthropic 兼容入口）+ `apiKeyPoolWiring.ts` / `account-pool/apiKeyPool.ts`（opencodego key 池） | |
| 结算路径 | `billing/preCheck.ts` → `billing/proxyBilling.ts settleUsageAndLedger` → `billing/spend.ts` | 主结算路径；不含 codex/zcode/cursor/antigravity/box 等变体 |
| 回合 | `dispatch/*`（`turn_dispatches`） | |

对照用 `grok-build`（grok 引擎，236 回合/7 天）不选：样本刚过线，且走另一条结算变体。

## 2. 入口门状态（2026-10-27）

| 门 | 状态 |
|---|---|
| 资金原子性测试 T1–T5（+ P6 的 T6/T8/T9） | 全绿 |
| 入口冻结测试 B1、B4–B8 | 全绿 |
| 设计评审批准 | **未批**（文档首行“待评审”）→ 试点计费部分只读 |

## 3. 基线（发布前，7 天，`deepseek-v4-flash`，2026-10-20 至 2026-10-27）

| 指标 | 值 | 来源 |
|---|---|---|
| 回合数 | 261 个 dispatch / 268 条 trace | `turn_dispatches.admitted_at`、`turn_traces.created_at` |
| 完成 | 246（94.3%）；除用户取消 96.1% | `outcome` |
| 中断 | `SERVICE_RESTART` 9（发版重启）、`USER_CANCELLED` 5、`DISPATCH_NOT_ACCEPTED` 1 | |
| 首个可见输出 | 261/268 有；TTFT p50 8.97 s、p90 13.05 s | `first_visible_at − created_at` |
| `oc-trace` 60 秒目标 | 该模型全部 11 个失败回合 11/11 在 60 s 内给出首个错误码与环节（19.6–23.1 s/个）；1 个无主机日志证据 | `oc-trace --drill 20 --model deepseek-v4-flash` |

“随机 20 个失败回合”在这条链路上凑不满（历史只有 11 个），按方案写“样本不足，全部 11 个”。

## 4. 护栏基线（`check-architecture`，个人 tip `8f99fea1a`）

试点链路所在模块的已登记违规 203 条（基线）+ 新增/增长 14 条：

| 模块（层） | 基线 | 新增/增长 | 主要规则 |
|---|---|---|---|
| `llm-proxy`（L3） | 124 | 4 | `R3-billing-sql` 42、`R2-scope` 26、`R3-env` 20、`R2-upward` 17 |
| `billing`（L3） | 64 | 10 | `R2-scope` 23、`R2-same-layer` 16、`R3-special-case` 16 |
| `dispatch`（L3） | 15 | 0 | `R2-same-layer` 6、`R2-scope` 6 |

`llm-proxy` 里 42 处计费表写入（`R3-billing-sql`）正是试点要收进 `app/settlement` 工作单元的东西；这一步改资金写路径，设计批准前不做。

## 5. 切片

| 切片 | 内容 | 资金写 | 状态 |
|---|---|---|---|
| **S0** | 本文 + `oc-trace` 把链路追到计费终点：`usage_records` → `credit_ledger`（按 usage id 只读；debit/退款都挂在 usage 上）；`--drill N --model ID` 只看一条链路 | 否（只读） | 本 PR |
| S1 | 链路上非计费的分层：`llm-proxy` 的 `R3-env` / `R2-upward` / `R2-scope`（试点文件范围内），走公开 API，不改路由策略 | 否 | 待 S0 评审 |
| S2 | `app/turn` + `app/settlement` 工作单元：把 `llm-proxy` 的计费 SQL 收进 `app/settlement`，`billing` 只露公开 API | **是** | 等 P2b 设计批准 |
| S3 | 发布后 7 天同口径复测（成功率、TTFT、60 s、违规数），写试点报告（分层是否可行、护栏误报、搬家成本） | 否 | S2 发布后 |

## 6. 退出（§9.4，原样）

试点链路违规数 = 0；`oc-trace` 在试点链路上的 60 秒目标实测达成；试点前后同链路回合成功率和 TTFT 无退化（各取发布前后 7 天、该提供方的全部回合，每边 ≥ 200 回合，不足延长窗口，仍不足写“证据不足”）；试点报告经评审后才进入 M-B/M-C。**“锁已上”不算试点完成。**
