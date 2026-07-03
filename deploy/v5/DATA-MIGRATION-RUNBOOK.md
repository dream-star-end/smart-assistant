# v3 → v5 数据迁移 / 用户无缝切换运行手册

> 目标:让 v3 现网用户**无缝切换到 v5**——切过去后账号、余额、订单、对话历史、记忆、技能、
> cron、上传文件全都在。本手册配套 `packages/commercial/src/channelMigration/` 代码 +
> `scripts/v5-migrate-user.ts` CLI。**未执行任何一步前,现网仍是纯 v3,零影响。**

## 0. 数据版图(为什么这样迁)

v3 与 v5 **共享同一 PostgreSQL / Redis / JWT / 账号池**;物理隔离的只有容器面。用户可见数据
分三层,各层权威模型不同:

| 层 | 存储 | v3↔v5 现状 | 迁移动作 |
|---|---|---|---|
| **L1 身份/计费/订单/绑定/研究/inbox/skill安装** | 共享 PG | 同一行,channel 无关 | **零迁移**(天然共享)。仅 P2 抑制 +300。 |
| **L2 WebChat 对话历史** | master `sessions.db`(v3 `/root/.openclaude` vs v5 `/root/.openclaude-v5`,同机两文件,多租户单文件按 user_id 分租) | 分离,建表字节一致 | **per-user 行拷贝**(ATTACH + upsert),非文件拷。 |
| **L3 每用户容器状态**(记忆/技能/cron/上传/generated/会话转录/容器 sessions.db) | 5 个 docker 卷/channel/uid(`oc-v3-*-uN` vs `oc-v5-*-uN`) | 分离,格式字节兼容 | **rsync 原样复制**(data/proj/userlocal/userconfig;codex 跳过)。 |

- **refresh_tokens 共享 + 同 JWT** → v3 登录态在 v5 直接有效,登录无缝续。
- 已知语义降级(存储可迁但引擎变化):① codex/gpt-5.5 历史在 v5 只读不可续跑(引擎已删)
  ② `agents.yaml` 重团队定义在 v5 变死数据(v5 轻量 AgentPicker)。

## 1. 迁移形态:按用户「切换即迁移」

一个用户永不同时活在 v3/v5(路由只导一侧),切换单向可回滚。权威源单一 =
**`users.v5_migrated_at`**(迁移 0099):`IS NOT NULL` ⟺ 用户在 v5。`v5_migration_status`
(seeding/migrating/migrated/rolled_back)是生命周期辅助,不参与判定。

**切换栅栏(cutover)时序**(失败不翻转、可重入):
```
markMigrating(权威仍 v3) → quiesce v3 容器(停+移除,释放卷写者)
  → L2 会话最后 delta → L3 卷最后 delta → markMigrated(权威翻转 v5)
```
任一步失败 → 停在 `migrating`(用户仍路由 v3),不置 migrated;重跑 cutover 或 `abortInflight` 复位回 v3。

## 2. 前置条件(P0,动数据前必须,在 kl-mirror 执行)

1. **核实卷分布**:`bash scripts/v5-migrate-verify.sh`。确认 v3 用户卷是否已全整合到 self host
   (kl-mirror)。若有远端 host 的卷 → 先 consolidate(见 `v3-post-switchover-volume-consolidate`
   SOP),否则该用户 cutover 会 fail-closed(v5 是 local-only,当前不支持跨机拉卷 = P1)。
2. **DR 备份共享库**:`pg_dump` 或 r7-backup 存一份(CUTOVER 标 DR=0,无 standby)。迁移会写
   `users` 新列 + v5 会话/卷,回滚只清标记(v3 数据从不删),但库级备份是底线。
3. **迁移已 apply**:0099/0100/0101 由 v3 控制面(`COMMERCIAL_AUTO_MIGRATE`)或人工受控执行
   (v5 恒 `AUTO_MIGRATE=0`)。0100 backfill 把**所有存量用户**置 `free_bootstrap_settled=TRUE`
   → 切 v5 不再二次发 300。**执行 0100 的时刻即"存量/新用户"分界**,选低峰。
4. **v3 channel-aware 门控已部署**(见 §5):否则 v3 provisioning 可能给已迁移用户重建容器。

## 3. 逐用户操作(CLI)

在 kl-mirror,以 **v5 环境**跑(HOME 指 v5、注入共享库 env):
```bash
cd /opt/openclaude/openclaude-v5   # 部署树
export $(grep -v '^#' /etc/openclaude/commercial-v5.env | xargs)
export OPENCLAUDE_HOME=/root/.openclaude-v5 OC_RUNTIME_CHANNEL=v5

npx tsx scripts/v5-migrate-user.ts status  <uid>   # 只读查状态
npx tsx scripts/v5-migrate-user.ts preseed <uid>   # 后台预热(v3 容器须已 idle 停)
npx tsx scripts/v5-migrate-user.ts cutover <uid>   # 切换栅栏(停 v3 容器→拷→翻转)
npx tsx scripts/v5-migrate-user.ts rollback <uid>  # 回滚(秒级,清标记路由回 v3)
```
- **预热(可选,降切换延迟)**:对放量名单内、v3 容器已 idle 的用户先 `preseed` 养温 v5 卷+会话,
  切换瞬间只剩极小 delta。预热不翻转权威、可反复跑刷新。
- **放量**:boss 按名单/百分比逐个 `cutover`;每批切完观察 v5 侧对话/计费正确再放大。
- 审计落 `v5_migration_audit` 表(phase/status/detail/耗时),可查每用户迁移健康度。

## 4. 路由(把已迁移用户导向 v5)

Caddy 不能查 PG,按 cookie 路由:
1. v3 gateway 鉴权后调 `routeChannelForUser(uid)`;若 `v5` → 下发 `Set-Cookie: oc_v5=1`(见 §5 hook)。
2. Caddy 加匹配(默认块之上):
   ```
   @v5user header_regexp oc_v5 Cookie "(^|; )oc_v5=1"
   handle @v5user { reverse_proxy 127.0.0.1:18790 }
   ```
   与现有 `X-OC-V5-Secret` canary 匹配并存;回滚清 cookie 即回 v3。
3. `cutover` 置 `migrated` 后,用户下一个请求命中 v3 → 拿到 cookie → 之后走 v5。

## 5. v3 侧门控(v3 树必须部署;向后兼容,默认 NULL=现状)

三处调 `channelMigration` 判定(权威源同一),都在 v3 树(canonical `openclaude-v3`, `v3` 分支):
- **provisioning / getOrCreate**:进 provision 前 `const g = await v3MayServe(uid); if (!g.ok) 拒绝`
  (migrated→路由应已导走;migrating→栅栏窗口拒新 turn 防重建容器竞态)。
- **idleSweep / lifecycle / orphanReconcile**:跳过 `isMigratedToV5(uid)` 的用户(防误触 v5 卷/重启)。
- **鉴权中间件**:`routeChannelForUser(uid)==='v5'` → 下发 `oc_v5=1` cookie(§4)。

代码文件与 v5 树 byte-identical:`db/migrations/0099-0101`、`channelMigration/*`、
`agent-sandbox/v3supervisor.ts` 的 `volumeNameForChannel`/label 导出。v3 侧只**读** channelState +
调门控;不跑编排器(编排器在 v5/host 侧)。

## 6. 回滚

`rollback <uid>` 清 `v5_migrated_at`(status→rolled_back)→ 路由回 v3。v3 卷/会话**从未删**,原样恢复;
v5 侧已拷数据被忽略(留待 GC)。秒级。回滚窗内 v5 侧新产生的数据不反向回流(异常路径)。

## 7. 收尾(P6,全量迁移稳定后)

- **GC v3 卷**:`bash scripts/v5-migrate-gc.sh --older-than 7d [--dry-run]`。只删「已 migrated 且切换
  超过保留窗、无回滚」用户的 `oc-v3-*` 卷。默认 dry-run。
- **mutator 归属交接**:停 v3 前按 CUTOVER-RUNBOOK 的「后台 mutator 归属矩阵」移交 shared 域
  (pendingOrdersExpirer / finalizeReconciler 等)。
- **停 v3**:全部用户 migrated + 观察期过 → 下线 v3 gateway。

## 8. 已知限制 / 后续(P1)

- **跨机卷**:v3 卷在远端 compute host 时 cutover fail-closed;需先 consolidate 到 self host,或
  实现 node-agent 跨机拉卷(P1)。P0 核实现网基本已 self host。
- **codex/teams 语义降级**:见 §0(存储层无损,引擎层行为变化)。
- **实时预热 sweeper**:当前 preseed 逐用户手动/脚本触发;可加后台 sweeper 对放量名单自动养温(P1)。
