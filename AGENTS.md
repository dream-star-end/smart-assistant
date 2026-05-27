# OpenClaude Codex Rules

Codex agents working in this repository must follow this file first. The shared project rules also live in `CLAUDE.md`; open and follow `CLAUDE.md` before editing code. If this file and `CLAUDE.md` differ, follow the stricter rule.

## Parallel Worktree Workflow (BLOCKING)

Any code modification must happen in an isolated git worktree and task-scoped branch. Do not edit `/opt/openclaude/openclaude` or `/opt/openclaude/openclaude-v3` directly for feature/fix work.

Create workspaces from the canonical checkout:

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
- use task-scoped branch names (`fix/...`, `feat/...`, `chore/...`)
- use task-scoped directory names (`openclaude-<slug>` / `openclaude-v3-<slug>`)
- run `git status -sb` and record the base commit before editing
- with parallel agents, assign disjoint file/module ownership; never revert or overwrite another worker's changes
- keep canonical checkouts as clean integration lanes only

## Integration and cleanup

Merge back only through the canonical checkout:

```bash
cd /opt/openclaude/openclaude-v3   # or /opt/openclaude/openclaude for master
git status -sb
git fetch origin
git merge --no-ff <branch>         # or: git cherry-pick <commit>
```

After tests/deploy succeed and the canonical branch is pushed:

```bash
git worktree remove --force ../openclaude-v3-<slug>  # or ../openclaude-<slug>
git branch -D <type>/<slug>
git worktree prune
git status -sb
```

Do not force-delete locked worktrees or worktrees with unmerged work; stop and report instead.

## Commercial v3 deployment reminder

For any `claudeai.chat` / OpenClaude v3 commercial code or deploy task:
- load and follow the `v3-commercial-deploy` instructions
- explicitly classify touched paths and answer whether a runtime image rebuild is required
- never treat manual rsync + systemctl restart as final deployment
- deploy only with `scripts/deploy-v3.sh` from `/opt/openclaude/openclaude-v3`
