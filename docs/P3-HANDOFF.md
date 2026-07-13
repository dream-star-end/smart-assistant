# P3 交接文档（分批部署升级用户无感 —— 双 master + cohort 切流）

写于 2026-07-13 凌晨。上一任 AI 在此收尾，本文档是接手者的唯一起点。
**先读本文件，再读 `docs/rfcs/RFC-v5-dual-master-cohort.md`（设计权威，Codex 4 轮设计审 PASS），再看记忆 `v5-p3-dual-master-cohort.md`。**

## 0. 大图：整个项目的位置

boss 目标：v5 部署升级做到**分批切流、用户零感知、秒级回退**。分四阶段：

| 阶段 | 状态 |
|---|---|
| P1 kl-hk 灾备+预发（PG 流复制/异地备份/预发环境） | ✅ 已上线（07-11） |
| P2 会话权威 SQLite→PG | ✅ 已割接生产（07-12，停机 42 秒，记忆 `v5-sessions-pg-migration.md`） |
| P3 基建版（本文档） | 🔶 实现完成，代码审 R2 修复进行中 |
| P3 上线（预发演练→基建版部署→首次 --canary） | ⬜ 未开始 |

## 1. 当前精确状态

- **分支** `feat/v5-p3-impl`，worktree `/opt/openclaude/openclaude-v5-p3-impl`，基于 canonical `12d8d8f2`（含 P3 RFC）。
- **已提交**：`5230243e`（核心：0135+deployState+leaderLease+LeaderBundle+controlListener+index.ts 重构）/`84426f3e`（lane 评估+OAuth 迁 PG+egress 计数）/`88ae31f3`（deploy 五 lane+Caddy 状态机化）/`02c48ffd`（前端 laneReady+横幅 2s）/`4b1a92f9`（laneMetrics 接线）/`641317c0`（**代码审 R1 全修**，16 findings）。
- **R2 修复已完成并提交**（git log 最新 commit）：全部 4 BLOCKER+3 MAJOR+4 MINOR，验证全绿（deploy-state smoke 60/60 含 A→B rollback、lease integ 11/11 含 3 新故障注入、unit 基线 PASS）。**接手直接从 §4 步骤 1（Codex R3 复审）开始**。
- **Codex 审查 thread（可 codex-reply 续审,上下文全在）**：P3 设计+代码审 = `019f5623-2553-7131-9889-7a1eec2c61ea`；P2 = `019f533a-e031-7fb0-92da-d5f7244daf0c`。

## 2. 验证体系（每轮修改后必跑）

```bash
cd /opt/openclaude/openclaude-v5-p3-impl
npm run typecheck                    # 必须干净
npm run test:storage                 # 292 全绿
npm run test:gateway                 # 1671 全绿
cd packages/web-react && npx vitest run   # 1250 全绿(基线 1236+P3 新增 14)
npm run test:commercial:unit         # 失败集 ⊆ .github/known-failures/commercial-unit.txt
# 注意:known-failures 格式=TAP 套件名(非文件路径);preCheck—BINV-5 是他人引入的已登记存量
bash -n scripts/deploy-v5.sh && bash -n scripts/v5-caddy-apply.sh
bash scripts/v5-deploy-state-smoke.sh     # 33+ 断言(本地 octest PG 55432,test:test)
scripts/v5-caddy-apply.sh --self-check    # Caddy 双态纯加法不变量
# deploy lane 全部 dry-run 回归:--canary/--promote/--finalize/--abort/--recover --dry-run
# PG 集成测试用 octest(postgres://test:test@127.0.0.1:55432/openclaude_test),禁连 openclaude_commercial
```

## 3. R2 修复清单（修复 agent 的任务书；若中断按此继续）

Codex R2 复审判定（4 BLOCKER+3 MAJOR+4 MINOR），全部有 file:line：

**BLOCKER**：
1. leaderLease.ts:282/645 — onAcquire await bundle.start() 期间 desired 翻走/lease 断连仍无条件 setState("leader")。修=完成后 token 三重二次确认(leaseClient===client ∧ heldEpoch===installedEpoch ∧ fresh desired===self)，不满足=step-down。补 2 个 deferred 竞态测试。
2. leaderLease.ts:481/504 — graceful stepDown 先清 leaseClient→drain 期断连被忽略→ACK 失败仅 warn→后继永久 fence timeout。修=graceful ACK 失败回退 writeAckShortConn，短连失败=fail-stop。补 drain 中 pg_terminate 测试。
3. deploy-v5.sh:2201/2267/2282 — finalizing 恢复：egress 基线只在 shell 变量（崩溃后新基线吸收事故=假绿）；step5/6 resume 跳门槛。修=step0 基线持久化进 journal；resume 用原基线（取不到=转 aborting）；step5/6 resume 重跑核验；step6 candidate 异常=转 aborting。
4. deploy-v5.sh:785/1633 — rollback 只认 A slot；canary/finalize 不维护 prev。修=0135 加 previous_active_release 列（迁移未上线可直接改）；finalize step7 写入；activate_release/rollback 全面 slot-aware（按 active_slot 选 symlink/unit/端口）；A→B 后 rollback 的 dry-run 验收。

**MAJOR**：①abort 先 Caddy 摘流再 CAS desired（现在顺序反了）②/assets rsync/GC 去 `|| true`+保护集用相对路径支持嵌套③ds_calibrate_active_release 加 phase=stable 谓词+lock_version CAS；canary/finalizing 期间传统 deploy/dist lane 起手断言 phase=stable 拒绝旁路。

**MINOR**：smoke 测原子 CTE；恢复测试断言真实终态非 grep 文字；local smoke seed 与 0135 对齐(NULL)；aborting resume 沿用原 operation_id。

## 4. R2 修完后的路径（顺序执行）

1. **Codex R3 复审**：`codex-reply` thread `019f5623-...`，增量摘要+让它 `git show` 自查。迭代到 PASS（预计 1-2 轮，历史节奏见 thread）。
2. **合并 canonical**：`cd /opt/openclaude/openclaude-v5-aurora && git merge --no-ff feat/v5-p3-impl && npm run typecheck && push origin feat/v5-aurora-rewrite`。删 worktree+分支。
3. **kl-hk 预发全路径演练**（预发环境现成，ssh 别名 `kl-hk`，见记忆 `v5-hk-node-batched-deploy.md`）：
   - 同步新代码到预发（参考 P2 演练：rel 目录 cp+rsync 源码+翻转 symlink）
   - apply 0135（staging PG 15433）+ 传统 deploy 一次（校准 active_release）
   - 全路径：--canary → 内部账号验证 → --promote 50 → --finalize（观察四门槛）→ 再来一轮 --canary → --abort
   - 崩溃注入：finalize 各 step kill 脚本 → --recover 恢复
   - **真 WS 用户跨 lane resume 无感实证**（这是 RFC §7 要求、也是 P1 遗留的 WS turn 冒烟客户端交付点）
   - 注意预发的调度器 kill-switch 铁律（记忆 `v5-hk-node-batched-deploy.md`：leader=0 挡不住 v5-owned，7 个 kill-switch env 已配，别动）
4. **生产基建版部署**（最后一次 11 秒重启）：
   - apply 0135 到生产 PG + schema_migrations 记账（`0135_deploy_state`，格式见 playbook §4.5）
   - Caddy 切换专项验证：生产 Caddyfile 是手工过渡态，首次 `v5-caddy-apply.sh --apply` 是行为等价但非字节等同的格式切换——先 `--render` diff 人工核对再 apply
   - `scripts/deploy-v5.sh`（传统 lane），smoke 断言新增 leadership.state=leader
5. **下一个 release 首用 `--canary` 自举**——到此 boss 目标完整达成。

## 5. 登记债（P3 完成后偿还/触发条件）

- compute-pool 三件套(imagePromote/preheat/computePool)+lifecycle 未入 LeaderBundle（fail-loud 门压着：v5 双 master 要求相关 DISABLED env；多机分布前必须收口）
- `--drain-ws` master 端点未实现（finalize step3 目前靠 WS 自然存活，RFC 标可选）
- WechatManager advisory lease（v5 wechat 现被硬禁，启用前必须做）
- 账号池 inflight 进程内计数=双 master N×cap（常态双活前改 Redis 租约）
- Redis pub/sub 广播 fanout（消 finalize 窗徽章不实时，增强项）
- promote 主动 kick(sys.lane_changed)（增强项）
- P2 侧：OC_SESSIONS_STORE=sqlite 选项删除（P3 上线稳定 2 周后）；wechat helper 复刻上移

## 6. 关键工程纪律（本项目血泪换来的）

- **一切以 Codex 审到 PASS 为完成标准**；上下文经济：大 diff 让 Codex 自己 git show，只发增量摘要
- deploy_state 是四角色面（流量/leader/VIP/unit）唯一权威，任何旁路=当轮审查必杀
- 测试基线对照法：新失败必须 ⊆ known-failures（套件名格式）；共享 worktree 并行 agent 会互相污染 unit gate，最终验证要在 agents 全部停止后单独跑
- 生产操作：deploy 有全局 flock；禁多会话并发 deploy；预发演练先行是铁律
- worktree 工作流见 `docs/V5_DEV_PLAYBOOK.md`（v5 单一权威手册）
