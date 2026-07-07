# v5 cron 触发可靠性根治:master 唤醒调度 + 容器有界 catch-up + 离线送达 inbox

日期:2026-07-07。背景:管理中心审计(openclaude-scratch/v5-manage-center-audit-2026-07-07.md)P0 根因——CronScheduler 寄生在 30 分钟 idle-sweep 的临时容器内,无唤醒/无补跑,用户离线时定时任务静默失效;送达走容器内存 ring,离线即丢。

## 架构原则

**权威不动,只补"叫醒"**:cron.yaml(容器卷)仍是任务定义唯一权威;master 只持有**派生唤醒索引**(可随时从卷重算,不构成第二权威);执行与送达判定留在容器。master 的职责收敛为一件事:到点确保容器活着。

## 组件

### 1. PG 派生索引(迁移 0119_cron_wake_index.sql)
粒度=用户(非 per-job,避免行级同步复杂度):
```sql
CREATE TABLE cron_wake_index (
  user_id BIGINT NOT NULL,
  runtime_channel TEXT NOT NULL,
  next_fire_at TIMESTAMPTZ,          -- NULL = 无 enabled 任务
  jobs_enabled INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, runtime_channel)
);
CREATE INDEX idx_cron_wake_due ON cron_wake_index (runtime_channel, next_fire_at)
  WHERE next_fire_at IS NOT NULL;
```

### 2. 容器→master 索引 push:`POST /internal/v3/cron-index`
- 容器 gateway 在 addJob/updateJob/removeJob 后 + CronScheduler.start 后 + tick 末尾(nextFire 变化时)上报 `{ nextFireAt: string|null, enabledCount: number }`。
- 通道/鉴权仿 v3WechatProactive(OPENCLAUDE_V3_MASTER_BASE_URL + OPENCLAUDE_V3_CONTAINER_TOKEN,master 由 token 解析 uid);fire-and-forget,失败静默(有兜底 rescan)。个人版无 master env → no-op。
- nextFireAt 计算复用 gateway cron.ts 既有 computeNextRun(单一 cron 解析器,不写第二套)。

### 3. master cronWake scheduler(v5-owned,index.ts 注册)
- tick 60s:认领 `next_fire_at <= NOW() + 90s`(提前量覆盖冷启 5-8s + boot tick 10s)。
- 对 due 用户:容器非 active → fire-and-forget `ensureContainerReady(uid)`(singleflight 幂等);per-uid 唤醒冷却(默认 10min)防 provision 失败 spin;每 tick 唤醒上限(默认 10)防唤醒风暴打爆宿主机。
- 唤醒后不改 next_fire_at:容器起来后 boot tick→push 刷新;起失败则下轮仍 due、受冷却限流重试。
- 兜底 rescan(每 30min):扫 v5 用户卷 `/var/lib/docker/volumes/oc-v5-data-u<uid>/_data/cron.yaml`(v5 全 self-host,volumeReader 已证本地可读)重算对账 upsert;卷缺/无任务 → next_fire_at=NULL。
- env 开关 `COMMERCIAL_CRON_WAKE_DISABLED=1` 一键回滚。

### 4. 容器侧有界 catch-up(gateway cron.ts)
- tick 判定从"仅当前分钟"扩为:当前分钟不中时,向过去扫最多 OC_CRON_CATCHUP_MIN(默认 15)分钟,找**最近一次**错过的调度分钟 M;仅当 `lastRun[id] < minuteKey(M)` 且 M ≥ job.createdAt 时补跑一次(错过多次只补最近一次,Claude Code 同款语义)。
- CronJob 增可选 `createdAt`(addJob/工具创建时填),防补跑创建前的"虚假错过";存量无 createdAt 的任务不受限(窗口本身有界)。
- lastRun 记 M 的 minuteKey → 跨重启幂等(last-run.json 随卷持久)。

### 5. 离线送达兜底写站内信:`POST /internal/v3/inbox-post`
- master handler 调既有 createInboxMessage(audience='user', level='info');body 截断 4KB;每 uid 限频 6 条/分钟,超限丢弃打日志。
- 容器 onDeliver:仅当 webchat 无任何在线客户端可送(广播落空)且 deliver≠local 时兜底写 inbox——保守起步,避免"送达成功还推站内信"的通知重复(boss UX 铁律)。

### 6. 配额(容器侧 addJob/updateJob)
- OC_CRON_MAX_JOBS 默认 50(仅 API 增删路径,不影响个人版 seed);
- OC_CRON_MAX_PER_HOUR 默认 12:分钟字段命中分钟数 >12(比 */5 更密)拒绝,报错给出"最短 5 分钟间隔"引导。均 env 可放宽。

## 显式权衡

- **不做** master 侧执行/送达(保持送达判定单一权威在容器);**不做** per-job 索引行(用户粒度够用);执行历史落库与可回放 UI 属第四批(工作台化),本批不做。
- 索引 push 与 rescan 双层保鲜:push 丢失最坏延迟 = rescan 周期(30min)——对"每天 9 点"类任务可接受;高价值即时任务由 push 承担。
- 多机未来:push 模式天然兼容多机;rescan 是 self-host 假设(v5 现状),多机化时改走 node-agent 读卷,登记为已知边界而非隐藏假设。

## 生效面
master(commercial scheduler+internal 端点)+ 迁移 0119(人工 apply)+ runtime image(gateway cron.ts/poster)。无前端。
