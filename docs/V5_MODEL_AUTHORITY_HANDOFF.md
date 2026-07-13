# v5 模型执行权威 · 上线交接（2026-07-13）

分支：`feat/v5-model-authority`

worktree：`/opt/openclaude/openclaude-v5-modelauth`

同步基线：canonical `40cc11ec`（连接器平台 + P3 双 master + 隔离预发 Caddy 端口 +
candidate 有界 fail-closed readiness/recovery）

## 目标与完成态

本批把模型的可用性、执行路由、能力、上下文窗口、用户可见性和安全版本收口到
`model_catalog`，由 master 对每个 turn 签发 Ed25519 execution descriptor；gateway/CCB
只消费已签 descriptor，egress 对每个上游请求执行 security epoch fence。

已完成的关键闭环：

- `0143_model_catalog.sql`：版本化 catalog、alias、security epoch、定价兼容镜像。
- `0144_model_authority_guards.sql`：状态机、epoch 单调守卫、grant 写 bump epoch、受控
  `SECURITY DEFINER` 过程、app/admin/deploy 三角色最小权限策略。
- app 进程只读 catalog；catalog mutation 使用独立 `MODEL_CATALOG_ADMIN_DATABASE_URL`；
  部署证据/canary/cutover 使用独立 `MODEL_AUTHORITY_DEPLOY_DATABASE_URL`。
- 本地路径授权加载器以 fenced epoch 原子读取 epoch + role + grants；撤权不会继承 60s TTL。
- descriptor 的 engine/upstream/context/effort/thinking/vision 全部进入 gateway/CCB 执行路径；
  vision 变化会 recycle 既有 subprocess，保证 spawn-time prompt 与新能力一致。
- 私钥只留 master；验签侧只读公钥投影。旧 key 停签后必须等待一个完整 turn-lease TTL
  才能删除，并强制提供审计回调。
- cutover 证据从通用 `system_settings` 移到 app 不可见的
  `model_authority_deploy_state`；观察与割接均由 deploy role 写入。
- authority gate 通过后的 proxy/Codex 计费直接消费同一 fenced snapshot 价格；Codex journal
  持久化已复合 agent multiplier 的最终价格，跨 bridge 恢复不再跨 billing generation。
- catalog NOTIFY 与 admin 同步 rebuild 的竞态已收口：已覆盖 epoch 的迟到通知不反向打空新快照，
  在飞重建期间的新通知排队补跑，避免 superseded rebuild 留下永久 unknown。
- deploy 脚本具备四面 preflight、受限 canary、15 分钟观察、全 fleet（含 stopped）
  seed census、emergency image drill 证据和不可逆兼容地板。
- 模型权威开关、seed、emergency 与 preflight 全部拒绝和 P3 rollout 交错，并跟随
  `deploy_state` 的稳定 active lane；P3 candidate 激活同样经过 cutover 兼容地板。
- 全局 egress 不再永久钉在 slot A：`--egress` 使用独立原子 release 指针，从目标
  `BUILT_RELEASE` 安装 unit，并以进程 cwd/health/capability 验证；失败回切起手锁定的旧 release。
- 跨 bridge 结算按 journal 持久化的 `authorityKind` 判定创建代次，而不是接收帧时的当前
  flag：上线前 legacy journal 可跨 enable 恢复，authority journal 也不会在 flag 回退后被
  当成 legacy；畸形分类/绑定/价格统一免单 fail-closed。
- 已合并 P3 双 master 最新 canonical；本地 deploy-state 恢复矩阵与 model-authority deploy gate
  共存通过。生产前仍须在 kl-hk 用最终 canonical 完成 canary/promote/finalize/abort/recover 全演练。

## 已通过验证

- `npm run check:v5`：PASS
  - typecheck：PASS
  - gateway：1753/1753
  - mcp-memory：25/25
  - storage：292/292
  - web-react：1285/1285
  - commercial unit gate：`PASS: no new failures beyond baseline`
- 模型权威安全/计费定向套件：159/159（含精确定价、跨 bridge 恢复、flag 跨版本恢复及
  畸形 journal 免单）。
- 真 PostgreSQL（必须逐文件串行，避免 schema reset 互锁）：
  - `modelCatalogDb.integ.test.ts`：33/33
  - `modelAuthorityDbGuards.integ.test.ts`：28/28
  - `modelCatalogAdmin.integ.test.ts`：12/12，连续两轮通过（锁 NOTIFY/rebuild 竞态修复）
- CCB 定向 Bun 测试：static model 12/12、effort 51/51、thinking 5/5。
- `modelCatalog.test.ts + scripts/__tests__/v5ReleaseSafety.test.ts`：71/71。
- `scripts/v5-deploy-state-smoke.sh`：116/116；`v5-caddy-apply.sh --self-check`：PASS。
- `bash -n scripts/deploy-v5.sh`、`git diff --check`：PASS。

商业 integ 全量 runner 的 `preCheck` fake SQL / `v3EnsureRunning` 失败为 canonical 已知基线；
本批安全相关的三套真 PG 测试已独立严格通过，不用并行 runner 的 schema-reset 假死结论代替。

## 正式上线顺序

1. Codex 最终 full-diff review（相对 canonical `40cc11ec`）必须 PASS；随后 commit、push、合并到
   `/opt/openclaude/openclaude-v5-aurora`。
2. 先在 kl-hk 对**最终 canonical**完成 P3 全路径（canary → promote → finalize、下一轮 abort、
   finalize 断点 recover、真 WS 跨 lane resume）；未通过不得碰生产。
3. 备份生产 DB；用 owner 手工执行生产尚缺的 0135/0143/0144 并登记 `schema_migrations`。
4. 建三个随机独立登录角色，按 0144 runbook 授权；原子写入三个 URL：
   `DATABASE_URL`、`MODEL_CATALOG_ADMIN_DATABASE_URL`、
   `MODEL_AUTHORITY_DEPLOY_DATABASE_URL`。owner URL 只留迁移用途。
5. touched path 分类：commercial master + egress + gateway/CCB/protocol/runtime + migration +
   deploy script + web-react。**runtime source release 必须重建；egress 与 dist 必须部署。**
6. 从 canonical 唯一入口执行 `scripts/deploy-v5.sh --egress --with-dist`；禁止 rsync 或手工重启
   作为最终部署。
7. 用 `OC_EMBED_SOURCE=1` 构建并登记 emergency embedded image，完成激活/恢复 drill 并留证。
8. `--model-authority-preflight` 四面全绿后，先 egress enforce，再 master 签发；开始 observation。
9. 收集至少 15 分钟、10 个 signed request、1 个 canary usage，并由受限 canary admin
   实跑 1 个多请求 CCB turn：同一条已验签 lease 在签发后 2 分钟内有早期 committed request，
   且 5 分钟后仍有另一条不同 request_id 的 committed request。该门是可信运维 rollout
   liveness 证据，不是抵抗已攻陷 admin 容器的远程证明；安全授权仍由签名与逐请求 epoch
   fence 保证。
10. 枚举全部 v5 runtime（含 stopped）完成 bundle-rev census，启用 seed authority-by-rev。
11. 执行 `--model-authority-cutover` 原子锁 observation + epoch 并置位 DB/env marker。
12. smoke：v5/public/egress/Caddy/三 DB 角色/证据行；确认 v3 仍 retired，观察日志与监控。

## 回滚边界

- cutover 前：可关闭 `OC_MODEL_AUTHORITY`，顺序仍需先 egress、后 master。
- cutover 后：不得直接关 flag 或激活缺 capability 的旧 release/runtime tuple。必须先事务性
  恢复 catalog 到 baked 等价值、bump epoch、等待所有快照与容器收敛，再按 runbook 清 marker。
- 本批上线不主动通知用户；若出现真实影响，也必须只定位真实受影响用户，并在企业微信取得
  dx 审批后才可发送，禁止全员群发。
