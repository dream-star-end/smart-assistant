# Context Golden Replay Suite (`OCV5-885`)

Sanitized, offline-first golden replay dataset and evaluation harness for OpenClaude context engineering, rolling checkpoint compaction, memory/skill hygiene, and multi-turn prompt prefix cache stability.

## Sanitization & Privacy Invariant

Every tape in `cases.json` and every document/query in `hygiene-queries.json` is 100% synthetic engineering/research/ops data:
- **Zero** real API keys, tokens, private keys, emails, phone numbers, public IPs, or user data.
- Mechanically enforced on load by `scanForSanitizationLeaks()` in `schema.ts`.

## Four-Bucket Dataset (`cases.json`, 20 Golden Tapes)

| Bucket | Count | Scope | Deterministic Assertions |
| --- | --- | --- | --- |
| **A** | 6 | Instruction Following & Implicit Protocols | `buildPromptContext` + `ResidentContractGuard` (IUI catalog, inline `{"type":"next"}`, fenced `options` JSON, `/home/agent/.openclaude/generated/`, honest unenabled-capability refusal, baseline security boundary) |
| **B** | 6 | Long-Session Compaction Mid-Session Anchors & Negative Redlines | 18–28 turn dialogues with heavy tool noise + truncated long tails; Stage 1 exact anchor retention + **same-clause polarity-bound triplet assertions** (bare action without negation = hard `POLARITY_INVERSION` FAIL) + Stage 2 violation probe & tool/command blacklist |
| **C** | 4 | Memory & Skill Recall + Archive Shadowing | Runs real `handleCoreSearch`, `archiveMemoryFiles`, `searchArchivedMemories`, and `runSkillShadowRankers` in an isolated temp `OPENCLAUDE_HOME` against 24 ground-truth queries in `hygiene-queries.json` |
| **D** | 4 | Multi-Turn Prefix Cache & Resumed-Turn Elision Stability | 4–5 turn sequences verifying static prefix SHA-256 invariance before `PROMPT_SESSION_CONTEXT_MARKER`, real `applyPromptFreeze` reuse/invalidation, and `elide_resumed` vs `full_inject` transition invariants |

## Usage

### 1. Deterministic Mode (Default · 0 Token · <3s)

```bash
# Run full 20-case golden replay + 24 hygiene queries (default anchored_v2)
npx tsx scripts/context-replay-eval.ts --mode deterministic

# Side-by-side Before (legacy_head_tail) vs After (anchored_v2) scorecard
npx tsx scripts/context-replay-eval.ts --mode deterministic --compare-legacy

# Include rolling monthly holdout cases (anti-overfitting)
npx tsx scripts/context-replay-eval.ts --mode deterministic --holdout-dir /path/to/monthly-holdout
```

### 2. Live-Pair A/B Mode (Cross-Family Judge + Pareto Non-Inferiority)

Enforces `execFamily !== judgeFamily` and non-weak judge model via `scripts/check-cross-family-audit.ts`, AB/BA double-blind position-swap scoring, Stage 2 zero-tolerance veto on negative redline violations, and Pareto non-inferiority:
- Any negative redline loss or Stage 2 behavioral violation -> **REJECT**
- Anchor retention, protocol trigger rate, or hygiene recall drop > 5pp -> **REJECT**
- Non-inferiority satisfied -> compare net token & cache-hit gains -> **ACCEPT** / **HOLD**

```bash
npx tsx scripts/context-replay-eval.ts \
  --mode live-pair \
  --exec-model antigravity-gemini-4-neon \
  --judge-model gpt-6.2-astra \
  --pair-input path/to/pair-bundle.json \
  --write-receipt path/to/replay-receipt.json

npx tsx scripts/context-replay-eval.ts --verify-receipt path/to/replay-receipt.json --commit <sha> --prompt-sha <sha256>
```
