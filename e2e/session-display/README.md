# V5 固定双模型端到端防回归门

本目录是普通 V5 candidate 的发布硬门。它把近期已发生的 P0/P1 问题映射到自动化
回归，并在候选 slot 上以两个真实底座串行执行完整 Playwright 套件：

| 底座 | 固定模型 | 身份 |
|---|---|---|
| Codex | `gpt-5.6-luna` | `v5-evals@claudeai.chat` |
| CC/CCB | `deepseek-v4-flash` | `v5-evals@claudeai.chat` |

模型和身份不可由调用者覆盖。旧变量 `OC_E2E_MODEL` 会直接报错；`run.sh` 内部固定
`OC_E2E_MATRIX_MODEL`，并设置 `CI=1` 禁止 `.only`。任一模型出现失败、跳过或 flaky，
runner 立即非零退出，`deploy-v5.sh --canary` 在同一 production-mutation lease 内先执行
官方 `--abort` 逻辑，再验收 exact stable predecessor、runtime tuple、真实 turn 与 V3 inactive。

## 事故与用例权威

- `incidents.json`：近期 P0/P1 的事故 ID、症状、根修 commit 与回归证据。
- `scripts/check-v5-incident-regressions.ts`：CI/部署前检查事故 ID 唯一、根修仍在 HEAD 血缘、
  证据文件存在、每个事故有 browser/live/deploy proof，且每个 live spec 都被事故引用。
- `SELECTORS.md`：UI 选择器与直接时间线契约。

```bash
npm run check:v5:incidents
```

删除事故、删除 spec、改换模型或把 direct-timeline 依赖改回 skip，都会使门禁失败。

## 完整用例

| # | spec | 核心契约 |
|---|---|---|
| 1 | `01-login-relogin-display` | 登录、真 turn、登出重登后消息完整且顺序不变 |
| 2 | `02-large-session-open` | 大会话首屏可交互、真实答案直出、工具记录惰性展开 |
| 3 | `03-reconnect-inflight` | 断线恢复后必有完成或明确失败，绝不永久静默 |
| 4 | `04-terminal-reconcile` | 中途刷新后 spinner 收敛到回复或错误终态 |
| 5 | `05-turn-status` | verified terminal 状态可见，late-tape manual reconcile 不泄漏 |
| 6 | `06-archive-paging` | 分页无重复、游标递减、空页/hasMore 诚实、有限步终止 |
| 7 | `07-resend-dedup` | 同 clientMessageId 双发不双回复、不双计费 |
| 8 | `08-post-final-process-order` | poisoned IDB + 空增量后过程仍在 final 前且写回稳定 |
| 9 | `09-fixed-model-billing-evidence` | 精确模型、durable dispatch/tape 终态、验证赞助零扣费与名义成本留证 |

发布门强制 `OC_E2E_REQUIRE_DIRECT_TIMELINE=1`。用例 2/5 所需 PG 注入不可用时不是
skip，而是整门失败。

## 验证赞助不是用户额度

`v5-evals` 的“无限验证额度”由 release-bound sponsorship 实现，不靠伪造巨大余额：

1. deploy 为 exact candidate release、generation、slot、`v5-evals` 和随机 `e2e-*` 会话
   前缀创建短期 `verification_runs`；
2. 只有 Luna/DeepSeek 两个固定模型，且 request 的 user/session/release/generation 全部匹配，
   才在上游工作开始前写不可变 `verification_sponsored_requests`；
3. 结算事务再次核对该行，`usage_records.cost_credits=0`，同时保留
   `would_have_cost_credits` 和 `verification_run_id`；
4. 缺失、过期、串号或篡改证据一律走普通计费。普通 `v5-canary` smoke 仍真实计费。

这使验证可以长期反复运行，同时不会给真实用户、任意模型或任意会话授予免单能力。

## 运行方式

依赖域独立在本目录，浏览器复用主机 ms-playwright 缓存：

```bash
cd e2e/session-display
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci

# 官方 candidate 门（默认经 kl-mirror 建 HTTP + PG 隧道并读取 v5-evals 密码）
OC_E2E_REMOTE_PORT=18795 ./run.sh

# 已有直达 candidate 和 PG 隧道时
OC_E2E_BASE_URL=http://127.0.0.1:18795 \
OC_E2E_PG_URL='postgresql://…' \
OC_E2E_PASSWORD='…' \
./run.sh
```

生产发布不手工调用 runner；`scripts/deploy-v5.sh --canary` 会在 candidate Caddy 验证后
运行完整矩阵并持久化 `release_verification_evidence`。`--finalize` 缺 exact
release/generation 证据时先 abort。报告按模型隔离：

涉及 egress/计费代码时，canary 使用 `--egress`：脚本只在矩阵执行窗口临时切换到 candidate
egress，成功后恢复 predecessor；master finalize 成为 stable 后再从 durable transition 激活
同一份已测试 egress，失败则回退两面。

```text
reports/gpt-5_6-luna/{results.json,junit.xml,html/}
reports/deepseek-v4-flash/{results.json,junit.xml,html/}
```

## 环境变量

| 变量 | 默认/约束 | 用途 |
|---|---|---|
| `OC_E2E_BASE_URL` | 未设则自动建隧道 | candidate HTTP 根 |
| `OC_E2E_SSH_HOST` | `kl-mirror` | HTTP 隧道主机 |
| `OC_E2E_REMOTE_PORT` | `18795` | candidate slot 端口；deploy 会传真实 slot port |
| `OC_E2E_REMOTE_ENV` | `/etc/openclaude/commercial-v5.env` | 只用于远端读取 DB URL |
| `OC_E2E_PW_HOST` | `kl-mirror` | 密码/PG 隧道主机 |
| `OC_E2E_PASSWORD` | 未设则读 root-only secret | v5-evals 密码 |
| `OC_E2E_PG_URL` | 未设则自动建 PG 隧道 | direct timeline 与证据查询 |
| `OC_E2E_SESSION_PREFIX` | deploy 随机生成 | release-bound sponsorship 会话前缀 |
| `OC_E2E_RETRIES` | deploy 固定 `0` | 不接受 flaky 重试假绿 |
| `OC_E2E_TURN_TIMEOUT` | `120000` | 单轮上限 ms |

`OC_E2E_EMAIL`、`OC_E2E_MATRIX_MODEL` 仅由 runner 设置；调用者不应传。密码、DB URL、
token 不得写入仓库或报告。

## 数据安全与维护

- 所有会话均使用随机 `e2e-*` 前缀并在 fixture 收尾删除；注入仅作用于 v5-evals 自身。
- 两个模型串行执行，避免同账号会话/计费证据互相干扰。
- 修改高频 UI 节点时保留 `user-row`、`assistant-row`、`message-text`、
  `turn-process-card`、`team-panel`、`permission-card` 等稳定 testid。
- 新出现的 P0/P1 必须先把根因修复映射进 `incidents.json`，补最低层行为回归，并在适合的
  browser/live/deploy 层证明用户路径；不得只记事故不加自动门。
- 紧急止血可按 `docs/V5_DEV_PLAYBOOK.md` 的 dx-declared emergency lane 跳过本矩阵，
  但 durable debt 会阻断后续普通生产变更，直到测试、单一 Codex PASS、受保护 CI/PR 全部关账。
