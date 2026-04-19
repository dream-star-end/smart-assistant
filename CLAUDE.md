# OpenClaude Development Rules

## Mandatory Code Review Workflow (BLOCKING)

**Every code modification MUST follow this workflow. NO exceptions.**

1. **Plan** — Write out the modification plan: what to change, how, impact scope
2. **Codex Review Plan** — Send plan to Codex for review. Wait for approval before writing any code
3. **Implement** — Execute the approved plan
4. **Codex Review Code** — Send the full diff to Codex for review: correctness, edge cases, side effects
5. **Iterate** — If Codex finds issues, fix and re-submit until clean

**If you skip this workflow and write code directly, you are violating a direct instruction from boss.**

Exception: single-line typo fixes.

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
