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
