# OpenClaude Development Rules

## V5 商业版工作必读(BLOCKING)

任何 v5(Aurora 商业版)相关工作——需求开发、问题定位、部署上线——开工前**必须先读
`docs/V5_DEV_PLAYBOOK.md`**(v5 单一权威手册:架构地图/开发工作流/按症状定位路由/
部署生效面矩阵/技术债登记)。演进方向见 `docs/V5_ROADMAP_2026H2.md`。
- v5 canonical 分支 = `feat/v5-aurora-rewrite`(部署树 /opt/openclaude/openclaude-v5-aurora);新 worktree 一律基于它。
- 部署红线速记:容器内代码(gateway/CCB/entrypoint)改动必须重建 runtime image;前端必须 vite build+rsync dist+重启;egress 代码必须 --egress;env overrides 改动必须手动同步线上 env;迁移人工 apply+登记 schema_migrations。
- 完成的定义 = 测试实跑通过 + Codex 审计 PASS + 按生效面矩阵部署 + smoke 通过。


## Mandatory Code Review Workflow (BLOCKING)

**Every code modification MUST follow this workflow. NO exceptions.**

1. **Plan** — Write out the modification plan: what to change, how, impact scope
2. **Codex Review Plan** — Send plan to Codex for review. Wait for approval before writing any code
3. **Implement** — Execute the approved plan
4. **Codex Review Code** — Send the full diff to Codex for review: correctness, edge cases, side effects
5. **Iterate** — If Codex finds issues, fix and re-submit until clean

**If you skip this workflow and write code directly, you are violating a direct instruction from boss.**

Exception: single-line typo fixes.

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
