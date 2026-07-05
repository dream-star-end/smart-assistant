# OpenClaude Codex Rules

## V5 商业版工作必读(BLOCKING)

任何 v5(Aurora 商业版)相关工作——需求开发、问题定位、部署上线——开工前**必须先读
`docs/V5_DEV_PLAYBOOK.md`**(v5 单一权威手册:架构地图/开发工作流/按症状定位路由/
部署生效面矩阵/技术债登记)。演进方向见 `docs/V5_ROADMAP_2026H2.md`。
- v5 canonical 分支 = `feat/v5-aurora-rewrite`(部署树 /opt/openclaude/openclaude-v5-aurora);新 worktree 一律基于它。
- 部署红线速记:容器内代码(gateway/CCB/entrypoint)改动必须重建 runtime image;前端必须 vite build+rsync dist+重启;egress 代码必须 --egress;env overrides 改动必须手动同步线上 env;迁移人工 apply+登记 schema_migrations。
- 完成的定义 = 测试实跑通过 + Codex 审计 PASS + 按生效面矩阵部署 + smoke 通过。


Codex agents working in this repository must follow this file first. The shared project rules also live in `CLAUDE.md`; open and follow `CLAUDE.md` before editing code. If this file and `CLAUDE.md` differ, follow the stricter rule.

## Parallel Worktree Workflow (BLOCKING)

When a task says "create a new workspace", "parallel development", "do not affect other work", or the canonical checkout has unrelated dirty/unpushed work, use an isolated git worktree. Do not implement in the shared main checkout.

Goals:
- keep multiple agents/features from touching the same working tree
- make the deploy branch (`master` for personal, `v3` for commercial) a clean integration lane
- make cleanup deterministic after merge/deploy

### Create an isolated workspace

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

### Work inside the isolated workspace only

Inside the worktree:
- implement, test, and commit normally
- keep commits small and reviewable
- do not deploy from feature worktrees unless the deployment script explicitly supports that branch
- for commercial v3, still obey the v3 commercial deployment rules, especially the runtime-image rebuild decision

Commercial v3 deployment lane:
- develop in `/opt/openclaude/openclaude-v3-<slug>`
- merge/cherry-pick reviewed commit(s) into `/opt/openclaude/openclaude-v3` on branch `v3`
- deploy only from `/opt/openclaude/openclaude-v3` using `scripts/deploy-v3.sh`
- after deploy, push `origin/v3` and produced tags

### Merge back through the canonical checkout

```bash
cd /opt/openclaude/openclaude-v3   # or /opt/openclaude/openclaude for master
git status -sb
git fetch origin
git merge --no-ff <branch>         # or: git cherry-pick <commit>
```

After integration:
- rerun relevant targeted tests in the canonical checkout
- for commercial v3, run deploy dry-run before real deploy
- push the canonical branch after successful merge/deploy:

```bash
git push origin v3      # commercial
git push origin master  # personal
git push origin <tags-if-created>
```

### Clean up after merge/deploy

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

## Commercial v3 deployment reminder

For any `claudeai.chat` / OpenClaude v3 commercial code or deploy task:
- load and follow the `v3-commercial-deploy` skill/instructions
- explicitly classify touched paths and answer whether a runtime image rebuild is required
- never treat manual rsync + systemctl restart as final deployment
- deploy only with `scripts/deploy-v3.sh` from `/opt/openclaude/openclaude-v3`
