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

## Parallel Worktree Workflow (BLOCKING)

**When a task says "create a new workspace", "parallel development", "do not affect other work", or the repo already has unrelated dirty/unpushed work, use an isolated git worktree. Do not implement in the shared main checkout.**

Goals:
- keep multiple agents/features from touching the same working tree
- make the deploy branch (`master` for personal, `v3` for commercial) a clean integration lane
- make cleanup deterministic after merge/deploy

### 1. Create an isolated workspace

From the canonical checkout, create a task-scoped worktree and branch:

```bash
# Personal/master work
cd /opt/openclaude/openclaude
git fetch origin
git worktree add ../openclaude-<slug> -b <type>/<slug> origin/master

# Commercial v3 work
cd /opt/openclaude/openclaude-v3
git fetch origin
git worktree add ../openclaude-v3-<slug> -b <type>/<slug> origin/v3
```

Rules:
- branch names must be task-scoped (`fix/...`, `feat/...`, `chore/...`)
- workspace names must include the task slug (`openclaude-v3-media-healthz-direct`, etc.)
- before editing, run `git status -sb` and note the base commit
- if multiple workers are active, assign disjoint file/module ownership; never revert or overwrite another worker's changes

### 2. Work inside the isolated workspace only

Inside the worktree:
- implement, test, and commit normally
- keep commits small and reviewable
- do not deploy from feature worktrees unless the deployment script explicitly supports that branch
- for commercial v3, still obey the v3 commercial deployment rules, especially the runtime-image rebuild decision

Commercial v3 deployment lane:
- develop in `/opt/openclaude/openclaude-v3-<slug>`
- merge/cherry-pick the reviewed commit(s) into `/opt/openclaude/openclaude-v3` on branch `v3`
- deploy only from `/opt/openclaude/openclaude-v3` using `scripts/deploy-v3.sh`
- after deploy, push `origin/v3` and the produced tags

### 3. Merge back through the canonical checkout

Before merging:

```bash
cd /opt/openclaude/openclaude-v3   # or /opt/openclaude/openclaude for master
git status -sb
git fetch origin
git log --oneline --decorate -5
```

Then integrate with one of:

```bash
git merge --no-ff <branch>
# or, for hotfixes / selected commits:
git cherry-pick <commit>
```

After integration:
- rerun the relevant targeted tests in the canonical checkout
- for commercial v3, run deploy dry-run before real deploy
- push the canonical branch after successful merge/deploy:

```bash
git push origin v3      # commercial
git push origin master  # personal
git push origin <tags-if-created>
```

### 4. Clean up after merge/deploy

Only after the commit is present on the canonical branch and pushed:

```bash
cd /opt/openclaude/openclaude-v3   # or canonical master checkout
git worktree list
git worktree remove --force ../openclaude-v3-<slug>
git branch -D <type>/<slug>
git worktree prune
git status -sb
```

Final state must be:
- canonical checkout clean
- canonical branch aligned with origin unless intentionally holding local deployment commits
- temporary worktree removed
- temporary branch deleted
- no leftover detached review worktrees for the task

If a worktree is locked or contains unmerged work, stop and report it instead of force-deleting blindly.

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
