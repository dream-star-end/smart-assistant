# OpenClaude Development Rules

## V5 商业版工作必读(BLOCKING)

任何 v5(Aurora 商业版)相关工作——需求开发、问题定位、部署上线——开工前**必须先读
`docs/V5_DEV_PLAYBOOK.md`**(v5 单一权威手册:架构地图/开发工作流/按症状定位路由/
部署生效面矩阵/技术债登记)。演进方向见 `docs/V5_ROADMAP_2026H2.md`。
- v5 canonical 分支 = `feat/v5-aurora-rewrite`(部署树 /opt/openclaude/openclaude-v5-aurora);新 worktree 一律基于它。
- 部署红线速记:容器内源码(gateway/CCB/storage/protocol)走 runtime source release 轴(deploy-v5.sh,零镜像重建;Dockerfile/镜像工具链改动才重建 runtime image,见 playbook §2 生效面矩阵);前端必须 vite build+rsync dist+重启;egress 代码必须 --egress;env overrides 改动必须手动同步线上 env;迁移人工 apply+登记 schema_migrations。
- 常规完成的定义 = 测试实跑通过 + Codex 审计 PASS + 按生效面矩阵部署 + smoke 通过。dx 显式
  P0 止血可先报告“止血已上线”，但补测、单一 Codex 审计和受保护 CI/PR 关账前不得称任务或根治完成。


## Mandatory Code Review Workflow (BLOCKING)

**Every code modification MUST follow this workflow, except the narrowly scoped dx-declared V5 P0
emergency lane below.**

1. **Plan** — Write out the modification plan: what to change, how, impact scope
2. **Codex Review Plan** — Send plan to Codex for review. Wait for approval before writing any code
3. **Implement** — Execute the approved plan
4. **Codex Review Code** — Send the full diff to Codex for review: correctness, edge cases, side effects
5. **Iterate** — If Codex finds issues, fix and re-submit until clean

**If you skip this workflow outside the explicit exceptions below and write code directly,
you are violating a direct instruction from boss.**

Exceptions:
- single-line typo fixes;
- the dx-declared V5 P0 emergency lane below.

### Review efficiency discipline (BLOCKING)

- Each task that requires review uses exactly **one plan reviewer and one full-diff reviewer**. Do not send the same plan
  or diff to multiple agents for reassurance. If a reviewer is unavailable, replace it once rather
  than duplicating the review.
- Ask for all evidence-backed correctness, security, data, and deployment blockers in one pass.
  Style preferences, speculative defenses, adjacent audits, and optional refactors are non-blocking.
- Close a blocking finding in the same review thread with only the incremental correction and proof.
  Do not resend the whole plan/diff or start a new reviewer.
- Freeze the reproduced root cause, requested scope, and acceptance criteria before implementation.
  A reviewer may block unsafe work, but may not grow the task beyond that frozen scope.
- Run the smallest relevant local tests while iterating. Run each required broad gate once at the
  final boundary (normally protected CI), not after every small edit.

### Dx-declared V5 P0 emergency lane (BLOCKING)

Only dx may activate this lane, by explicitly stating that V5 production is causing ongoing
real-user, financial, or security harm **and** ordering the smallest containment fix to ship before
review/tests. “紧急” alone is not sufficient.

Phase 1 may skip pre-implementation Codex review, new regression tests, the full test suite, and
normal protected-branch CI. It may not skip these controls:

1. Prove the production root cause and implement only the smallest containment diff in a task
   worktree based on current V5 canonical HEAD. No refactor, adjacent audit, speculative defense, or
   duplicate reviewer.
2. Commit and push the exact task branch first. Verify canonical is clean, has no unrelated
   undeployed commits, can fast-forward to that exact pushed commit, and no other production
   mutation owner exists. Only then may canonical fast-forward locally for the emergency release.
3. Deploy only from canonical through `scripts/deploy-v5.sh` canary/finalize. Never weaken branch
   protection, force-push, rsync, or hand-edit symlinks/env/units/runtime tuple.
4. Worktree isolation, the official mutation lease, data/billing invariants, abnormal-signal
   abort/rollback discipline, smoke, and V3-inactive verification are never waived.
5. Once stable, immediately add the regression test, run one independent full-diff Codex review
   and required CI/PR, then align canonical with the protected merge. Before that debt is closed,
   report only “止血已上线”; do not claim completion or a root fix.

If root cause, clean fast-forward, remote provenance, or the unique owner cannot be proved, state the
single blocker immediately instead of inventing a bypass.

## Diagnostic intent and production mutation boundary (BLOCKING)

- “看下 / 啥问题 / 是否正常 / 先告诉我根因 / 单纯定位” is read-only authorization. Do not deploy,
  abort/rollback, restart, kill processes, clear markers, or write production data until dx asks to
  fix, deploy, recover, or roll back.
- A user problem that existed before diagnosis is not a rollout anomaly merely because a separate
  0% canary exists. Rollback-first applies to signals newly observed or worsened while validating
  that rollout. Resolve the active unit/port from `deploy_state.active_slot`; never hard-code A/B.
- The sole production-mutation owner is the process actually holding the official remote
  production-mutation flock, corroborated by the lease fencing meta holder identity/`deploy_id`;
  separately, that invocation's saved nonce must match its in-flight marker/sentinel. `deploy_id`
  and marker nonce are different identifiers and must not be compared. No other session may issue a
  competing mutation command. Takeover is allowed only after the holder exits, the flock is released,
  and official state/marker recovery selects the next command. If ownership cannot be proved, stay
  read-only and report it.

## V5 production is not a test environment (BLOCKING)

- Before entering a production canary, declare the exact candidate, touched deployment surfaces,
  rollback target, and finite acceptance checks. Facts that can be proven in a worktree, CI,
  isolated host, or production-equivalent systemd/proxy/worker environment must be proven there
  first; do not discover them by repeatedly rolling production forward and back.
- A rollback/abort ends that release attempt. Do not retry under the same conditions. First reproduce
  the failed check outside the rollout and prove the code, environment, or validation-harness fix.
  A retry requires new evidence and either a new candidate or a documented environment-only
  correction; "probably transient" is not evidence.
- For ordinary planned work, the production release queue is only for tasks that will mutate
  production. Such a task may skip it only when proven to touch no production lock/lease, runtime
  state, persistent data, hot config, migration, tunnel, credential, worker, service/unit/env/runtime
  tuple, or user traffic. If unsure, it remains a queued production task.
- Safety/recovery modes (`abort/rollback/recover/reclaim/hide-luna`), authorized emergency
  authorization/closure, and the proven self-heal ledger bypass use only the explicit queue
  exceptions in `docs/V5_DEV_PLAYBOOK.md`. They never waive the official mutation lease,
  owner/fencing, clean canonical, or official-script requirements; queue waiting must never delay
  abort.
- Regular long mutation commands must run through `scripts/v5-deploy-detached.sh` so a Web session
  timeout cannot kill the controlling process. Emergency/offline lanes that synchronously return a
  nonce follow their exact playbook command. The detached unit and queue ID are not mutation-owner
  proof; owner identity still comes solely from the official remote flock and lease-fencing evidence.

## Parallel Worktree Workflow (BLOCKING)

Every V5 modification starts in an isolated task worktree. The canonical checkout is a clean
integration/deployment lane, never a development workspace.

```bash
cd /opt/openclaude/openclaude-v5-aurora
git fetch origin feat/v5-aurora-rewrite
git status -sb
git worktree add ../openclaude-v5-<slug> \
  -b <type>/v5-<slug> origin/feat/v5-aurora-rewrite
```

- Record the exact base commit before editing. Use task-scoped `feat/`, `fix/`, or `chore/` branches.
- Develop, test, review, and commit only in the task worktree. Never deploy from it.
- Merge through protected PR/CI into `feat/v5-aurora-rewrite`; update the canonical checkout to the
  exact remote merge SHA before any release action.
- Deploy only from clean canonical `/opt/openclaude/openclaude-v5-aurora` with the official V5
  scripts and, when production mutation is required, the durable release queue.
- After merge and any required production verification, remove only a clean merged worktree without
  `--force`, delete its verified merged branch, and run `git worktree prune`.
- Locked, dirty, unmerged, or process-in-use worktrees are report-only. Never reset, stash, overwrite,
  or force-delete them while parallel work may own their files.

## Personal Instance (45.32 master) — Dev Instance First Rule

**Any code change to this repo (master branch, 45.32) MUST be validated on a dev instance before being merged to master.** Directly restarting production to test changes is forbidden — 45.32 is boss's daily AI assistant.

Workflow:
1. `cd /opt/openclaude/openclaude-dev` (git worktree on a feature branch) — code changes happen here, **never** in `/opt/openclaude/openclaude/` directly
2. Dev instance config at `/root/.openclaude-dev/openclaude.json` with MANDATORY isolation:
   - gateway port 18790 (prod = 18789)
   - `gateway.bind = "127.0.0.1"` — loopback only, never bind 0.0.0.0 (don't expose dev on public IP)
   - `channels.telegram.enabled = false` — shared bot token triggers double getUpdates 409 Conflict and kills prod Telegram bot (historical incident)
   - `channels.wechat.enabled = false` — same reason
   - cron disabled or pointed at a dev-only yaml — avoid double-firing scheduled tasks
   - independent `sessions.db` — SQLite WAL conflicts otherwise
   - NOT behind cloudflared — local curl / ssh tunnel only
3. Start dev **only via `openclaude-dev-start`**, which also launches `openclaude-dev-guard` watchdog (polls prod `is-active` / `/healthz` / journalctl keywords every 5s, kills dev on any anomaly)
4. Validate dev works → Codex review (per the workflow above) → merge branch to master → `openclaude-safe-restart` to ship

Exception: docs / ops scripts / typo fixes don't need a dev instance.

For commercial v2 (38.55), use `deploy-to-remote.sh` — that path is separate and not governed by this rule.

## Changelog 审核制度

`changelog.json` 的 `releases[]` 内容必须由 boss 亲自决定。AI agent 不得自行起草、新增、修改、重写更新日志条目(含 PENDING 占位)。deploy 流程已加 hard gate 拦截。
