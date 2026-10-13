# 自进化周报（OCV5-403 P0-2）

`scripts/v5-selfevolve-weekly-report.ts` 每周汇总个人版里可作为自进化信号的数据，供人判断哪些信号可信、哪些需要先补。它是 `docs/selfheal/problem-card-review.md` 的只读兄弟：同样跑在宿主 cron、不进 master 进程，但不开单、不写任何业务表。

## 跑法

```bash
cd /opt/openclaude/openclaude-v5-selfhost
node_modules/.bin/tsx scripts/v5-selfevolve-weekly-report.ts --dry-run          # 只打印
node_modules/.bin/tsx scripts/v5-selfevolve-weekly-report.ts                    # 写 /opt/openclaude/var/selfevolve-report/<日期>.md 和 .json
node_modules/.bin/tsx scripts/v5-selfevolve-weekly-report.ts --days 30 --date 2026-10-13
```

`DATABASE_URL` 优先取环境变量，否则读 `/etc/openclaude/commercial-v5-selfhost.env`。整个查询在 `BEGIN READ ONLY` 事务里，`statement_timeout` 60 秒。退出码：0 成功，2 PG 失败（不写文件），4 参数错误。窗口截止到 `--date` 当天结束（UTC），同一日期重跑结果可复现。

## 内容

| 节 | 来源表 | 说明 |
|---|---|---|
| 回合结局 | `turn_dispatches` | 按结局、按模型 |
| 信号归因 | `turn_dispatches` ⟕ `turn_traces` | completed 回合按来源（`conn` 浏览器连接、`cron` cron-origin、`other`）分列 trace 关联、runtime/control 版本、bundle、client_build、首个可见的覆盖率；另列没有 dispatch 的 trace 数和最多的会话（只给 md5 前 12 位） |
| 评价 | `response_rating`、`response_rating_nudges` | 显式赞踩、隐式踩按标签、引导曝光 |
| 遥测就绪门 | `telemetry_readiness_evidence` | 每个用户的判定次数、放行次数、最近一次 blocker |
| 摩擦 | `product_friction_events` | 非 succeeded/recovered 的 stage、code、outcome 前 10 |
| 技能 | `marketplace_skill_usage_events`、`skill_retrieval_shadow_events` | 使用前 10，与差评按 trace 关联的次数 |
| 记忆使用 | `memory_usage_events` | 操作/结果计数 |
| auto-dream | `auto_dream_action_receipts`、`auto_dream_platform_findings` | 回执状态、未关闭发现按严重度 |

“需要注意”一节只是文字提示，阈值与 `telemetryReadiness.ts` 相同，但报告不是门禁，也不改变任何门禁。

## 不输出的东西

会话原文、评价备注（`comment`）、记忆内容、查询文本或其哈希、平台发现的正文、`routes`。单测断言这些列不出现在查询里，且所有查询都是 SELECT。

## 定时

宿主 root crontab，周一 08:15（北京时间）：

```
15 0 * * 1 cd /opt/openclaude/openclaude-v5-selfhost && /usr/bin/env PATH=/usr/local/bin:/usr/bin:/bin node_modules/.bin/tsx scripts/v5-selfevolve-weekly-report.ts >> /opt/openclaude/var/selfevolve-report/cron.log 2>&1
```
