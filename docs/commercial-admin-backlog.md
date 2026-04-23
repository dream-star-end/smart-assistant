# Commercial v3 Admin — Backlog

本文档记录 v3 商业版 admin 侧已识别但**还没 wire 进 Phase 1** 的工作项。
Phase 1(2026-04-23 上线)交付的是"iLink WeChat 告警推送 + 15 个已 wire 事件 + 通道/outbox/silence/rule_state 持久化"最小闭环。

增加新事件或 backlog 项的流程:
1. 在下方加一行;
2. 如果升级到"要立刻做",把它从这里搬去 issue / PR / commit message;
3. 推上线后在本文对应条目标 ✅ 并写入哪个 commit 完成。

---

## 告警事件 — 已删但二期要补回

Codex R1 审计发现 Phase 1 的 `EVENT_META` 列了 7 个永远不会 enqueue 的"僵尸事件"(UI 能订阅但代码路径没埋点),最终决定只保留 15 个真正 wire 的事件,下面 7 个延到二期补齐埋点再重新加回 `EVENTS` / `EVENT_META`:

| event_type | severity | group | 埋点位置 | 说明 |
|---|---|---|---|---|
| ✅ `payment.failed` | warning | payment | `packages/commercial/src/http/payment.ts` status="NF" 分支 | Phase 2 已 wire。虎皮椒回调 status=NF(用户侧支付失败 / 超时 / 取消)分支 enqueue,dedupe_key=`payment.failed:<order_no>` |
| `payment.refund` | info | payment | 暂无退款流程 | 等产品上退款功能再加(需要先接虎皮椒退款 API / 自建退款单流程) |
| ✅ `container.oom_exited` | warning | container | `packages/commercial/src/agent-sandbox/v3containerEvents.ts` | Phase 2 已 wire。独立 worker 订阅 docker events(filters: type=container, event=oom\|die),OOM / die+exitCode=137 → enqueue,10min 桶化 dedupe |
| `container.cleanup_partial` | warning | container | `packages/commercial/src/agent-sandbox/v3cleanup.ts` (如果有) | 垃圾回收扫容器时发现名字 matched 但 PG 里已无对应 session,stop/rm 失败的情况 |
| ✅ `risk.login_failure_spike` | warning | risk | `packages/commercial/src/admin/alertRules.ts` `ruleLoginFailureSpike` | Phase 2 已 wire。当前走 `rate_limit_events(scope='login', blocked=true)` 做 proxy 计数,N 分钟内 ≥ threshold 触发。真正需要 `user_login_events` audit 表,Phase 3 再上。阈值 / 窗口由 `alerts_login_failure_spike_threshold`(默认 30)/ `alerts_login_failure_window_min`(默认 10)可配 |
| `health.5xx_spike` | warning | health | Prometheus / /metrics | 要从 `http_requests_total{status=~"5.."}` rate 聚合,超过 baseline → 触发。依赖先接 Prom recording rule |
| `health.ttft_high` | warning | health | Prometheus histograms | `anthropic_proxy_ttft_ms_bucket` 的 P95 超阈值触发。同上 |

已 wire 的事件见 `packages/commercial/src/admin/alertEvents.ts` 的 `EVENTS` / `EVENT_META`(Phase 1: 15 个 + Phase 2: 3 个 = 18 个)。

---

## 敏感材料内存清零(Codex R1 Finding #5)

**现状**:iLink `bot_token` 在 `alertChannels.ts` 里解密后以 JS `string` 形式返回给上层 send 路径。`string` 在 V8 里由 GC 管理,无法在 `finally` 块里 `fill(0)` 擦除,残留在堆里直到被回收。

**风险等级**:Low。

- Token 只在 dispatcher 活内存里,没落 log / audit / HTTP 响应 / DB 明文;
- v3 同类型的敏感材料(OAuth refresh token、wechat session、v3 容器 JWT)目前全部是 string,Phase 1 单独处理告警侧会造成半拉子状态。

**二期方案**:统一把 `(bot_token, oauth_refresh_token, wechat_session_token)` 的解密返回类型改成 `Buffer`,所有 send / sign / dispatch 路径改成接受 Buffer,用完在 `finally` 里 `buf.fill(0)`;配套加 ESLint 规则禁止把这些字段往 string 字段赋值。

---

## 其它 Phase 1 遗留

- **iLink long-poll worker `retry-after` 精细化**:当前遇到 `session expired` 会把通道切 `error`,但没实现 admin 侧"一键重新扫码" workflow;UI 上只显示红字,admin 得手动删通道再建。二期要在 `admin.js` 加"重新激活"按钮调 `POST /api/admin/alerts/channels/:id/rebind`。
- **silence matcher 语义扩展**:Phase 1 `matcher` 只支持 `{ event_type, severity, rule_id }` 任一精确匹配;二期可能要支持 glob(`payment.*`)或 "AND 多条件"。matcher 语法改动要同步加 migration(JSONB schema 变化)+ 前端 UI。
- **outbox 退避策略**:Phase 1 已落指数退避(`markFailed` 里 `LEAST(INTERVAL '60 seconds' * POWER(2, attempts), INTERVAL '30 minutes')`),但还没加 jitter。二期补 jitter(±20% 随机)避免重连风暴。
- **告警历史导出/搜索**:`/api/admin/alerts/outbox` 只支持 filter + 时间降序分页,没有按 title/body 模糊搜索、导出 CSV。低优先,出事故复盘才会用到。
