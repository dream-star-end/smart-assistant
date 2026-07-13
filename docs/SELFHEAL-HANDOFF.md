# v5 自愈运维体系 — 阶段性交接(2026-07-12)

> **状态:代码全部完成并通过 Codex 设计审 + 实现安全审计(PASS)。零部署。**
> 剩余工作 = 测试对照收尾 + 合并 canonical + 分级上线(运维密集,非编码)。

---

## 1. 交接坐标

| 面 | 分支 | worktree | HEAD | 已 push |
|---|---|---|---|---|
| v5 商业版(检测/投影/派单/admin) | `feat/v5-selfheal`(基 `feat/v5-aurora-rewrite`) | `/opt/openclaude/openclaude-v5-selfheal` | `8c6c6185` | ✅ origin |
| 个人版(执行侧 codex 修复) | `feat/selfheal-repair`(基 `master`) | `/opt/openclaude/openclaude-selfheal` | `48cf5099` | ✅ origin |

两侧工作树干净,无未提交改动。**生产零改动**(未合并、未部署、未 provision)。

**权威文档**:
- 主 RFC(4 轮设计审 PASS):`docs/rfcs/RFC-v5-selfheal-ops.md`(v5 worktree)
- 收尾批设计(5 轮设计审 PASS):`/tmp/claude-0/-root/f6c43c65-9e65-478f-909f-ca6bfb24365e/scratchpad/selfheal-final-design.md`
  ⚠️ 在 scratchpad,**接手第一件事:拷进仓**(`docs/rfcs/` 下),否则会随会话清理丢失。
- 上线 runbook(七步,含命令/预期/回滚):`docs/SELFHEAL-RUNBOOK.md`(个人版 worktree)

---

## 2. 已完成(16 commit,两侧)

**v5 侧(7 commit)**:地基迁移 0133 + 模块(policy/conditions/incidents/reconciler/sweeper/dispatcher/capability)+ SysIncident 帧 + bridge 广播 + 前端横幅/恢复 toast + admin 自愈页 → 安全整改(B2 隐私泄露 / H1a 假恢复 / H2 派单 TOCTOU / H3 并发时序,迁移 0134)→ **本批收尾**:H1b suppression、H2-cancel、B1 检测桥、M1-M5+L1 硬化、B3 配置、admin 压制/放行 UI(迁移 0135 + 0136)→ 审计修复两轮。

**个人版侧(9 commit)**:durable 接收/执行 + OS 降权(setpriv/ocheal)+ broker + 代理主备 → 安全整改(root RCE / broker 幂等 / capability 授权 / OS 降权闭合 / 执行 durability / 代理主备 bug)→ **block C 接线**:broker+verifier 进运行时、oc-selfheal CLI、cancel 契约、放行通路、deployDriver、provision 脚本、autossh 隧道、runbook → 审计修复两轮。

**审计结论**:Codex 实现安全审计 **PASS**(3 轮:2 BLOCKER+3 HIGH → 1 BLOCKER+2 HIGH → 全清)。

---

## 3. 测试现状(接手需知)

| 套件 | 结果 |
|---|---|
| 个人版 typecheck / gateway / storage | 0 错 / **740 全绿** / 全绿 |
| v5 typecheck / gateway / storage / web-react | 0 错 / 1647 / 275 / **1228 全绿** |
| v5 commercial **unit** | **基线 diff 法通过** — 独有失败仅 4 个 `userChatBridge`(= 继承测试债 `c5192f5e`,该 commit 在 canonical 里不在本分支,**合并后自然转绿**) |
| v5 commercial **integ** | ✅ **双树对照通过,零回归**(见下) |

### integ 双树对照结果(已收尾)
干净库(DROP SCHEMA 重置)+ test-mutex 下各跑一次:

| 树 | tests | pass | fail |
|---|---|---|---|
| selfheal | 1113 | 469 | 52 |
| 基线 aurora | 1090 | 446 | 52 |

- **失败集完全一致**(去重后 `comm -23` = 空)→ 52 个失败全是本机 integ 对外部依赖的存量失败,**零回归**。
- selfheal 树多出的 23 个测试(新增 suppression / release claim / cancel 矩阵 / M4 出口用例)**全部通过**(pass 差值 469−446 = 23,精确对上)。

**踩坑提醒(给后续任何 commercial 测试)**:octest 共享库(55432)跨 worktree 共享,被并发跑污染会产生假失败(`relation "admin_alert_channels" already exists` / `cancelledByParent`)。**必经 `test-mutex.sh`,禁裸跑**;对照跑前先重置:
```bash
bash scripts/test-mutex.sh commercial 'psql "postgres://test:test@127.0.0.1:55432/openclaude_test" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO test;" && npx tsx --test --test-concurrency=1 $(find packages/commercial/src -type f -name "*.integ.test.ts")'
```
已定性的污染假失败:4 个 v3 `INV-*`(`v3MigrationReconciler.test.ts`)——干净库单独重跑 **12/12 全绿**,非回归。

---

## 4. 剩余工作(按序,全在 runbook 里有命令)

> **测试门已全清**(四层 + 双树对照零回归)。接手直接从第 1 步开始。

1. **合并 canonical**:
   - v5:`feat/v5-selfheal` → `feat/v5-aurora-rewrite`(`git merge --no-ff`);合并后 4 个 userChatBridge 失败应转绿(复验)。
   - 个人版:`feat/selfheal-repair` → `master`。
   - v5 合并后需重新 `vite build` + rsync dist(playbook 铁律:合并后必 rebuild,否则 stale dist)。
2. **部署**(严格按 `docs/SELFHEAL-RUNBOOK.md` 七步,每步有回滚):
   - ① 个人版合并 + safe-restart(env 未设 = dormant,零行为变化)
   - ② v5:PG apply `0133`→`0134`→`0135`(additive,在线;记账 `schema_migrations`,version=文件名去 `.sql`)→ env 先写 `OC_SELFHEAL_*`(**`OC_SELFHEAL_DISABLED=1` + `DISPATCH_DISABLED=1` 双关**)→ deploy → 核对 effective config
   - ③ 观察层激活:stale firing condition 逐行处置 → `V5MON_CONDITIONS=1` + 删 `OC_SELFHEAL_DISABLED` → restart → 全链 smoke(无派单)
   - ④ 执行侧激活:`scripts/selfheal-provision.sh`(个人版仓,幂等,有 `--dry-run`)→ safe-restart → `apt install autossh` + 隧道单元 → kl-mirror 侧 `DISPATCH_DISABLED=0` + restart → **合成 incident 全链 E2E**
   - ⑤ **writer-guard:双重门未过前不启用**(0136 保留为不可改写的历史迁移；0137 显式删除旧 trigger 以收敛环境，真实 SQL 位于 `db/deferred/selfheal_writer_guard.sql`。门① 新 master 上线 ✅；门② 回滚池核对通过后，才以新的迁移版本号重新启用)
   - ⑥ watchdog + egress selector 迁移(独立小窗口,走 release-checklist)
3. **收尾**:playbook 登记新机制/新坑 + 记忆固化。

---

## 5. 接手必须知道的红线

1. **writer-guard 在回滚双重门通过前必须保持禁用**。0136 是不可改写的历史迁移；0137 会显式删除其 trigger/function，使已应用和未应用过 0136 的环境收敛。真实 SQL 位于 `db/deferred/selfheal_writer_guard.sql`，双重门通过后再用新的迁移版本号上线。
2. **`OC_SELFHEAL_DISPATCH_DISABLED` 默认 = 1(禁派单)**,`OC_SELFHEAL_AUTO_DEPLOY_TIER2` 默认 = 0(生产 cutover 需人工一键放行)。首次上线两者都不要动。
3. **commercial 测试必经 `test-mutex.sh`**(跨 worktree 共享 octest PG)。
4. **跨仓契约(改一侧必须同步另一侧)**:
   - HMAC 签名串:`${METHOD}.${path}.${ts}.${nonce}.${repairId}.${bodySha256}`
   - capability token:`${attempt}.${exp}.${jti}.${sig}`
   - 路径:`/api/webhooks/v5-selfheal{,-cancel,-release}`
   - pending_release 标记:progress 回调 `detail.phase='pending_release'`(v5 放行门据此判定)
   - release 响应:个人版按 deployed→200 / pending·rejected→409 / in_progress→423 / deploy_failed→500 / 异常→503;v5 要求 **2xx 且 body.ok && body.status==='deployed'** 才算成功
   - claim-capability:repair 不存在→404,终态→409(个人版 pump 据此 abandoned;其余码视为瞬态无限重试)
5. **企微机器人 webhook 未配**:`OC_SELFHEAL_WECOM_WEBHOOK`(待放行通知用)。env 缺失时只 warn 不炸,但 boss 收不到"待放行"推送 —— 上线前需 boss 提供 key,或改走 aibot 既有通道。
6. **密钥已 stage**:`/root/.secrets/v5-selfheal/{master-secret,webhook-hmac,verification-hmac,tunnel_key}`(0600)。kl-mirror 侧 `commercial-v5.env` 需同步 master-secret + webhook-hmac 两个。
7. **本机 = 个人版 + 执行侧;v5 生产 = kl-mirror**。ocheal 用户(uid 997)与 setpriv 已就位;autossh **未装**;broker socket 未建;19096 clash_api 未启用。

---

## 6. 本批架构要点(为什么这么做,防止接手者改坏)

- **检测状态单一权威** = PG function `write_alert_condition`。TS 与 shell 都只调它;incident 是它的只读派生投影(reconciler 单向)。deferred writer-guard 将在回滚双重门通过后以新的迁移版本号把这条约定升级为 DB 级强制(反向白名单:除 `ack_*`/`suppressed_*` 外任何列都不可直写)。
- **H1b suppression**:probe 类 condition 仍 firing 时 admin resolve,**绝不能写 `firing=false`**(那是篡改探测权威,下一轮观测必然推翻 → resolve/重开风暴)。正确语义 = 压制投影直至真实恢复,`write_alert_condition` 在 true→false 翻转时自动清压制。
- **release 权限模型**:`release` **不是 broker socket action**(ocheal 能连 socket,不可信其自称来源)。仅两个入口 → broker 进程内 `releaseApproved()`:① v5 admin 点击 → HMAC 签名 webhook;② root break-glass。
- **deployDriver 信任链**:部署工具链 denylist(`scripts/**`/`deploy/**`/`.github/**`/根 `package.json`/任意 `*.sh`)—— 候选触碰即永不自动部署(证明 merge 后 `deploy-v5.sh` 字节不变,root 才敢执行它);全程持 `/var/lock/oc-selfheal-cutover.lock`,merge 后与 deploy 后双断言 `HEAD===sha`(验证 SHA = 合并 SHA = 部署 SHA)。
- **cancel 全窗口闭合**:per-repair mutex 序化 worker 与 cancel;durable `cancelling` 中间态承载 teardown 不确定(**`terminated=true` 当且仅当 durable=cancelled**,否则 v5 singleflight 槽会被误释放而旧 runner 仍在跑)。
- **broker→master 回调**:outcome finalize 与回调 enqueue **同一 SQLite 事务**(`commitBrokerOutcomeWithCallback`)。不允许"已提交却无回调"的半状态——那会永久孤儿化 v5 状态机。失败 = `commit_failed` + claim 保持 `claimed`(replay 报 `in_progress`,fail-closed 绝不重跑已发生的部署)。
