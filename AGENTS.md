# OpenClaude Codex Rules

## V5 商业版工作必读(BLOCKING)

任何 v5(Aurora 商业版)相关工作——需求开发、问题定位、部署上线——开工前**必须先读
`docs/V5_DEV_PLAYBOOK.md`**(v5 单一权威手册:架构地图/开发工作流/按症状定位路由/
部署生效面矩阵/技术债登记)。演进方向见 `docs/V5_ROADMAP_2026H2.md`。
- v5 canonical 分支 = `feat/v5-aurora-rewrite`(部署树 /opt/openclaude/openclaude-v5-aurora);新 worktree 一律基于它。
- 部署红线速记:容器内源码(gateway/CCB/storage/protocol)走 runtime source release 轴(deploy-v5.sh,零镜像重建;Dockerfile/镜像工具链改动才重建 runtime image,见 playbook §2 生效面矩阵);前端必须 vite build+rsync dist+重启;egress 代码必须 --egress;env overrides 改动必须手动同步线上 env;迁移人工 apply+登记 schema_migrations。
- 常规完成的定义 = 测试实跑通过 + Codex 审计 PASS + 按生效面矩阵部署 + smoke 通过。仅当 dx
  明确声明 V5 正在造成真实用户/资金/安全持续损失并要求“最小止血先上线、审查用例事后补”时，
  可按 `CLAUDE.md` 的 P0 emergency lane 先报告“止血已上线”；补测、单一 Codex 审计和受保护
  CI/PR 关账前不得称任务或根治完成。

## V5 诊断与生产写面边界(BLOCKING)

- “看下/啥问题/是否正常/先告诉根因/单纯定位”只授权只读诊断，禁止部署、回退、重启、清 marker
  或写生产数据。任务开始前已存在的用户故障，不因恰逢另一条 0% canary 就自动成为发布异常。
- 健康目标必须由 `deploy_state.active_slot` 推导，禁止固定探测某个槽位端口。
- production mutation 的唯一 owner 是实际持有官方远端 flock、且 lease fencing meta 中的 holder
  identity/`deploy_id` 可佐证的进程；另行验证该 invocation 自己保存的 nonce 与 in-flight
  marker/sentinel 匹配，禁止拿不同标识的 `deploy_id` 与 marker nonce 互比。无法证明 owner 时保持
  只读；另一会话不得竞争执行 abort/rollback/recover。

## V5 效率与生产非试验场(BLOCKING)

- 每个需要评审的任务固定一个方案 reviewer 和一个 full-diff reviewer；同一方案/diff 禁止重复委派。
  blocker 只在同一线程看增量；风格、推测性防御、相邻审计和可选重构不得阻塞。
- 开发前冻结已证实根因、最小范围和有限验收项；本地迭代只跑受影响层测试，广泛门禁在最终
  protected CI 跑一次。canary 期间不得临时扩充范围或发明新验收门槛。
- 生产 canary 前，凡能在 worktree、CI、隔离宿主或等价 systemd/proxy/worker 环境证明的事实
  必须先证明。abort/rollback 结束本次尝试；生产外复现并证明修复前禁止按原条件重试。
- 普通计划任务只有明确不触发任何 production lock/lease、运行态、持久数据、hot-config、迁移、
  隧道、凭据、worker、service/unit/env/runtime tuple 或用户流量时才可不进 production release
  queue；不确定就入队。官方 abort/rollback/recover/reclaim/hide-luna、已授权 emergency/关账和
  可证明的 self-heal ledger 旁路只按 playbook 明示例外执行，绝不能因等队列延迟 abort；这些例外
  不豁免官方 lease、owner/fencing、clean canonical 或官方脚本。
- 常规长 mutation 命令从 canonical 通过 `scripts/v5-deploy-detached.sh` 发起；同步返回 nonce 的
  emergency/offline lane 按 playbook 精确命令执行。systemd unit/queue ID 不是 owner 证明；owner
  仍只认官方远端 flock、lease fencing meta 与本 invocation nonce。


Codex agents working in this repository must follow this file first. The shared project rules also live in `CLAUDE.md`; open and follow `CLAUDE.md` before editing code. If this file and `CLAUDE.md` differ, follow the stricter rule.

## Parallel Worktree Workflow (BLOCKING)

Every V5 modification uses a task worktree based on the current V5 canonical branch:

```bash
cd /opt/openclaude/openclaude-v5-aurora
git fetch origin feat/v5-aurora-rewrite
git status -sb
git worktree add ../openclaude-v5-<slug> \
  -b <type>/v5-<slug> origin/feat/v5-aurora-rewrite
```

- Record the exact base SHA. Develop/test/review/commit only in the task worktree; never deploy from it.
- Merge through protected PR/CI, then update clean canonical to the exact remote merge SHA.
- Deploy only from `/opt/openclaude/openclaude-v5-aurora` through official V5 scripts.
- Remove only clean, merged, process-free worktrees without `--force`; dirty, unmerged, locked, or
  process-in-use worktrees are report-only.
