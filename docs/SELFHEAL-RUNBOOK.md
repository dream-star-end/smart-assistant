# SELFHEAL-RUNBOOK — v5 全链路自愈体系上线 runbook

> 依据:selfheal-final-design §D 部署顺序(R2 BLOCKER4 修:每步显式重启点+生效核对)。
> **严格按序执行,每步做完核对"预期输出"再进下一步;任何一步核对不过,先执行该步"回滚"再排查。**
>
> 机器约定:
> - **本机** = 个人版 gateway(sg,`openclaude.service`,端口 18789,env=`/etc/openclaude/secrets.env` + drop-in `selfheal.env`)
> - **kl-mirror** = v5 生产(`openclaude-v5.service`,master healthz 18790,env=`/etc/openclaude/commercial-v5.env`)
> - 密钥 stage:`/root/.secrets/v5-selfheal/`(master-secret / webhook-hmac / verification-hmac / tunnel_key{,.pub}),**双机留底,勿删**。

---

## 步骤 1:个人版代码面(dormant 合并)

selfheal env 未设 = 全部代码 dormant,合并后零行为变化。

**命令**

```bash
# 在个人版 canonical 树合并 feat/selfheal-repair(走 parallel-worktree-workflow 常规合并)
cd /opt/openclaude/openclaude
git merge --ff-only feat/selfheal-repair   # 或既有合并流程
# safe-restart(个人版既有发版脚本/SOP)
systemctl restart openclaude.service
```

**预期输出**

```bash
systemctl is-active openclaude.service        # => active
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18789/api/doctor   # => 200(或既有 smoke)
grep -i selfheal /var/log/openclaude.log | tail    # 无装配日志(env 未设 => dormant),无报错
```

**回滚**:`git reset --hard <合并前 sha>`(canonical,合并 commit 未推可 revert)→ restart。selfheal dormant,回滚风险≈0。

---

## 步骤 2:v5 面(迁移 → 合并 → env 预置双关 → deploy)

### 2.1 PG 迁移 apply(0133 → 0134 → 0135,additive 在线)

**⚠️ 0136 本步骤【只进仓不 apply 不登记】,见步骤 5。**

记账 SOP(V5_DEV_PLAYBOOK §4.5,0096+ 惯例;**每个迁移一个事务,必须显式 COMMIT,版本=文件名去 `.sql`**):

```bash
ssh kl-mirror
DBURL=$(grep ^DATABASE_URL= /etc/openclaude/commercial-v5.env | cut -d= -f2-)
psql "$DBURL" -v ON_ERROR_STOP=1
```

```sql
-- 对 0133 / 0134 / 0135 逐个执行(文件在 packages/commercial/src/db/migrations/,先 scp 到 kl-mirror):
BEGIN;
\i /tmp/0133_<name>.sql
INSERT INTO schema_migrations(version, applied_at)
  VALUES ('0133_<name>', now()) ON CONFLICT DO NOTHING;
COMMIT;
-- 同法 0134、0135
```

**预期输出**:每个事务 `COMMIT` 无报错;核对:

```sql
SELECT version FROM schema_migrations WHERE version LIKE '013%' ORDER BY version;
-- 含 0133/0134/0135 三行(以及历史 0130-0132 等),【不含 0136】
SELECT proname FROM pg_proc WHERE proname='write_alert_condition';   -- 1 行
```

**回滚**:additive 迁移不回滚(空表/新列无害);若中途失败,事务自动 ROLLBACK,修复 SQL 后重跑该迁移即可(记账行 ON CONFLICT 幂等)。

### 2.2 合并 canonical + 迁移登记

feat/v5-selfheal → feat/v5-aurora-rewrite canonical,合并时 `release-metadata.json` requiredMigrations 登记 **0133/0134/0135**(0136 不登记——先登记会挡部署)。

### 2.3 env 预置(双关,先于 deploy)

R3 HIGH1:`OC_SELFHEAL_DISABLED=1` 整体不启 reconciler/sweeper,杜绝部署后 10s 内投影 stale condition。

```bash
ssh kl-mirror
cp /etc/openclaude/commercial-v5.env /etc/openclaude/commercial-v5.env.bak-$(date +%F)
# 追加(值从本机 /root/.secrets/v5-selfheal/ 对应文件取,双机一致):
cat >> /etc/openclaude/commercial-v5.env <<'EOF'
OC_SELFHEAL_MASTER_SECRET=<master-secret 文件内容>
OC_SELFHEAL_WEBHOOK_HMAC=<webhook-hmac 文件内容>
OC_SELFHEAL_DISPATCH_URL=http://127.0.0.1:18795
OC_SELFHEAL_DISPATCH_DISABLED=1
OC_SELFHEAL_DISABLED=1
EOF
# V5MON_CONDITIONS 此时【不设】(默认关)
```

### 2.4 deploy + 生效核对

```bash
# 本机,走 v5-commercial-deploy skill 常规链路(master+dist+monitor.sh 随 release,自带重启)
./scripts/deploy-v5.sh ...
```

**预期输出**

- deploy smoke 全 PASS;`/version` = 新 release sha。
- **effective config 核对**:kl-mirror 日志/healthz 确认 selfheal **未装配**(`OC_SELFHEAL_DISABLED=1` 生效,无 reconciler/sweeper 启动日志);`V5MON_CONDITIONS` 未设,monitor 不写 condition:

```bash
ssh kl-mirror "journalctl -u openclaude-v5 --since '-5min' | grep -i selfheal"   # 只应见 disabled/skip 日志
ssh kl-mirror "DBURL=...; psql \"\$DBURL\" -c \"SELECT count(*) FROM admin_alert_rule_state WHERE observed_at > now()-interval '10 minutes'\""  # => 0(无新写入)
```

**回滚**:hotcfg 回滚上一 release(`deploy-v5.sh --rollback`);env 还原 bak;迁移不回滚。

---

## 步骤 3:观察层激活(检测→incident→推送,仍无派单)

### 3.1 stale firing inventory(激活前必做)

防新 reconciler 首启用旧 legacy condition 误开 incident:

```sql
-- kl-mirror psql
SELECT rule_id, firing, level, mode, observed_at
  FROM admin_alert_rule_state
 WHERE firing
 ORDER BY observed_at;
```

**逐行处置**:
- legacy 死 key(如 `provider_health:*` —— 已被 `health.provider_degraded:<id>` 取代):关闭 —— `UPDATE admin_alert_rule_state SET firing=false WHERE rule_id='<key>';`(此时 0136 trigger 未装,直写允许;装 0136 后此法失效)。
- 真实仍 firing 的 condition:先处置底层故障或确认属实(属实则保留,激活后会正常开 incident——这是预期)。

**预期输出**:`WHERE firing` 只剩"确认属实"的行(理想为 0 行)。

### 3.2 激活

```bash
ssh kl-mirror
cp /etc/openclaude/commercial-v5.env /etc/openclaude/commercial-v5.env.bak-$(date +%F)-step3
# ① 置 V5MON_CONDITIONS=1(monitor.sh oneshot 每轮重读,即时生效)
# ② 删 OC_SELFHEAL_DISABLED=1 行(reconciler/sweeper 随重启装配)
# ③ OC_SELFHEAL_DISPATCH_DISABLED=1 【保留】(本步仍不派单)
vim /etc/openclaude/commercial-v5.env
systemctl restart openclaude-v5
```

**预期输出(全链 smoke,无派单)**

```bash
ssh kl-mirror "journalctl -u openclaude-v5 --since '-3min' | grep -iE 'selfheal.*(reconciler|sweeper|start)'"  # 装配日志出现
# 等 monitor 下一轮(≤2min)后:
# psql: SELECT rule_id, firing, observed_at FROM admin_alert_rule_state WHERE rule_id LIKE 'ops.monitor:%' ORDER BY observed_at DESC LIMIT 15;
#   => 11 项 check 有新 observed_at(firing 视实况)
# 若有属实 firing:admin selfheal 页出现 incident(107c5967 后 incident 是纯内部账本,
# **不再**推 WS banner/inbox;用户通知只走 userNoticeApproval 审批出口);
# dispatch 日志确认被 DISPATCH_DISABLED=1 挡住
```

**回滚**:env 还原(`V5MON_CONDITIONS` 删 / `OC_SELFHEAL_DISABLED=1` 加回)→ `systemctl restart openclaude-v5`。

---

## 步骤 4:执行侧激活(provision → 隧道 → 开闸 → E2E)

### 4.1 本机 provision

```bash
cd /opt/openclaude/openclaude
bash scripts/selfheal-provision.sh --dry-run          # 先看动作清单
bash scripts/selfheal-provision.sh                    # 低风险面落盘(目录/CLI/env 模板)
# 核对打印的 agents.yaml 片段与 drop-in 内容后:
bash scripts/selfheal-provision.sh --apply-agents --apply-unit --apply-packages
```

Provision 还会检查 `ocheal` 的 Codex 登录。目标
`/home/ocheal/.codex/auth.json` 已存在时只校验/修正 owner 和 `0600` 权限，绝不覆盖；
缺失时才从 root 当前有效的 Codex 登录做一次不回显内容的安全引导。任何 `.codex` / `auth.json`
软链接或非预期文件类型都会 fail closed。开派发闸前，清单必须出现
`Codex login status valid for ocheal`。

**预期输出**:结尾 checklist 除 "kl-mirror authorized_keys"、"tunnel unit" 两条 TODO(4.3 处置)外全 OK。

### 4.2 safe-restart 个人版 + 核对

```bash
systemctl restart openclaude.service
# broker socket 就位:
test -S /run/openclaude-selfheal/broker.sock && stat -c '%U:%G %a' /run/openclaude-selfheal/broker.sock
# receiver 路由已注册(未签名请求应得 401/403 = fail-closed,404 = 路由没挂):
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:18789/api/webhooks/v5-selfheal-cancel -d '{}'
```

**预期输出**:socket 存在;curl 返回 **401 或 403**(绝不能 404/200)。
**回滚**:drop-in `selfheal.conf` 移除(或 `OC_SELFHEAL_BROKER_SOCK` 从 selfheal.env 注释)→ restart → 回到 dormant。

### 4.3 隧道

```bash
# ① kl-mirror 侧装限权行(provision 步骤7 已打印实值):
ssh kl-mirror 'cat >> ~/.ssh/authorized_keys' <<'EOF'
restrict,no-pty,no-agent-forwarding,no-X11-forwarding,permitopen="127.0.0.1:18790",permitlisten="127.0.0.1:18795" <tunnel_key.pub 内容>
EOF
# ② 本机装单元(不随 deploy 自动装):
cp deploy/openclaude-selfheal-tunnel.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now openclaude-selfheal-tunnel.service
```

**预期输出**

```bash
systemctl is-active openclaude-selfheal-tunnel        # => active
ss -ltnp | grep 18796                                 # 本机 18796 监听(→ kl 18790)
ssh kl-mirror 'ss -ltnp | grep 18795'                 # kl-mirror 18795 监听(→ 本机 18789)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18796/healthz   # v5 master healthz 经隧道 => 200
```

**回滚**:`systemctl disable --now openclaude-selfheal-tunnel`;kl-mirror 删 authorized_keys 该行。

### 4.4 kl-mirror 开派单闸(drill-only 姿态)

> **前置(批0 裁定,2026-07-16)**:开闸前先把 **9 类真实 policy 全部
> `auto_repair=FALSE`**(闸一直关着,该变更零行为差异),只留 0155 的 drill
> policy 可被演练脚本临时翻开。真实类逐个放开的前置条件在 playbook §5 债表
> (host-routed Tier1 / 外部 watchdog)。

```bash
ssh kl-mirror
# ① 迁移 0155(drill policy seed;同 2.1 记账 SOP)
# ② 真实 policy 全关派单:
#    UPDATE incident_policies SET auto_repair=FALSE, updated_at=NOW() WHERE match_key <> 'selfheal.drill:transport_v1';
# ③ 开闸:
cp /etc/openclaude/commercial-v5.env /etc/openclaude/commercial-v5.env.bak-$(date +%F)-step4
sed -i 's/^OC_SELFHEAL_DISPATCH_DISABLED=1/OC_SELFHEAL_DISPATCH_DISABLED=0/' /etc/openclaude/commercial-v5.env
systemctl restart openclaude-v5
grep -i 'selfheal' /var/log/openclaude-v5.log | tail -5   # 不再出现 selfheal_dispatch_disabled 警告
```

**核对**:`SELECT match_key, auto_repair, enabled FROM incident_policies ORDER BY id;`
—— 仅 drill 行允许被脚本翻 auto_repair;其余全 FALSE。
**回滚**:`DISPATCH_DISABLED=1` 改回 + restart。

### 4.5 transport 演练(全链 E2E,固化为一等公民)

> 手写 synthetic SQL 的旧法已废弃(`ops.monitor:synthetic_e2e` 不命中任何
> policy,不会派单;且 107c5967 后 incident 不推 WS banner)。演练一律走
> 编排脚本 —— 它持 advisory lock、断言九个检查点、异常自动安全清场。

```bash
ssh kl-mirror
cd "$(readlink -f /opt/openclaude/openclaude-v5)"   # 蓝绿 release 树权威入口
set -a && . /etc/openclaude/commercial-v5.env && set +a
npx tsx scripts/v5-selfheal-drill.ts              # 完整演练(九点全绿才算过)
npx tsx scripts/v5-selfheal-drill.ts              # 连跑第二次:验证 cooldown 豁免 + 可重复回归
```

**九个检查点(脚本自动断言,人工只看输出)**:
1. 预检:无活跃 repair、无其它可派单 incident、drill policy 姿态正确;
2. `write_alert_condition` 落 firing=true(单写权威);
3. reconciler 开 incident(纯内部账本,**无**用户广播);
4. sweeper/dispatcher 派单 → 隧道 18795 → `codex_repairs` 离开 pending;
5. 执行侧 ack/progress 回调(隧道 18796 + broker 通路);
6. `report done` 后 repair=**verifying**(绝不直达 succeeded;verify_after 冻结);
7. 零用户侧副作用(无 delivery、无 user-notice proposal);
8. 恢复观测晚于 verify_after(freshness fence);
9. sweeper 同事务 `repair=succeeded + incident=resolved + resolve_source='codex'`
   (probe 抢跑=P3 守卫回归,脚本会 FAIL)。

**执行侧语义**:drill repair 被个人版 broker 服务端白名单限制为 context/report
(verify/cutover/Tier1 一律拒绝,audit 记 `drill_forbidden_action`);codex 会话按
skill drill 分支两步收尾,不改代码。
**卡住/中断**:`npx tsx scripts/v5-selfheal-drill.ts --cleanup`(先关 auto_repair
再翻 condition false,防再派);止血兜底 = kl `DISPATCH_DISABLED=1` + restart。
**注意**:Tier2 release 演练(真 commit→verify→pending_release→一键放行→deploy)
是单独的低峰专项,**不在**日常 drill 内 —— 见 playbook §5 债表登记。

---

## 步骤 5:writer-guard trigger(单写权威,当前=有意 deferred)

> **口径更正(2026-07-16 批0)**:`schema_migrations` 里有 `0136_selfheal_writer_guard`
> 记账行,但 **trigger 并未生效** —— 0137 迁移显式 `DROP TRIGGER/FUNCTION` 并把
> 真实 SQL 移驻 `packages/commercial/src/db/deferred/selfheal_writer_guard.sql`
> (0137 文件头有说明:当时回滚池仍含旧 writer,统一收敛回"暂缓 guard")。
> **验收 guard 是否生效只能查 pg_trigger,绝不能看 schema_migrations。**

**双重门(R2 HIGH1),两门全过才启用:**

1. **门①**:新 master(function 写路径)已上线 —— 已满足。
2. **门②**:回滚池内不再有直写检测列的旧 release —— 核对 `deploy-v5.sh --rollback` 候选列表,**全部 ≥ selfheal 合并点**。

**启用方式(过双重门后)**:把 `db/deferred/selfheal_writer_guard.sql` 以**新的迁移版本号**
(如 `01XX_selfheal_writer_guard_enable.sql`)入仓 → apply + 记账 → 下一版才登记
release-metadata requiredMigrations。**不要**复用 0136 版本号(已被 0137 消费为"暂缓"语义)。

```sql
-- 启用后核对:
SELECT tgname FROM pg_trigger WHERE tgname LIKE '%alert_condition%';   -- 1 行=生效
-- 负例:直写检测列应被拒(operator 列 ack_*/suppressed_* 仍放行)
```

**回滚**:`DROP TRIGGER ... ON admin_alert_rule_state;`(function 写路径不受影响)。

---

## 步骤 6:watchdog + selector 迁移(独立小窗口)

与自愈主链解耦,单独找低峰窗口(参照 release-checklist):

1. **selector 首次迁移**:`scripts/egress-selector-migrate.ts`(root CLI,调 migrateEgressToSelector,一次性);核对 `/api/egress-proxy/refresh` 走 `resyncEgressSelector`(未迁移时 fallback refreshEgressNodes,C5/MED16)。
2. **watchdog systemd 两单元** 安装启用 + `/etc/openclaude/egress-watchdog.env`(`EGW_WECOM_KEY_FILE` 指向企微 key 文件)。
3. smoke:代理出口可用、watchdog 日志一轮探测正常、故障注入(可选)告警到达。

**回滚**:停 watchdog 两单元;selector 迁移保持(幂等,回退无收益)。

---

## 步骤 7:记忆 + playbook 固化

上线完成后固化到 MEMORY.md + V5_DEV_PLAYBOOK:

- **0136 顺序铁律**(双重门 + "apply 后下一版才登记 metadata");
- **监控激活门**(V5MON_CONDITIONS 默认关,激活前 stale firing inventory);
- **release 通路**(admin 一键放行 → 隧道 → releaseApproved;break-glass root-only 入口);
- 隧道端口语义(18795/18796)与 key 限权行;
- 步骤 5 若未 apply:债表条目与触发条件。

---

## 附录 A:env 双机清单

| 机器 | 文件 | 键 | 值/来源 |
|---|---|---|---|
| kl-mirror | `/etc/openclaude/commercial-v5.env` | `OC_SELFHEAL_MASTER_SECRET` | `/root/.secrets/v5-selfheal/master-secret`(双机同步) |
| kl-mirror | 同上 | `OC_SELFHEAL_WEBHOOK_HMAC` | `webhook-hmac`(与个人版一致) |
| kl-mirror | 同上 | `OC_SELFHEAL_DISPATCH_URL` | `http://127.0.0.1:18795`(隧道 -R) |
| kl-mirror | 同上 | `OC_SELFHEAL_DISPATCH_DISABLED` | 初始 `1`,步骤 4.4 置 `0` |
| kl-mirror | 同上 | `OC_SELFHEAL_DISABLED` | 初始 `1`,步骤 3.2 删除 |
| kl-mirror | 同上 | `V5MON_CONDITIONS` | 初始不设,步骤 3.2 置 `1` |
| 本机 | `/etc/openclaude/selfheal.env`(provision 生成,0600) | `OC_SELFHEAL_WEBHOOK_HMAC` / `OC_SELFHEAL_VERIFY_HMAC` | `webhook-hmac` / `verification-hmac` |
| 本机 | 同上 | `OC_SELFHEAL_CALLBACK_URL` | `http://127.0.0.1:18796`(隧道 -L) |
| 本机 | 同上 | `OC_SELFHEAL_BROKER_SOCK` | `/run/openclaude-selfheal/broker.sock` |
| 本机 | 同上 | `OC_SELFHEAL_OCHEAL_UID/GID/HOME` | `id ocheal` 实测(997/997)/ `/home/ocheal` |
| 本机 | 同上 | `OC_SELFHEAL_CANONICAL_DIR` | `/opt/openclaude/openclaude-v5-aurora` |
| 本机 | 同上 | `OC_SELFHEAL_RESTART_UNITS` | `openclaude-v5.service` |
| 本机 | 同上 | `OC_SELFHEAL_AUTO_DEPLOY_TIER2` | `0`(boss 拍板后才可置 1) |
| 本机 | 同上 | `OC_SELFHEAL_WECOM_WEBHOOK` | qyapi robot URL(2026-07 已配;国内直连禁代理) |
| 本机 | 同上 | `OC_SELFHEAL_TIER1_ENABLED` | **不设=关**(批0 正向闸:Tier1 实现在本机执行、目标在 kl-mirror=错宿主;host-routed 执行器落地前禁止置 1) |

改 kl-mirror env 遵守 V5_DEV_PLAYBOOK §4.4:先 `cp env env.bak-<date>`,bootstrap 才会重新生成,平时手工同步。

## 附录 B:常用排查查询

```sql
-- stale/当前 firing 面板
SELECT rule_id, firing, level, mode, observed_at FROM admin_alert_rule_state WHERE firing ORDER BY observed_at;
-- 被压制的 condition(A1 suppression)
SELECT rule_id, suppressed_at, suppressed_by FROM admin_alert_rule_state WHERE suppressed_until_clear;
-- repair 生命周期
SELECT id, incident_id, status, attempt, updated_at FROM codex_repairs ORDER BY updated_at DESC LIMIT 20;
SELECT repair_id, kind, message, created_at FROM codex_repair_events WHERE repair_id=<id> ORDER BY created_at;
```

本机侧 ground truth:`selfheal_jobs`(个人版 selfheal.db)、`/home/ocheal/selfheal/<repairId>` clone、`/var/lib/openclaude-selfheal/verifications/` 签名、broker_actions 幂等记录。

## 附录 C:一页回滚矩阵

| 层 | 止血动作 | 影响面 |
|---|---|---|
| 派单 | kl `DISPATCH_DISABLED=1` + restart | 停新派单,检测/推送保留 |
| selfheal 整体 | kl `OC_SELFHEAL_DISABLED=1` + restart | reconciler/sweeper 全停 |
| 观察层 | kl `V5MON_CONDITIONS` 删 | monitor 停写 condition |
| 隧道 | `systemctl stop openclaude-selfheal-tunnel` | 双向断,派单/回调均 fail-closed |
| 本机执行侧 | 移除 drop-in(或注释 BROKER_SOCK)+ restart | 回 dormant |
| 0136 | `DROP TRIGGER guard_alert_condition_write ...` | 回到应用层约束 |
