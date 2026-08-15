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

/** Default training model. Flash is the only remaining DeepSeek train target after V4 Pro disable. */
export const SKILL_TRAIN_DEFAULT_MODEL = 'deepseek-v4-flash'
export const SKILL_TRAIN_MODELS = ['deepseek-v4-flash'] as const
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
  /** DeepSeek variant; defaults to flash. */
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

/** 训练素材:用户差评过的真实场景摘录。text 由调用方用 P1 buildSessionExcerpt 裁到 ≤1500 字符。 */
export interface FeedbackScenario {
  /** 会话标题(可选;仅作可读锚点)。 */
  title?: string
  text: string
}

/** 差评场景注入上限:≤3 段(prompt 体积/成本约束),每段 ≤1500 字符。 */
export const MAX_FEEDBACK_SCENARIOS = 3
export const FEEDBACK_SCENARIO_MAX_CHARS = 1500

/**
 * 把「用户差评过的真实场景」摘录渲染成训练 prompt 的独立小节(纯函数,便于单测)。
 * 空数组 → 返回空串(调用方据此决定不注入)。至多 MAX_FEEDBACK_SCENARIOS 段;每段文本
 * 假定调用方已裁到 ≤FEEDBACK_SCENARIO_MAX_CHARS,这里再兜底截断防越界。
 */
export function buildFeedbackScenariosSection(scenarios: readonly FeedbackScenario[]): string {
  const picked = scenarios.filter((s) => s.text?.trim()).slice(0, MAX_FEEDBACK_SCENARIOS)
  if (picked.length === 0) return ''
  const blocks = picked.map((s, i) => {
    const title = s.title?.trim() ? `(${truncate(s.title.trim(), 60)})` : ''
    return `### 差评场景 ${i + 1}${title}\n${truncate(s.text.trim(), FEEDBACK_SCENARIO_MAX_CHARS)}`
  })
  return `## 用户差评过的真实场景(优先分析这些失败案例)
以下是用户对本技能标记「差评」的真实使用会话摘录 —— 这些正是该技能当前最该改进之处。
起草改动时**优先**针对这些失败模式:补齐缺失的步骤/前置校验/边界处理,或修正会导致此类
结果的指令。不要泛泛复盘;把这些具体失败当作首要证据。

${blocks.join('\n\n')}`
}

export function buildSkillTrainPrompt(
  opts: NormalizedSkillTrainArgs,
  now: Date = new Date(),
  feedbackSection?: string,
): string {
  const end = now.toISOString()
  const start = new Date(now.getTime() - opts.lookbackHours * HOUR_MS).toISOString()
  const focus = opts.focus ? `\nFocus constraint: ${opts.focus}` : ''
  const target = opts.targetSkill
    ? `Skill under training: \`${opts.targetSkill}\` (focus proposals on this one skill).`
    : "Skill selection: auto-select among the USER'S OWN skills that recent work would most improve."
  // 差评场景小节(有则注入,置于意图段与 CRITICAL guards 之间,作为首要证据)。
  const feedback = feedbackSection?.trim() ? `\n${feedbackSection.trim()}\n` : ''

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
${feedback}
CRITICAL guards:
- Stage every change with \`skill_propose\` (runId="${opts.runId}"). Do NOT call
  \`skill_save\`, \`skill_delete\`, or \`skill_train_auto\` — the platform blocks them here.
- Only propose changes to USER-AUTHORED skills (skill_list reports these as editable).
  NEVER propose changes to platform baseline or agent-seed skills — they are read-only
  and reserved; proposing against them will be rejected.
- Never store secrets, private tokens, credentials, or raw sensitive user data.

Procedure:
1. Call \`skill_list()\` to map current coverage and identify user-authored (writable) skills.
2. Run \`oc-memory session-search "<query>"\` (shell CLI) across the lookback window for reusable multi-step work
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

/** 硬截断到 ≤n 字符(超长补省略号,总长仍 ≤n)。 */
function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s
}
