/**
 * OCV5-755: keep a session's platform prompt byte-identical across CCB respawns.
 *
 * Provider prompt caches match on the exact request prefix. The platform prompt
 * sits ahead of the whole conversation, and a respawned CCB (container rebuild,
 * config restart, expired preheat) used to rebuild it from live sources (memory
 * index, skills, roster, project memory...). Any drift there turned the next
 * request into a full history cache write, and on Box it also made master cold
 * start a new remote session.
 *
 * Within the provider cache window a respawn reuses the prompt the session's
 * previous process ran with. A fresh build is still made on every spawn: it
 * yields the explicit inputs (privacy fingerprint, intelligent UI) and the
 * shadow comparison. Explicit inputs changing, or a gap longer than the cache
 * window, always take the fresh prompt.
 */
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { PromptSlotApplied } from './promptSlots.js'
import type { FrozenProjectContextDigests } from './runContextPersist.js'

export type PromptFreezeMode = 'off' | 'shadow' | 'enforce'

/** Under the 1h provider prompt-cache TTL; past it the cache is cold anyway. */
export const PROMPT_FREEZE_TTL_MS = 55 * 60_000
/** Records untouched this long are pruned. */
export const PROMPT_FREEZE_KEEP_MS = 7 * 24 * 60 * 60_000
/** Activity touches are throttled to one write per this interval. */
export const PROMPT_FREEZE_TOUCH_MS = 60_000

const FLAG_FILE = ['runtime-flags', 'prompt-freeze'] as const
const DIR = 'prompt-freeze'

/** `OC_PROMPT_FREEZE` wins; else `<home>/runtime-flags/prompt-freeze`; default shadow. */
export function resolvePromptFreezeMode(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): PromptFreezeMode {
  let raw = env.OC_PROMPT_FREEZE
  if (raw === undefined || raw.trim() === '') {
    try {
      raw = readFileSync(join(home, ...FLAG_FILE), 'utf8')
    } catch {
      raw = undefined
    }
  }
  const value = raw?.trim().toLowerCase()
  return value === 'off' || value === 'enforce' || value === 'shadow' ? value : 'shadow'
}

export interface PromptFreezeInputs {
  agentId: string
  model?: string
  effortLevel?: string
  provider: string
  cacheLayout: string
  modelSupportsVision?: boolean
  availableMcpTools: readonly string[]
  projectId?: string | null
  sessionId?: string
  cwd?: string
  /** Opaque values hashed as JSON (persona text, identity profile, repo state, skill eval). */
  persona?: unknown
  identityProfile?: unknown
  repoSnapshot?: unknown
  skillEval?: unknown
  intelligentUi: unknown
  promptPolicyFingerprint?: string
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Everything a user or the platform changes on purpose. Equal key = same prompt intent. */
export function promptFreezeInputsKey(inputs: PromptFreezeInputs): string {
  return sha256(
    JSON.stringify([
      'ocv5-755-v1',
      inputs.agentId,
      inputs.model ?? null,
      inputs.effortLevel ?? null,
      inputs.provider,
      inputs.cacheLayout,
      inputs.modelSupportsVision ?? null,
      [...inputs.availableMcpTools].sort(),
      inputs.projectId ?? null,
      inputs.sessionId ?? null,
      inputs.cwd ?? null,
      inputs.persona ?? null,
      inputs.identityProfile ?? null,
      inputs.repoSnapshot ?? null,
      inputs.skillEval ?? null,
      inputs.intelligentUi ?? null,
      inputs.promptPolicyFingerprint ?? null,
    ]),
  )
}

export interface FrozenPromptBuild {
  content: string
  contentSha256: string
  applied: PromptSlotApplied[]
  frozenProjectContext?: FrozenProjectContextDigests
}

export interface FrozenPromptRecord extends FrozenPromptBuild {
  v: 1
  sessionKey: string
  inputsKey: string
  builtAt: number
  /** Mode that wrote the record. A shadow record never ran its content when
   *  it was kept on reuse, so enforce does not adopt it as a baseline. */
  mode?: PromptFreezeMode
}

function recordName(sessionKey: string): string {
  return sha256(sessionKey).slice(0, 32)
}

export function promptFreezePath(home: string, sessionKey: string): string {
  return join(home, DIR, `${recordName(sessionKey)}.json`)
}

/** Snapshot file CCB reads/writes for gitStatus / CLAUDE.md / date (see CCB context.ts). */
export function ccbContextFreezePath(home: string, sessionKey: string): string {
  return join(home, DIR, `${recordName(sessionKey)}.ccb.json`)
}

function mtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

export function readFrozenPrompt(
  home: string,
  sessionKey: string,
): { record: FrozenPromptRecord; lastUsedAt: number } | undefined {
  const path = promptFreezePath(home, sessionKey)
  let parsed: FrozenPromptRecord
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as FrozenPromptRecord
  } catch {
    return undefined
  }
  if (
    !parsed ||
    parsed.v !== 1 ||
    parsed.sessionKey !== sessionKey ||
    typeof parsed.inputsKey !== 'string' ||
    typeof parsed.content !== 'string' ||
    !Array.isArray(parsed.applied) ||
    sha256(parsed.content) !== parsed.contentSha256
  ) {
    return undefined
  }
  return { record: parsed, lastUsedAt: mtimeMs(path) }
}

let lastPruneAt = 0

function pruneStale(home: string, now: number): void {
  if (now - lastPruneAt < 60 * 60_000) return
  lastPruneAt = now
  const dir = join(home, DIR)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    const path = join(dir, name)
    if (now - mtimeMs(path) > PROMPT_FREEZE_KEEP_MS) {
      try {
        rmSync(path, { force: true })
      } catch {
        /* best effort */
      }
    }
  }
}

export function writeFrozenPrompt(home: string, record: FrozenPromptRecord, now = Date.now()): void {
  const path = promptFreezePath(home, record.sessionKey)
  mkdirSync(join(home, DIR), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 })
  renameSync(tmp, path)
  pruneStale(home, now)
}

/** Marks session activity; the record's mtime is the cache-window clock. */
export function touchFrozenPrompt(home: string, sessionKey: string, now = Date.now()): void {
  const sec = now / 1000
  for (const path of [promptFreezePath(home, sessionKey), ccbContextFreezePath(home, sessionKey)]) {
    try {
      utimesSync(path, sec, sec)
    } catch {
      /* no record yet */
    }
  }
}

/** A reset or replaced conversation starts from live values. */
export function clearFrozenPrompt(home: string, sessionKey: string): void {
  for (const path of [promptFreezePath(home, sessionKey), ccbContextFreezePath(home, sessionKey)]) {
    try {
      rmSync(path, { force: true })
    } catch {
      /* best effort */
    }
  }
}

export type PromptFreezeDecision = 'reuse' | 'fresh_first' | 'fresh_inputs' | 'fresh_ttl' | 'fresh_mode'

export function decidePromptFreeze(input: {
  record: FrozenPromptRecord | undefined
  lastUsedAt: number
  inputsKey: string
  now: number
  ttlMs?: number
  mode?: PromptFreezeMode
}): PromptFreezeDecision {
  if (!input.record) return 'fresh_first'
  if (input.record.inputsKey !== input.inputsKey) return 'fresh_inputs'
  if (input.mode === 'enforce' && input.record.mode !== 'enforce') return 'fresh_mode'
  if (input.now - input.lastUsedAt > (input.ttlMs ?? PROMPT_FREEZE_TTL_MS)) return 'fresh_ttl'
  return 'reuse'
}

/** Slot names whose content differs between two builds (added/removed included). */
export function changedPromptSlots(
  before: readonly PromptSlotApplied[],
  after: readonly PromptSlotApplied[],
): string[] {
  const left = new Map(before.map((slot) => [slot.name, slot.sha256]))
  const right = new Map(after.map((slot) => [slot.name, slot.sha256]))
  const names = new Set([...left.keys(), ...right.keys()])
  return [...names].filter((name) => left.get(name) !== right.get(name)).sort()
}

export interface PromptFreezeOutcome {
  /** The prompt this spawn runs with. */
  chosen: FrozenPromptBuild
  decision: PromptFreezeDecision
  /** True when `chosen` is the stored prompt rather than the fresh build. */
  reused: boolean
  /** Fresh build equals the stored prompt (nothing would have changed). */
  sameContent: boolean
  changedSlots: string[]
  ageMs: number | null
  /** CCB snapshot path to hand to the child; empty unless enforcing. */
  ccbContextFile: string
}

/**
 * One spawn's decision. `off` never reads or writes. `shadow` keeps the record
 * exactly as enforce would, but always runs the fresh prompt. `enforce` runs
 * the stored prompt on `reuse`.
 */
export function applyPromptFreeze(input: {
  home: string
  sessionKey: string
  mode: PromptFreezeMode
  inputsKey: string
  fresh: FrozenPromptBuild
  now?: number
}): PromptFreezeOutcome {
  const now = input.now ?? Date.now()
  if (input.mode === 'off') {
    return {
      chosen: input.fresh,
      decision: 'fresh_first',
      reused: false,
      sameContent: false,
      changedSlots: [],
      ageMs: null,
      ccbContextFile: '',
    }
  }
  const stored = readFrozenPrompt(input.home, input.sessionKey)
  const decision = decidePromptFreeze({
    record: stored?.record,
    lastUsedAt: stored?.lastUsedAt ?? 0,
    inputsKey: input.inputsKey,
    now,
    mode: input.mode,
  })
  const sameContent = stored?.record.contentSha256 === input.fresh.contentSha256
  const changedSlots = stored ? changedPromptSlots(stored.record.applied, input.fresh.applied) : []
  const ccbPath = ccbContextFreezePath(input.home, input.sessionKey)
  if (decision !== 'reuse') {
    writeFrozenPrompt(
      input.home,
      {
        v: 1,
        sessionKey: input.sessionKey,
        inputsKey: input.inputsKey,
        builtAt: now,
        mode: input.mode,
        ...input.fresh,
      },
      now,
    )
    // A fresh platform prompt starts a fresh CCB snapshot too.
    try {
      rmSync(ccbPath, { force: true })
    } catch {
      /* best effort */
    }
  } else {
    touchFrozenPrompt(input.home, input.sessionKey, now)
  }
  const enforce = input.mode === 'enforce'
  const reused = enforce && decision === 'reuse'
  const kept = stored?.record
  return {
    chosen:
      reused && kept
        ? {
            content: kept.content,
            contentSha256: kept.contentSha256,
            applied: kept.applied,
            ...(kept.frozenProjectContext ? { frozenProjectContext: kept.frozenProjectContext } : {}),
          }
        : input.fresh,
    decision,
    reused,
    sameContent,
    changedSlots,
    ageMs: stored ? Math.max(0, now - stored.lastUsedAt) : null,
    ccbContextFile: enforce ? ccbPath : '',
  }
}
