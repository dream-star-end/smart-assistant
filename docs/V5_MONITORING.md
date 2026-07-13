# V5 监控告警最小集(roadmap P0.3)

> ops 极简哲学:两个 systemd timer + 两个 bash 脚本,不引外部监控系统。
> 告警首选 v5 站内信(发给 boss),全量兜底落 `/var/log/openclaude-v5-monitor.log`。
> 最后校准:2026-07-13。

## 组成

| 文件 | 作用 |
|---|---|
| `scripts/v5-monitor.sh` | 高频探活(每 2 分钟):服务/internal+public healthz/磁盘/内存/容器池/镜像 tag；v3 默认关闭 |
| `scripts/v5-daily-check.sh` | 日检(每天 09:00 北京时间):计费突增/免单率/GPT-5.6 按模型缓存命中率 + 日报(无告警也发) |
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
bash scripts/v5-monitor.sh --dry-run             # 手跑一轮,全部 serving/宿主项应全 ok
bash scripts/v5-daily-check.sh --dry-run         # 日报正文预览(不发信)
tail -f /var/log/openclaude-v5-monitor.log       # 2 分钟内应出现 "RUN ok(...项全过)"
```

依赖:`bash / curl / jq / psql / sqlite3 / docker / systemctl / df / iconv`,kl-mirror 全都有。

## 告警项清单与阈值

### 高频探活(v5-monitor.sh,每 2 分钟)

| 项 | 检查 | 阈值 | 理由 |
|---|---|---|---|
| `deploy_state` | 读取并校验 serving lane 权威单行 | PG 不可达、行缺失或字段非法 | 独立 critical 人工告警；无 auto-repair policy，不把状态不可读冒充服务故障 |
| `svc_v5` | 按 `deploy_state` 探测当前主 serving slot(A/B)的 unit | ≠active | 不再固定猜 A；stable 跟 active，finalizing step≥6 跟 candidate；状态不可裁决时保留最后已知值 |
| `svc_candidate_v5` | 仅 candidate 真实 serving 时独立探测其 unit | ≠active；不 serving 时记 `ok/not-serving` | canary READY、finalizing/aborting 的双服务窗口不能被主 lane 绿灯遮蔽；命名刻意不落入 `svc_v5` 自愈 policy prefix |
| `svc_egress` | `systemctl is-active openclaude-v5-egress` | ≠active | LLM 出站面死 = 所有生成挂 |
| `http_v5` | 按 `deploy_state` GET 当前主 serving slot 的 healthz(A=18790/B=18795) | 非 `"ok":true` + `channel:"v5"` | 进程活但端口不响应/串台；`ok` 含 sessions.db 深度探活 |
| `http_candidate_v5` | candidate 真实 serving 时独立 GET 其 healthz | 同上；不 serving 时记 `ok/not-serving` | 双 lane 独立故障边，候选坏不会被 active 正常掩盖；不会误命中 `http_v5` 的全站自动修复 policy |
| `http_egress` | `GET 172.31.0.1:18892/internal/v5/egress-health` | 非 `"ok":true` + `role:"egress"` | 容器出站面探活(容器网段视角) |
| `public_route` | `Host: claudeai.chat GET 127.0.0.1/healthz` | 非 `"ok":true` + `channel:"v5"` | 覆盖 Caddy→v5 的真实公网路由，能直接发现 Cloudflare 502 的源头 |
| `http_v3` | `GET 127.0.0.1:18789/healthz` | 非 `"ok":true` | v3 已退役，默认不运行；仅显式 `V5MON_CHECK_V3=1` 时保留兼容检查 |
| `disk_root` / `disk_var` | `df /` 与 `df /var` 使用率 | >85% | PG/docker/日志都在盘上;85% 留出扩容反应时间(线上当前 73%) |
| `mem` | MemAvailable/MemTotal | <10% | OOM 前兆;容器池机器内存吃紧会连环 OOM kill |
| `pool` | `docker ps` 中 v5-ccb 镜像容器数 | >20 | 灰度期稳态 ~1-5;>20 = 回收失灵或被刷。docker daemon 不响应也在此项报 |
| `image` | `OC_RUNTIME_IMAGE`(env)必须在 `docker images` | 不存在 | tag 漂移(镜像被误删/env 手滑)→ 起新容器全挂,平时无症状,出事才发现 |

Serving lane 派生矩阵：`stable` 与 `canary step<READY(10)` 只看 active；`canary
step>=10`、`finalizing step<6`、`aborting step<2` 同时看 active+candidate；
`finalizing step>=6` 只把 candidate 作为 generic serving；`aborting step>=2` 只看旧
active。`deploy_state` 读取失败或字段非法时，独立 `deploy_state` check 立即 bad；
`svc_v5/http_v5` 不写新 condition、保留状态文件里的最后已知值，绝不回退猜 A 或误触发自动部署。

**去重语义**:状态翻转才发信 —— 好→坏立即告警(warning),坏→好发恢复(info);坏状态持续时每 **6 小时**重复提醒一次。一轮多项翻转合并为一条站内信。状态文件损坏时自动当首轮重建(坏项会重报一次,安全方向的失误)。

### 日检(v5-daily-check.sh,每天 09:00 北京时间)

| 项 | 口径 | 阈值 | 理由 |
|---|---|---|---|
| 计费突增 | 昨日(北京时间自然日)单用户 `usage_records`(status='success')credits 合计 | > 前 7 日日均 ×3 **且** >2000 | 双条件防误报:倍数抓突变,绝对值滤掉小额用户(10→40 credits 无意义);新用户无历史 → 日均按 0,>2000 即报(首日暴刷值得看一眼) |
| 免单率 | (零输出免单 + 冲正退款笔数) / 昨日成功计费笔数 | >20%(样本 <10 笔不判) | 免单面扩大 = 上游 hang/超时恶化或计费口径 bug;线上基线 ~7%(2026-07-05:19/276),20% 为基线 ~3 倍 |
| GPT-5.6 缓存命中 | 今日(北京时间 0 点至当前)成功 `usage_records`,按 `model` 分组;`cache_read_tokens / (input_tokens + cache_read_tokens)` 加权计算。基线取今日之前最近 3 个有正输入的活跃日并按总 token 加权;同时报 Top 用户/非空会话输入集中度 | 当前总输入 ≥5,000,000 且 records ≥10,并满足“<70%”或“<85%、较三活跃日基线下降 ≥15pp 且基线总输入 ≥5,000,000” | 绝对低线抓真实异常,相对基线抓模型自身退化;样本双门过滤低流量抖动。Top 集中度用于识别单个长会话主导的假全局告警 |
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
scripts/v5-daily-check.sh:  SPIKE_ABS_MIN / SPIKE_MULT / WAIVE_PCT_MAX / WAIVE_MIN_SAMPLES / CACHE_SAMPLE_MIN_INPUT / CACHE_MIN_RECORDS / CACHE_ABSOLUTE_LOW_BPS / CACHE_REGRESSION_LOW_BPS / CACHE_DROP_MIN_BPS
```

注意:脚本经 `deploy-v5.sh` rsync 分发,**线上直接改会被下次部署覆盖** —— 改阈值要改在仓里(worktree → canonical → 部署),和其他 v5 代码同纪律。

## 计划维护与静默

`deploy-v5.sh` 会在真正 restart 前原子写入 root:root 0600 的
`/run/openclaude-v5/planned-maintenance.json`：

- schema=1：受控离线状态机使用，固定覆盖 `svc_v5/http_v5/public_route`。
- schema=2：普通 deploy/dist/rollback 使用，TTL 最长 180 秒；writer 会在写 marker
  前即时探测，只把当时明确健康、且本次操作会短暂中断的检查写入 `checks`。`--egress`
  部署才可能额外包含 `svc_egress/http_egress`。

有效窗口内，新出现的 scoped 失败标成 planned，不发 outbox/inbox，也不写 firing
condition；部署前已经是 bad 的检查绝不被压制。smoke 完成后脚本按 schema+nonce 在远端
共享锁内清理 marker；monitor 也在同一锁下只读复制一次 JSON snapshot 再校验。异常退出会
best-effort 清理，SIGKILL/断网则由 TTL 兜底。过期 schema=1 只有在 marker/manifest 可信且
master+公网三项已恢复健康时才由下次普通部署安全清除；否则保留 marker、但部署继续且告警
fail-open，不会形成永久部署死锁。窗口结束后
仍 bad 会立即按真实事故告警，已经恢复则安静回到 ok。marker 类型、权限、host、commit、
TTL、scope 任一不合法或过期都 fail-open。不要手工创建或删除 marker。

```bash
# 只有排障噪音时才人工单项 SKIP；不要停整个监控 timer。
systemctl edit openclaude-v5-monitor.service
# [Service]
# Environment="V5MON_SKIP=pool"      ← 逗号分隔多项;删掉 drop-in 即恢复
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
7. **缓存命中日检是 usage record/模型级汇总**:`usage_records` 保存每次成功结算的聚合 usage,无法还原一个 turn 内每次上游调用是否全 miss。该指标适合发现模型级持续退化,定位单次 miss 仍需结合 relay 日志(只记录关键头是否存在,不记录头值)。
