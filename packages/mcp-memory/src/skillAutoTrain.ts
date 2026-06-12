export interface SkillAutoTrainArgs {
  targetAgentId?: string
  lookbackHours?: number
  maxSessions?: number
  maxSkillEdits?: number
  apply?: boolean
  focus?: string
}

export interface NormalizedSkillAutoTrainArgs {
  targetAgentId: string
  lookbackHours: number
  maxSessions: number
  maxSkillEdits: number
  apply: boolean
  focus?: string
}

export interface SkillAutoTrainDelegateRequest {
  targetAgentId: string
  prompt: string
  context: string
}

const HOUR_MS = 60 * 60 * 1000

export function normalizeSkillAutoTrainArgs(
  raw: SkillAutoTrainArgs | undefined,
  currentAgentId: string,
): NormalizedSkillAutoTrainArgs {
  const args = raw ?? {}
  const targetAgentId = cleanString(args.targetAgentId) || currentAgentId
  const focus = cleanString(args.focus)
  return {
    targetAgentId,
    lookbackHours: boundedInt(args.lookbackHours, 24, 1, 168),
    maxSessions: boundedInt(args.maxSessions, 8, 1, 20),
    maxSkillEdits: boundedInt(args.maxSkillEdits, 3, 1, 10),
    apply: args.apply !== false,
    ...(focus ? { focus } : {}),
  }
}

export function buildSkillAutoTrainPrompt(
  opts: NormalizedSkillAutoTrainArgs,
  now: Date = new Date(),
): string {
  const end = now.toISOString()
  const start = new Date(now.getTime() - opts.lookbackHours * HOUR_MS).toISOString()
  const mode = opts.apply ? 'APPLY_CHANGES' : 'DRY_RUN_ONLY'
  const focus = opts.focus ? `\nFocus constraint: ${opts.focus}` : ''

  return `# Fully automatic SkillOpt-style skill training run

Mode: ${mode}
Agent being trained: ${opts.targetAgentId}
Lookback window: ${start} through ${end} (${opts.lookbackHours}h)
Session budget: inspect at most ${opts.maxSessions} candidate sessions.
Edit budget: apply at most ${opts.maxSkillEdits} skill changes in this run.${focus}

CRITICAL recursion guard:
- DO NOT call \`skill_train_auto\` from this delegated training session.
- The platform hard-blocks \`skill_train_auto\` inside delegated sessions; use the direct tools below instead.
- Use only \`session_search\`, \`skill_list\`, \`skill_view\`, \`skill_save\`, \`skill_delete\`, \`memory\`, and \`archival_search/add/delete\` as needed.

Goal:
Train this agent's skills automatically from recent real work. Treat each \`SKILL.md\` as the trainable artifact: improve instructions that caused repeated success, add missing reusable procedures, and remove/update clearly obsolete procedures.

Procedure:
1. Call \`skill_list()\` first to map current coverage.
2. Search recent sessions for reusable work patterns. Start with date/time terms from the lookback window, then use targeted terms for multi-step tool work, deployment, debugging, code review, tests, incident recovery, UI work, and any focus constraint.
3. Inspect up to ${opts.maxSessions} high-signal sessions. Prefer tasks with 3+ tool calls, repeated corrections, failed first attempts later fixed, or explicit user satisfaction/dissatisfaction.
4. For each candidate skill change, compare against existing skills with \`skill_view\` before editing.
5. Validation gate before changing anything:
   - New skill: require one strong reusable success pattern, or two weaker related patterns.
   - Existing skill update: require concrete evidence that the new instruction would have prevented a mistake, shortened the task, or captured a repeated invariant.
   - Delete: only when clearly obsolete/wrong; prefer updating over deleting.
   - Never store secrets, private tokens, one-off credentials, or raw sensitive user data.
6. If Mode is APPLY_CHANGES, directly call \`skill_save\` / \`skill_delete\` for accepted changes, staying within the edit budget.
7. If Mode is DRY_RUN_ONLY, do not write; report exact proposed changes instead.

Skill writing constraints:
- Keep skills operational: trigger conditions, prerequisites, steps, commands, validation, gotchas.
- Avoid bloated theory. Preserve high-signal repo-specific invariants.
- Do not add defensive boilerplate or broad abstractions unsupported by session evidence.
- Prefer updating an existing related skill over creating a near-duplicate.

Final report format:
- mode, lookback window, sessions inspected
- changes applied/proposed, with skill names and evidence session titles/dates
- skipped candidates and reason
- rollback note: SkillStore keeps version history for overwritten skills
- if no useful training signal exists, say "[SILENT]" exactly.`
}

export function createSkillAutoTrainDelegateRequest(
  raw: SkillAutoTrainArgs | undefined,
  currentAgentId: string,
  now: Date = new Date(),
): SkillAutoTrainDelegateRequest {
  const opts = normalizeSkillAutoTrainArgs(raw, currentAgentId)
  return {
    targetAgentId: opts.targetAgentId,
    prompt: buildSkillAutoTrainPrompt(opts, now),
    context: [
      'This is an automatic self-training job for OpenClaude skills.',
      `apply=${opts.apply}`,
      `lookbackHours=${opts.lookbackHours}`,
      `maxSessions=${opts.maxSessions}`,
      `maxSkillEdits=${opts.maxSkillEdits}`,
      opts.focus ? `focus=${opts.focus}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  }
}

export function isNestedSkillAutoTrainBlocked(delegationDepth: string | undefined): boolean {
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
