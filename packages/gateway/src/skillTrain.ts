// Skill-training engine (SkillOpt for v3 commercial).
//
// Adapted from the personal-version skillAutoTrain.ts with three deliberate changes
// for the commercial product:
//
//   1. DRAFT, never apply. The training agent stages candidates via `skill_propose`
//      into a per-run draft area. It does NOT call skill_save/skill_delete, so the
//      authoritative library is untouched until the user confirms a merge from the
//      diff panel. (Decouples "train" from "merge" — the core of the feature.)
//   2. Model locked to DeepSeek. The training session always runs on a fixed
//      DeepSeek model (cheap → good for async background runs). No user model choice.
//   3. User-skills only. Proposals target the user's own (writable) skills; platform
//      baseline / agent-seed skills are read-only and explicitly off-limits.
//
// This module is pure prompt/argument logic (no I/O), so it is unit-testable in
// isolation. The actual session creation + DeepSeek binding + draft writes happen in
// the gateway training Job + the skill_propose tool.

/** Default training model. `pro` is quality-first; `flash` is the cheaper lever. */
export const SKILL_TRAIN_DEFAULT_MODEL = 'deepseek-v4-pro'
export const SKILL_TRAIN_MODELS = ['deepseek-v4-pro', 'deepseek-v4-flash'] as const
export type SkillTrainModel = (typeof SKILL_TRAIN_MODELS)[number]

/** Training always runs DeepSeek at max thinking (effort passes through to upstream). */
export const SKILL_TRAIN_EFFORT = 'max'

export interface SkillTrainArgs {
  /** The training run this session belongs to; drafts are keyed by it. */
  runId: string
  /** Specific user skill to train; omit to auto-select among the user's own skills. */
  targetSkill?: string
  targetAgentId?: string
  lookbackHours?: number
  maxSessions?: number
  /** Max candidate drafts to stage this run. */
  maxProposals?: number
  /** DeepSeek variant; defaults to pro. */
  model?: SkillTrainModel
  focus?: string
}

export interface NormalizedSkillTrainArgs {
  runId: string
  targetSkill?: string
  targetAgentId: string
  lookbackHours: number
  maxSessions: number
  maxProposals: number
  model: SkillTrainModel
  focus?: string
}

const HOUR_MS = 60 * 60 * 1000
const VALID_RUN_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/

export function normalizeSkillTrainArgs(
  raw: SkillTrainArgs,
  currentAgentId: string,
): NormalizedSkillTrainArgs {
  const runId = cleanString(raw?.runId)
  if (!runId || !VALID_RUN_ID_RE.test(runId)) {
    throw new Error('skill train requires a valid runId')
  }
  const targetAgentId = cleanString(raw.targetAgentId) || currentAgentId
  const targetSkill = cleanString(raw.targetSkill)
  const focus = cleanString(raw.focus)
  const model: SkillTrainModel = SKILL_TRAIN_MODELS.includes(raw.model as SkillTrainModel)
    ? (raw.model as SkillTrainModel)
    : SKILL_TRAIN_DEFAULT_MODEL
  return {
    runId,
    targetAgentId,
    lookbackHours: boundedInt(raw.lookbackHours, 24, 1, 168),
    maxSessions: boundedInt(raw.maxSessions, 8, 1, 20),
    maxProposals: boundedInt(raw.maxProposals, 3, 1, 10),
    model,
    ...(targetSkill ? { targetSkill } : {}),
    ...(focus ? { focus } : {}),
  }
}

export function buildSkillTrainPrompt(
  opts: NormalizedSkillTrainArgs,
  now: Date = new Date(),
): string {
  const end = now.toISOString()
  const start = new Date(now.getTime() - opts.lookbackHours * HOUR_MS).toISOString()
  const focus = opts.focus ? `\nFocus constraint: ${opts.focus}` : ''
  const target = opts.targetSkill
    ? `Skill under training: \`${opts.targetSkill}\` (focus proposals on this one skill).`
    : "Skill selection: auto-select among the USER'S OWN skills that recent work would most improve."

  return `# SkillOpt skill-training run (DeepSeek, draft mode)

Run ID: ${opts.runId}
Training model: ${opts.model}
Agent context: ${opts.targetAgentId}
${target}
Lookback window: ${start} through ${end} (${opts.lookbackHours}h)
Session budget: inspect at most ${opts.maxSessions} candidate sessions.
Proposal budget: stage at most ${opts.maxProposals} draft change(s) this run.${focus}

You are improving the USER'S OWN skills from their recent real work. You produce
DRAFTS only — you never modify the live skill library. The user reviews each draft
as a diff and confirms the merge afterward.

CRITICAL guards:
- Stage every change with \`skill_propose\` (runId="${opts.runId}"). Do NOT call
  \`skill_save\`, \`skill_delete\`, or \`skill_train_auto\` — the platform blocks them here.
- Only propose changes to USER-AUTHORED skills (skill_list reports these as editable).
  NEVER propose changes to platform baseline or agent-seed skills — they are read-only
  and reserved; proposing against them will be rejected.
- Never store secrets, private tokens, credentials, or raw sensitive user data.

Procedure:
1. Call \`skill_list()\` to map current coverage and identify user-authored (writable) skills.
2. Use \`session_search\` across the lookback window for reusable multi-step work
   patterns: 3+ tool-call tasks, repeated corrections, failed-then-fixed attempts,
   explicit user satisfaction/dissatisfaction, deployment/debugging/review/test/UI work.
3. Inspect up to ${opts.maxSessions} high-signal sessions.
4. Before proposing, \`skill_view\` the current version of the target skill to diff against.
5. Validation gate before staging anything:
   - New skill: one strong reusable success pattern, or two weaker related patterns.
   - Update: concrete evidence the new instruction would have prevented a mistake,
     shortened the task, or captured a repeated invariant.
   - Delete proposal: only when clearly obsolete/wrong; prefer updating over deleting.
6. For each accepted change, call \`skill_propose\` with: runId, name, op
   ("create"|"update"|"delete"), description, tags, body (full SKILL.md instructions),
   and a one-paragraph rationale citing the evidence sessions. Stay within the budget.

Evals (评测门 — 草稿的验收基准):
- If the target skill has evals (see \`skill_view(name, "evals/evals.json")\`), your draft
  will be AUTO-EVALUATED against the current version after this run (draft vs current,
  assertion pass-rate). Write the draft to genuinely satisfy those assertions — do not
  game the wording of assertions.
- If the target skill has NO evals yet, include an \`evals\` object in your skill_propose
  call: {version:1, cases:[{id, prompt, assertions:[...]}]} with 2-3 realistic cases
  (varied phrasing, one edge case) and 3-5 decidable assertions each. These become the
  skill's acceptance baseline after merge.

Skill writing constraints:
- Keep skills operational: trigger conditions, prerequisites, steps, commands,
  validation, gotchas. Avoid bloated theory. Preserve repo-specific invariants.
- Do not add defensive boilerplate or broad abstractions unsupported by evidence.
- Prefer updating an existing related skill over creating a near-duplicate.

Final report:
- Skills proposed (names + op) with evidence session titles/dates.
- Skipped candidates and why.
- If no useful training signal exists, reply with exactly "[SILENT]".`
}

export function buildSkillTrainContext(opts: NormalizedSkillTrainArgs): string {
  return [
    'Skill-training run (commercial SkillOpt, draft mode — proposals only, no live writes).',
    `runId=${opts.runId}`,
    `model=${opts.model}`,
    opts.targetSkill ? `targetSkill=${opts.targetSkill}` : 'targetSkill=(auto)',
    `lookbackHours=${opts.lookbackHours}`,
    `maxSessions=${opts.maxSessions}`,
    `maxProposals=${opts.maxProposals}`,
    opts.focus ? `focus=${opts.focus}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Recursion guard: a training session must not be able to launch another training
 * run. Mirrors the personal-version delegation-depth guard.
 */
export function isNestedSkillTrainBlocked(delegationDepth: string | undefined): boolean {
  if (delegationDepth === undefined || delegationDepth === '') return false
  return delegationDepth !== '0'
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}
