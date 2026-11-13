/**
 * OCV5-755: the OpenClaude gateway hands every CCB process of one session the
 * same snapshot file (OPENCLAUDE_CONTEXT_FREEZE_FILE). The first process
 * records the conversation-start context there (git status, CLAUDE.md, date);
 * a respawned process for that session reuses it, so the cached prompt prefix
 * stays byte-identical across process restarts. The gateway deletes the file
 * when the session should start from live values. Unset/empty env = live.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

type ContextMap = { [k: string]: string }

interface ContextFreezeSnapshot {
  v: 1
  systemContext?: ContextMap
  userContext?: ContextMap
  /** Local ISO date the frozen userContext was built on. */
  localDate?: string
}

let capturedPath: string | null | undefined

/** Read once per process, then removed from process.env: tool subprocesses
 *  (a nested `claude` in Bash) must not share this session's snapshot. */
function snapshotPath(env?: NodeJS.ProcessEnv): string | null {
  if (env) return env.OPENCLAUDE_CONTEXT_FREEZE_FILE?.trim() || null
  if (capturedPath === undefined) {
    capturedPath = process.env.OPENCLAUDE_CONTEXT_FREEZE_FILE?.trim() || null
    delete process.env.OPENCLAUDE_CONTEXT_FREEZE_FILE
  }
  return capturedPath
}

/** Test seam: behave like a new process (re-read the env on next use). */
export function __resetContextFreezeForTests(): void {
  capturedPath = undefined
}

function isContextMap(value: unknown): value is ContextMap {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every(v => typeof v === 'string')
  )
}

function readSnapshot(path: string): ContextFreezeSnapshot | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ContextFreezeSnapshot
    return parsed && parsed.v === 1 ? parsed : null
  } catch {
    return null
  }
}

function writeSnapshot(path: string, patch: Partial<ContextFreezeSnapshot>): void {
  try {
    const next: ContextFreezeSnapshot = { ...(readSnapshot(path) ?? { v: 1 }), ...patch, v: 1 }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 })
    renameSync(tmp, path)
  } catch {
    // Freezing is an optimization; live context keeps working without it.
  }
}

export function getFrozenSystemContext(env?: NodeJS.ProcessEnv): ContextMap | null {
  const path = snapshotPath(env)
  if (!path) return null
  const ctx = readSnapshot(path)?.systemContext
  return isContextMap(ctx) ? ctx : null
}

export function recordSystemContext(ctx: ContextMap, env?: NodeJS.ProcessEnv): void {
  const path = snapshotPath(env)
  if (path) writeSnapshot(path, { systemContext: ctx })
}

export function getFrozenUserContext(
  env?: NodeJS.ProcessEnv,
): { ctx: ContextMap; localDate: string | null } | null {
  const path = snapshotPath(env)
  if (!path) return null
  const snapshot = readSnapshot(path)
  const ctx = snapshot?.userContext
  if (!isContextMap(ctx) || typeof ctx.currentDate !== 'string') return null
  return { ctx, localDate: typeof snapshot?.localDate === 'string' ? snapshot.localDate : null }
}

export function recordUserContext(
  ctx: ContextMap,
  localDate: string,
  env?: NodeJS.ProcessEnv,
): void {
  const path = snapshotPath(env)
  if (path) writeSnapshot(path, { userContext: ctx, localDate })
}
