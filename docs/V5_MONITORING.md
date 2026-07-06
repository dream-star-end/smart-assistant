# V5 监控告警最小集(roadmap P0.3)

> ops 极简哲学:两个 systemd timer + 两个 bash 脚本,不引外部监控系统。
> 告警首选 v5 站内信(发给 boss),全量兜底落 `/var/log/openclaude-v5-monitor.log`。
> 最后校准:2026-07-05。

## 组成

| 文件 | 作用 |
|---|---|
| `scripts/v5-monitor.sh` | 高频探活(每 2 分钟):服务/healthz/磁盘/内存/容器池/镜像 tag,共 10 项 |
| `scripts/v5-daily-check.sh` | 日检(每天 09:00 北京时间):计费突增/免单率 + 日报(无告警也发) |
| `deploy/v5/openclaude-v5-monitor.service/.timer` | 探活的 systemd 单元(`OnCalendar=*:0/2`) |
| `deploy/v5/openclaude-v5-daily.service/.timer` | 日检的 systemd 单元(`OnCalendar=*-*-* 09:00:00 Asia/Shanghai`,Persistent 补跑) |
| `/var/lib/openclaude-v5/monitor-state.json` | 探活去重状态(每项 status/since/last_alert) |
| `/var/log/openclaude-v5-monitor.log` | 兜底日志:每轮摘要 + 全部告警正文 + 发送成败 |

## 安装(kl-mirror,一次性)

```bash
# 前置:脚本随 deploy-v5.sh rsync 到 /opt/openclaude/openclaude-v5/scripts/;单元文件手动装
cd /opt/openclaude/openclaude-v5
cp deploy/v5/openclaude-v5-monitor.service deploy/v5/openclaude-v5-monitor.timer \
   deploy/v5/openclaude-v5-daily.service   deploy/v5/openclaude-v5-daily.timer   /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now openclaude-v5-monitor.timer openclaude-v5-daily.timer

# 验证
systemctl list-timers 'openclaude-v5-*'          # 两个 timer 排上了
bash scripts/v5-monitor.sh --dry-run             # 手跑一轮,10 项应全 ok
bash scripts/v5-daily-check.sh --dry-run         # 日报正文预览(不发信)
tail -f /var/log/openclaude-v5-monitor.log       # 2 分钟内应出现 "RUN ok(10 项全过)"
```

依赖:`bash / curl / jq / psql / sqlite3 / docker / systemctl / df / iconv`,kl-mirror 全都有。

## 告警项清单与阈值

### 高频探活(v5-monitor.sh,每 2 分钟)

| 项 | 检查 | 阈值 | 理由 |
|---|---|---|---|
| `svc_v5` | `systemctl is-active openclaude-v5` | ≠active | master 进程死 = v5 全站不可用 |
| `svc_egress` | `systemctl is-active openclaude-v5-egress` | ≠active | LLM 出站面死 = 所有生成挂 |
| `http_v5` | `GET 127.0.0.1:18790/healthz` | 非 `"ok":true` + `channel:"v5"` | 进程活但端口不响应/串台(channel 断言防 v3/v5 错位)。`ok` 含 **sessions.db 深度探活**(`deps.sessionsDb`,master 形态 open+SELECT 1):DB open 失败 = list/save/落库全崩但进程活着,2026-07-06 事故正是此形态两小时无告警;探活失败 healthz 仍回 HTTP 200(不给 LB 摘流量信号),仅 `ok:false` 供本监控与 deploy smoke 消费 |
| `http_egress` | `GET 172.31.0.1:18892/internal/v5/egress-health` | 非 `"ok":true` + `role:"egress"` | 容器出站面探活(容器网段视角) |
| `http_v3` | `GET 127.0.0.1:18789/healthz` | 非 `"ok":true` | 同机共库,v3 挂了殃及池鱼,同样要报 |
| `disk_root` / `disk_var` | `df /` 与 `df /var` 使用率 | >85% | PG/docker/日志都在盘上;85% 留出扩容反应时间(线上当前 73%) |
| `mem` | MemAvailable/MemTotal | <10% | OOM 前兆;容器池机器内存吃紧会连环 OOM kill |
| `pool` | `docker ps` 中 v5-ccb 镜像容器数 | >20 | 灰度期稳态 ~1-5;>20 = 回收失灵或被刷。docker daemon 不响应也在此项报 |
| `image` | `OC_RUNTIME_IMAGE`(env)必须在 `docker images` | 不存在 | tag 漂移(镜像被误删/env 手滑)→ 起新容器全挂,平时无症状,出事才发现 |

**去重语义**:状态翻转才发信 —— 好→坏立即告警(warning),坏→好发恢复(info);坏状态持续时每 **6 小时**重复提醒一次。一轮多项翻转合并为一条站内信。状态文件损坏时自动当首轮重建(坏项会重报一次,安全方向的失误)。

### 日检(v5-daily-check.sh,每天 09:00 北京时间)

| 项 | 口径 | 阈值 | 理由 |
|---|---|---|---|
| 计费突增 | 昨日(北京时间自然日)单用户 `usage_records`(status='success')credits 合计 | > 前 7 日日均 ×3 **且** >2000 | 双条件防误报:倍数抓突变,绝对值滤掉小额用户(10→40 credits 无意义);新用户无历史 → 日均按 0,>2000 即报(首日暴刷值得看一眼) |
| 免单率 | (零输出免单 + 冲正退款笔数) / 昨日成功计费笔数 | >20%(样本 <10 笔不判) | 免单面扩大 = 上游 hang/超时恶化或计费口径 bug;线上基线 ~7%(2026-07-05:19/276),20% 为基线 ~3 倍 |
| 日报正文 | v5 近 24h 活跃用户数/会话数(sessions.db `client_sessions`,`deleted_at IS NULL`)、错误日志行数(`"level":"error"`)、昨日计费笔数/总消耗 | 无(纯日报) | 即使无告警也发一条 info,兼作"监控还活着"的心跳 |

免单两种形态的落库形状(与代码对齐):
- **零输出免单**(`proxyBilling.ts` waivedNoOutput):`usage_records` `status='success' AND cost_credits=0 AND output_tokens=0 AND (input/cache tokens > 0)`;
- **turn 级冲正退款**(`billing/refund.ts`):`credit_ledger` `reason='refund' AND ref_type='usage_record'`,按 `ref_id` 去重计笔。

## 告警通道

**首选:站内信**。脚本用 psql 直接 INSERT 共享 PG 的 `inbox_messages`(0046 迁移):
`audience='user', user_id=1, level='warning'|'info', created_by=1`,`notify_email` 默认 FALSE(不触发邮件 worker)。
表约束:title ≤200 字符、body ≤16384 字符、level ∈ (info,notice,promo,warning) —— 脚本已按此截断(UTF-8 安全)。

**boss uid=1 依据**:`users` 表 id=1(1193355375@qq.com)是全库最早注册(2026-04-20)且 `role='admin'` 的账号;与仓内 `inbox/onboarding.ts` `resolveSystemAdminId()`(取最小 admin id 作 system 发件人)同一语义。另一个 admin(id=35,admin-temp-2026@)是临时号,不用。

**兜底:监控日志**。所有轮次摘要、告警正文、INSERT 成败全部带时间戳落 `/var/log/openclaude-v5-monitor.log`;站内信发送失败不影响脚本其余检查,正文仍在日志里。

**可选增强(未默认启用):微信推送**。调研发现既有 admin 告警体系(`admin/alertEvents.ts` + `admin_alert_outbox` 表 + v3 gateway dispatcher),线上已有 enabled 的 `ilink_wechat` channel(admin_alert_channels id=4,admin_id=1,severity_min=warning)—— 往 `admin_alert_outbox` INSERT 一行(`event_type/severity/title/body/channel_id=4`)会被 **v3** 进程的 dispatcher 捞走推微信。没有默认启用的原因:①事件类型白名单权威在代码(`EVENT_META`),外部 INSERT 绕过 enqueue 校验,属于旁路写;②依赖 v3 进程活着(v3 挂了恰是要告警的场景之一,通道自身成为故障域);③本轮红线是不改业务代码,正解是给 alertEvents 登记 `health.v5_monitor` 事件类型后走 enqueue。需要时再做。

## 阈值调整

全部阈值是两个脚本顶部的显式常量,改完无需 reload(oneshot 每次全新执行):

```
scripts/v5-monitor.sh:      DISK_MAX_PCT / MEM_MIN_AVAIL_PCT / POOL_MAX / REALERT_SECS
scripts/v5-daily-check.sh:  SPIKE_ABS_MIN / SPIKE_MULT / WAIVE_PCT_MAX / WAIVE_MIN_SAMPLES
```

注意:脚本经 `deploy-v5.sh` rsync 分发,**线上直接改会被下次部署覆盖** —— 改阈值要改在仓里(worktree → canonical → 部署),和其他 v5 代码同纪律。

## 如何静默

```bash
# 整体停(维护窗口等)
systemctl stop openclaude-v5-monitor.timer        # 恢复:start
systemctl disable --now openclaude-v5-monitor.timer   # 长停

# 单项静默(如 v3 计划内维护不想收 http_v3 告警)
systemctl edit openclaude-v5-monitor.service
# [Service]
# Environment="V5MON_SKIP=http_v3"      ← 逗号分隔多项;删掉 drop-in 即恢复
systemctl daemon-reload
```

被 SKIP 的项不评估、不写状态;恢复后首轮按当前真实状态重新建档(若仍坏会当"新坏"报一次)。

坏状态"已知悉不用再提醒":暂无 ack 机制,6h 提醒频率有意保持克制;实在吵就临时 SKIP 该项。

## 已知局限

1. **零输出免单是近似口径**:waive 标记只进结构化日志不落库,SQL 按"success + cost=0 + output=0 + 有 input/cache"反推。零价模型(如内部免费模型)的零输出行会被误计入分子;当前定价下无此形态,风险登记备查。
2. **计费突增/免单率是 v3+v5 共库口径**:`usage_records`/`credit_ledger` 无 channel 列,无法只看 v5 用户。同机共库阶段这反而是 feature(v3 计费异常同样该报);v5 全量切换后如需分流,以 `users.v5_migrated_at` join 过滤。
3. **错误日志行数窗口是 UTC 自然日**:logrotate 在 00:00 UTC 轮转,`.log.1`=昨日(UTC)全天、`.log`=今日 0 点起,与日报的北京时间自然日错位 8 小时。日报里两个数并列展示,够定性;要精确 24h 得按行内 ts 过滤,不值得加复杂度。
4. **站内信非实时推送**:boss 要打开 v5 才看到。硬故障(master 挂)监控 2 分钟内能写库,但触达延迟取决于人;需要强触达时启用上面的微信可选增强。
5. **v5 master 与监控同机**:机器整个宕机(非进程级故障)时监控自身也死,无告警。异机哨兵不在 P0.3 范围,登记为后续增强。
6. **`http_egress` 从宿主机探测** 172.31.0.1:18892,验证的是 egress 进程活着且形状对;不等价于容器内视角的连通性(iptables/网段问题理论上探测不到,历史上未发生过)。
