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

### Codex Review ≠ Blind Acceptance

Codex 的评审**不是最终裁决**,更像一位倾向过度防御、爱复杂化的资深同事。对它的反馈你必须**先过脑子再决定是否采纳**,不能无脑照单全收。

典型需要警惕的 Codex 反模式:
- **过度防御**: 要求对不可能发生的分支加 try/catch / null check / 参数校验 (违反 CLAUDE.md "Don't add error handling for scenarios that can't happen")
- **过度抽象**: 把一次性逻辑抽成 helper / 工厂 / 策略类 (违反 "Three similar lines is better than a premature abstraction")
- **范围蠕变**: 借审查机会顺便要求改周边无关代码、加类型注解、补 docstring (违反 "Don't add features beyond what was asked")
- **虚构约束**: 臆造 "如果并发 10k QPS 就会…"、"万一用户传入恶意值…" 等与实际场景无关的假设,推你做防御
- **反 KISS 的重构**: 建议把 3 行直白代码改成 10 行"更健壮"的版本,换来的只是认知负担

处理 Codex 反馈时的原则:
1. **先判定严重性**: 是正确性 bug / 数据损坏 / 安全漏洞 → 必须修;是风格偏好 / 防御性建议 / "可能更好" → 需要权衡甚至拒绝
2. **回到根本需求**: boss 要解决的具体问题是什么?Codex 建议是否服务于这个目标,还是在扩大战线?
3. **可以明确反驳**: 如果 Codex 的反馈违反 CLAUDE.md 的 "不过度工程" 原则,直接回复 Codex 说明不采纳的理由,不要为了尽快过审而妥协
4. **告诉 boss**: 当你拒绝 Codex 的某条反馈时,在回复里明确标出 "Codex 提了 X,我没采纳,理由是 Y" —— 透明决策,让 boss 有机会介入

PASS 不等于"代码完美",而是"没有阻塞性问题";拒绝采纳 Codex 的风格建议也能算 PASS。

## Goal-Driven Execution

把任务翻译成**可验证的成功标准**,而不是模糊的祈使句。LLM 在能 loop 验证时表现最好。

| 不要这样接需求 | 改成这样 |
|---------------|---------|
| "加个校验" | "先写覆盖非法输入的测试,再让它们过" |
| "修这个 bug" | "先写一个能复现 bug 的测试,再让它过" |
| "重构 X" | "确保重构前后测试都过" |

多步任务先列简短计划,每步带 verify:

```
1. [步骤] → verify: [检查方式]
2. [步骤] → verify: [检查方式]
```

强成功标准让 LLM 自己 loop 到通过;弱标准("让它能跑")只会让你被反复打扰澄清。
配合本仓 dev instance + Codex 双审工作流:**dev 起来 + 测试过 + Codex PASS** 就是大多数任务的硬验证三件套。

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
