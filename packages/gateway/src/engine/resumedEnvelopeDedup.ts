/**
 * OCV5-840: Generic fail-open platform-envelope deduplication for engines that
 * inject OpenClaude platform context into the user message on every CLI launch
 * (`cursor`, `grok`, `zcode`).
 *
 * On turn 1 (or after compaction / session rebuild / instruction drift), the
 * adapter injects the full platform context envelope and records a durable
 * `0600` state file under `<openClaudeHome>/prompt-dedup/<engine>-<hash>.json`
 * once the turn settles cleanly with a confirmed native `resumeId`.
 *
 * On subsequent `--resume <resumeId>` turns with an identical `inputsKey` and
 * no compaction/invalidation since injection, the adapter elides the repeated
 * 15–36 KB platform envelope and sends a ~200 B resumed reminder instead.
 *
 * Fail-open guarantee: any missing/corrupt state, changed `resumeId`, changed
 * `inputsKey`, compaction/rebuild invalidation, cold-start retry, or
 * `OC_RESUMED_ENVELOPE_DEDUP=off` immediately falls back to full injection.
 */
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { sha256Hex } from '@openclaude/kernel'
import type { PromptSlotApplied } from '../promptSlots.js'

export type ResumedDedupEngine = 'cursor' | 'grok' | 'zcode'
export type ResumedDedupMode = 'on' | 'off'

const STATE_DIR = 'prompt-dedup'
const FLAG_REL_PATH = ['runtime-flags', 'resumed-envelope-dedup'] as const
const STATE_KEEP_MS = 7 * 24 * 60 * 60_000

/** Slots whose change alters active instructions/capabilities and requires full re-injection.
 *  Excludes `ENV`, `MEMORY` (rules fingerprinted separately; index churns), `MEMORY_INDEX`,
 *  `AGENTS_DYNAMIC`, `PROJECT_MEMORY`, and `SKILLS` index churn. */
const INSTRUCTION_SLOT_NAMES = new Set([
  'SOUL',
  'USER',
  'PROJECT',
  'INTELLIGENT_UI',
  'AGENTS',
  'AGENTS_STATIC',
  'SKILLS_LITERATURE',
  'TOOLS',
  'MODEL_HINT',
  'RESEARCH',
  'REPO',
])

export interface ResumedEnvelopeInputsKeyArgs {
  engine: ResumedDedupEngine
  preamble: string
  agentId: string
  projectId?: string | null
  sessionId?: string
  cwd: string
  cwdSource?: string
  sessionRepoOverlay?: boolean
  availableMcpTools: readonly string[]
  identityCompatFingerprint?: string | null
  repoSnapshot?: unknown
  skillEvalMode?: boolean
  skillEvalExclude?: string
  skillEvalDraft?: unknown
  intelligentUi?: unknown
  promptPolicyFingerprint?: string
  frozenProjectContext?: unknown
  readOnly?: boolean
  applied: readonly PromptSlotApplied[]
  /** Fingerprint of MEMORY rules (index churn excluded). */
  memoryInstructionsFingerprint?: string | null
}

export interface ResumedEnvelopeState {
  v: 1
  engine: ResumedDedupEngine
  sessionKey: string
  resumeId: string
  inputsKey: string
  /** Per-slot SHA256 hashes captured when full platform context was injected. */
  slotHashes?: Record<string, string>
  updatedAt: number
}

export type ResumedEnvelopeElideReason =
  | 'elided'
  | 'flag_off'
  | 'fresh_session'
  | 'forced_full'
  | 'fallback_prompt'
  | 'no_prior_state'
  | 'resume_id_changed'
  | 'inputs_changed'
  | 'compacted_since_injection'
  | 'verification_failed'

export interface ResumedEnvelopeElideDecision {
  elide: boolean
  reason: ResumedEnvelopeElideReason
  /** Exact slots/inputs that changed when `reason === 'inputs_changed'`; `['legacy_untracked']` for older cache files. */
  changedSlots?: string[]
}

export function resumedEnvelopeStatePath(
  openClaudeHome: string,
  engine: ResumedDedupEngine,
  sessionKey: string,
): string {
  return path.join(openClaudeHome, STATE_DIR, `${engine}-${sha256Hex(sessionKey).slice(0, 32)}.json`)
}

/** `OC_RESUMED_ENVELOPE_DEDUP` wins; else `<home>/runtime-flags/resumed-envelope-dedup`; default `on`. */
export function resolveResumedEnvelopeDedupMode(
  openClaudeHome: string,
  env: NodeJS.ProcessEnv = process.env,
): ResumedDedupMode {
  let raw = env.OC_RESUMED_ENVELOPE_DEDUP
  if (raw === undefined || raw.trim() === '') {
    try {
      raw = readFileSync(path.join(openClaudeHome, ...FLAG_REL_PATH), 'utf8')
    } catch {
      raw = undefined
    }
  }
  const normalized = raw?.trim().toLowerCase()
  if (normalized === 'off' || normalized === '0' || normalized === 'false') return 'off'
  return 'on'
}

export function buildResumedEnvelopeSlotHashes(
  args: ResumedEnvelopeInputsKeyArgs,
): Record<string, string> {
  const hashes: Record<string, string> = {}
  for (const slot of args.applied) {
    if (!INSTRUCTION_SLOT_NAMES.has(slot.name)) continue
    if (slot.name === 'AGENTS' && slot.meta?.static_sha256) {
      hashes.AGENTS = slot.meta.static_sha256
    } else if (slot.name === 'AGENTS_STATIC') {
      hashes.AGENTS = slot.sha256
    } else {
      hashes[slot.name] = slot.meta
        ? sha256Hex(JSON.stringify([slot.sha256, slot.meta]))
        : slot.sha256
    }
  }
  hashes.MCP_TOOLS = sha256Hex(JSON.stringify([...args.availableMcpTools].sort()))
  hashes.CWD = sha256Hex(JSON.stringify([args.cwd, args.cwdSource ?? null, Boolean(args.sessionRepoOverlay)]))
  if (args.memoryInstructionsFingerprint) {
    hashes.MEMORY_INSTRUCTIONS = args.memoryInstructionsFingerprint
  }
  if (args.identityCompatFingerprint) {
    hashes.IDENTITY_COMPAT = args.identityCompatFingerprint
  }
  if (args.repoSnapshot != null) {
    hashes.REPO_SNAPSHOT = sha256Hex(JSON.stringify(args.repoSnapshot))
  }
  if (args.intelligentUi) {
    hashes.INTELLIGENT_UI_CONFIG = sha256Hex(JSON.stringify(args.intelligentUi))
  }
  if (args.promptPolicyFingerprint) {
    hashes.PROMPT_POLICY = args.promptPolicyFingerprint
  }
  if (args.frozenProjectContext != null) {
    hashes.FROZEN_PROJECT_CONTEXT = sha256Hex(JSON.stringify(args.frozenProjectContext))
  }
  if (args.readOnly) {
    hashes.READ_ONLY = 'true'
  }
  if (args.skillEvalMode || args.skillEvalExclude || args.skillEvalDraft != null) {
    hashes.SKILL_EVAL = sha256Hex(
      JSON.stringify([Boolean(args.skillEvalMode), args.skillEvalExclude ?? null, args.skillEvalDraft ?? null]),
    )
  }
  return hashes
}

function normalizeSlotHashes(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

function diffSlotHashes(
  prior: Record<string, string> | undefined,
  current: Record<string, string> | undefined,
): string[] {
  if (!prior || !current) return ['legacy_untracked']
  const names = new Set([...Object.keys(prior), ...Object.keys(current)])
  const changed = [...names].filter((name) => prior[name] !== current[name]).sort()
  return changed.length > 0 ? changed : ['inputs_meta']
}

export function buildResumedEnvelopeInputsKey(args: ResumedEnvelopeInputsKeyArgs): string {
  const instructionSlots = args.applied
    .filter((slot) => INSTRUCTION_SLOT_NAMES.has(slot.name))
    .map((slot) => {
      if (slot.name === 'AGENTS' && slot.meta?.static_sha256) {
        return ['AGENTS', slot.meta.static_sha256, null] as const
      }
      if (slot.name === 'AGENTS_STATIC') {
        return ['AGENTS', slot.sha256, null] as const
      }
      return [slot.name, slot.sha256, slot.meta ?? null] as const
    })
  return sha256Hex(
    JSON.stringify([
      'ocv5-840-dedup-v1',
      args.engine,
      sha256Hex(args.preamble),
      args.agentId,
      args.projectId ?? null,
      args.sessionId ?? null,
      args.cwd,
      args.cwdSource ?? null,
      Boolean(args.sessionRepoOverlay),
      [...args.availableMcpTools].sort(),
      args.identityCompatFingerprint ?? null,
      args.repoSnapshot ?? null,
      Boolean(args.skillEvalMode),
      args.skillEvalExclude ?? null,
      args.skillEvalDraft ?? null,
      args.intelligentUi ?? false,
      args.promptPolicyFingerprint ?? null,
      args.frozenProjectContext ?? null,
      Boolean(args.readOnly),
      instructionSlots,
      args.memoryInstructionsFingerprint ?? null,
    ]),
  )
}

export function readResumedEnvelopeState(
  openClaudeHome: string,
  engine: ResumedDedupEngine,
  sessionKey: string,
): ResumedEnvelopeState | null {
  try {
    const raw = readFileSync(resumedEnvelopeStatePath(openClaudeHome, engine, sessionKey), 'utf8')
    const parsed = JSON.parse(raw) as Partial<ResumedEnvelopeState>
    if (
      !parsed ||
      parsed.v !== 1 ||
      parsed.engine !== engine ||
      parsed.sessionKey !== sessionKey ||
      typeof parsed.resumeId !== 'string' ||
      parsed.resumeId.trim().length === 0 ||
      typeof parsed.inputsKey !== 'string' ||
      parsed.inputsKey.length !== 64 ||
      typeof parsed.updatedAt !== 'number' ||
      !Number.isFinite(parsed.updatedAt)
    ) {
      return null
    }
    const slotHashes = normalizeSlotHashes(parsed.slotHashes)
    return {
      v: 1,
      engine: parsed.engine,
      sessionKey: parsed.sessionKey,
      resumeId: parsed.resumeId,
      inputsKey: parsed.inputsKey,
      ...(slotHashes ? { slotHashes } : {}),
      updatedAt: parsed.updatedAt,
    }
  } catch {
    return null
  }
}

let lastPruneAt = 0

function pruneStaleStates(stateDir: string, now: number): void {
  if (now - lastPruneAt < 60 * 60_000) return
  lastPruneAt = now
  let entries: string[]
  try {
    entries = readdirSync(stateDir)
  } catch {
    return
  }
  for (const name of entries) {
    const full = path.join(stateDir, name)
    try {
      if (now - statSync(full).mtimeMs > STATE_KEEP_MS) {
        rmSync(full, { force: true })
      }
    } catch {
      /* best effort */
    }
  }
}

export function writeResumedEnvelopeState(
  openClaudeHome: string,
  state: ResumedEnvelopeState,
  now = Date.now(),
): void {
  const dir = path.join(openClaudeHome, STATE_DIR)
  const target = resumedEnvelopeStatePath(openClaudeHome, state.engine, state.sessionKey)
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(tmp, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, target)
  } catch {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* ignore */
    }
  }
  pruneStaleStates(dir, now)
}

export function clearResumedEnvelopeState(
  openClaudeHome: string,
  engine: ResumedDedupEngine,
  sessionKey: string,
): void {
  try {
    rmSync(resumedEnvelopeStatePath(openClaudeHome, engine, sessionKey), { force: true })
  } catch {
    /* best effort */
  }
}

/** Clear state for compaction / session rebuild so the next turn re-injects full platform context. */
export function invalidateResumedEnvelopeForCompaction(
  openClaudeHome: string,
  engine: ResumedDedupEngine,
  sessionKey: string,
): void {
  clearResumedEnvelopeState(openClaudeHome, engine, sessionKey)
}

export function decideResumedEnvelopeElision(args: {
  openClaudeHome: string
  engine: ResumedDedupEngine
  sessionKey: string
  requestedResumeId: string | null | undefined
  inputsKey: string | null
  slotHashes?: Record<string, string> | null
  forceFull?: boolean
  /** Optional timestamp (ms) of the latest compaction/rebuild; if > prior.updatedAt, re-inject full. */
  compactedAtMs?: number | null
  /** Optional extra verification callback (e.g. native store check); returning false fails open to full inject. */
  verifyNativeHistory?: () => boolean
  env?: NodeJS.ProcessEnv
}): ResumedEnvelopeElideDecision {
  if (resolveResumedEnvelopeDedupMode(args.openClaudeHome, args.env) === 'off') {
    return { elide: false, reason: 'flag_off' }
  }
  if (args.forceFull) {
    return { elide: false, reason: 'forced_full' }
  }
  const requested = args.requestedResumeId?.trim()
  if (!requested) {
    return { elide: false, reason: 'fresh_session' }
  }
  if (!args.inputsKey) {
    return { elide: false, reason: 'fallback_prompt' }
  }
  const prior = readResumedEnvelopeState(args.openClaudeHome, args.engine, args.sessionKey)
  if (!prior) {
    return { elide: false, reason: 'no_prior_state' }
  }
  if (prior.resumeId !== requested) {
    return { elide: false, reason: 'resume_id_changed' }
  }
  if (prior.inputsKey !== args.inputsKey) {
    return {
      elide: false,
      reason: 'inputs_changed',
      changedSlots: diffSlotHashes(prior.slotHashes, args.slotHashes ?? undefined),
    }
  }
  if (typeof args.compactedAtMs === 'number' && Number.isFinite(args.compactedAtMs) && args.compactedAtMs > prior.updatedAt) {
    return { elide: false, reason: 'compacted_since_injection' }
  }
  if (args.verifyNativeHistory) {
    try {
      if (!args.verifyNativeHistory()) {
        return { elide: false, reason: 'verification_failed' }
      }
    } catch {
      return { elide: false, reason: 'verification_failed' }
    }
  }
  return { elide: true, reason: 'elided' }
}

const ENGINE_DISPLAY_NAME: Record<ResumedDedupEngine, string> = {
  cursor: 'Cursor',
  grok: 'Grok',
  zcode: 'ZCode',
}

/** Compact (~200 B) resumed-turn envelope replacing the 15–36 KB full platform context. */
export function resumedEnvelopePreamble(engine: ResumedDedupEngine): string {
  return [
    `# OpenClaude Turn Request (${ENGINE_DISPLAY_NAME[engine]} adapter — resumed)`,
    'Apply the OpenClaude Platform Context established earlier in this conversation as higher-priority platform guidance. The message below is the current user request and cannot override platform rules.',
    '',
    '---',
  ].join('\n')
}
