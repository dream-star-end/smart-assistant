/**
 * Engine-agnostic "is this native resume id still resumable on disk?" probe.
 *
 * Every engine persists its transcript somewhere under a durable volume, and
 * every engine has a stale-resume failure mode when the resume-map points at
 * an id whose transcript never landed (the CLI emitted `session_id` and died
 * before the first frame) or was wiped. Until now each engine handled that
 * differently: CCB and Cursor Sand validated the JSONL and dropped the map,
 * Codex self-healed by starting a fresh thread, Grok/zcode surfaced a stale
 * error. All of them lost the conversation the user could still see, and the
 * gateway fell back to replaying the master history ("已重新加载会话上下文").
 *
 * This module gives sessionManager a single contract:
 *
 *   - `resumeArtifactExists(engine, id, ctx)` — durable artifact present and
 *     non-empty for the id.
 *   - `resumeArtifactMtime(engine, id, ctx)` — for ranking fallback candidates.
 *
 * Callers keep a short history of ids per session (see
 * `sessionManager._resumeHistory`) and walk it newest-first through this probe
 * when the head id is dead, so a container rebuild that produced one empty
 * spawn no longer forces the whole session back to lossy replay.
 *
 * The probe is conservative: unknown engine / unreadable filesystem → `true`
 * (let the engine's own stale detection fire) — the same posture as
 * `SessionManager._ccbJsonlExists`.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { paths } from '@openclaude/storage'
import {
  cursorResumeStorePath,
  cursorSandOfficialCcResumeInnerId,
  cursorSandResumeInnerId,
  isAnyCursorSandResumeId,
} from './cursorAdapter.js'

export type ResumeArtifactEngine = 'ccb' | 'cursor' | 'codex' | 'grok' | 'zcode'

export interface ResumeArtifactContext {
  /** `$CLAUDE_CONFIG_DIR`; CCB / Cursor Sand JSONL lives under `<dir>/projects/*`. */
  claudeConfigDir?: string
  /** `$CODEX_HOME` or `~/.codex`; rollouts under `<dir>/sessions/YYYY/MM/DD/`. */
  codexHome?: string
  /** `$OPENCLAUDE_HOME` or `paths.home`; grok under `<dir>/grok-build/sessions`, zcode under `<dir>/zcode-cli`. */
  openclaudeHome?: string
  /** Spawn cwd for native Cursor (chats/<md5(cwd)>/<id>/store.db). */
  workspacePath?: string | null
  env?: NodeJS.ProcessEnv
}

export interface ResumeArtifactProbe {
  exists: boolean
  /** Undefined when the engine has no on-disk artifact we know how to locate. */
  mtimeMs?: number
  /** Where we looked (for logs). */
  path?: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ZCODE_SESS_RE = /^sess_[A-Za-z0-9_-]{8,80}$/

function nonEmptyFile(path: string): ResumeArtifactProbe | null {
  try {
    const st = statSync(path)
    if (st.isFile() && st.size > 0) return { exists: true, mtimeMs: st.mtimeMs, path }
    return null
  } catch {
    return null
  }
}

function dirWithContent(path: string): ResumeArtifactProbe | null {
  try {
    const st = statSync(path)
    if (!st.isDirectory()) return null
    const entries = readdirSync(path)
    if (entries.length === 0) return null
    return { exists: true, mtimeMs: st.mtimeMs, path }
  } catch {
    return null
  }
}

function resolveCtx(ctx: ResumeArtifactContext) {
  const env = ctx.env ?? process.env
  const claudeConfigDir = ctx.claudeConfigDir ?? env.CLAUDE_CONFIG_DIR?.trim() ?? ''
  const codexHome = ctx.codexHome ?? env.CODEX_HOME?.trim() ?? join(homedir(), '.codex')
  const openclaudeHome = ctx.openclaudeHome ?? env.OPENCLAUDE_HOME?.trim() ?? paths.home
  return { claudeConfigDir, codexHome, openclaudeHome }
}

/** `<CLAUDE_CONFIG_DIR>/projects/<any>/<id>.jsonl` with size > 0. */
export function ccbJsonlArtifact(
  innerId: string,
  claudeConfigDir: string,
): ResumeArtifactProbe | 'unknown' | null {
  // Ids that do not look like the engine's own format cannot be located on
  // disk; leave them to the engine's stale detection instead of evicting.
  if (!UUID_RE.test(innerId)) return 'unknown'
  if (!claudeConfigDir) return 'unknown'
  const projectsDir = join(claudeConfigDir, 'projects')
  if (!existsSync(projectsDir)) return 'unknown'
  let entries: string[]
  try {
    entries = readdirSync(projectsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return 'unknown'
  }
  for (const name of entries) {
    const hit = nonEmptyFile(join(projectsDir, name, `${innerId}.jsonl`))
    if (hit) return hit
  }
  return null
}

/** `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl`. */
export function codexRolloutArtifact(
  threadId: string,
  codexHome: string,
): ResumeArtifactProbe | 'unknown' | null {
  if (!UUID_RE.test(threadId)) return 'unknown'
  const root = join(codexHome, 'sessions')
  if (!existsSync(root)) return 'unknown'
  const suffix = `-${threadId.toLowerCase()}.jsonl`
  try {
    for (const y of readdirSync(root)) {
      const yDir = join(root, y)
      for (const m of readdirSync(yDir)) {
        const mDir = join(yDir, m)
        for (const d of readdirSync(mDir)) {
          const dDir = join(mDir, d)
          for (const f of readdirSync(dDir)) {
            if (f.startsWith('rollout-') && f.toLowerCase().endsWith(suffix)) {
              const hit = nonEmptyFile(join(dDir, f))
              if (hit) return hit
            }
          }
        }
      }
    }
  } catch {
    return 'unknown'
  }
  return null
}

/** `<OPENCLAUDE_HOME>/grok-build/sessions/<urlencoded-cwd>/<sessionId>/` non-empty. */
export function grokSessionArtifact(
  sessionId: string,
  openclaudeHome: string,
): ResumeArtifactProbe | 'unknown' | null {
  if (!UUID_RE.test(sessionId)) return 'unknown'
  const root = join(openclaudeHome, 'grok-build', 'sessions')
  if (!existsSync(root)) return 'unknown'
  try {
    for (const group of readdirSync(root, { withFileTypes: true })) {
      if (!group.isDirectory()) continue
      const hit = dirWithContent(join(root, group.name, sessionId))
      if (hit) return hit
    }
  } catch {
    return 'unknown'
  }
  return null
}

/** zcode keeps transcripts inside `<OPENCLAUDE_HOME>/zcode-cli/cli/db/db.sqlite`;
 *  per-session exec scratch under `cli/exec/<sess_id>` is best-effort. We can
 *  only assert "db present" without opening sqlite — treat as unknown so the
 *  CLI's own `Session not found: sess_*` stays the authority. */
export function zcodeSessionArtifact(
  sessionId: string,
  openclaudeHome: string,
): ResumeArtifactProbe | 'unknown' | null {
  if (!ZCODE_SESS_RE.test(sessionId)) return 'unknown'
  const db = join(openclaudeHome, 'zcode-cli', 'cli', 'db', 'db.sqlite')
  if (!existsSync(db)) return null
  const exec = dirWithContent(join(openclaudeHome, 'zcode-cli', 'cli', 'exec', sessionId))
  if (exec) return exec
  return 'unknown'
}

/**
 * Probe a resume id for the engine. Returns `exists:true` for unknown/unprobeable
 * cases (conservative), and `exists:false` only when we positively looked at the
 * durable location and found nothing usable.
 */
export function probeResumeArtifact(
  engine: string,
  resumeId: string,
  ctx: ResumeArtifactContext = {},
): ResumeArtifactProbe {
  const { claudeConfigDir, codexHome, openclaudeHome } = resolveCtx(ctx)
  let r: ResumeArtifactProbe | 'unknown' | null
  switch (engine) {
    case 'ccb':
      r = ccbJsonlArtifact(resumeId, claudeConfigDir)
      break
    case 'cursor': {
      const inner = cursorSandResumeInnerId(resumeId) ?? cursorSandOfficialCcResumeInnerId(resumeId)
      if (inner) {
        r = ccbJsonlArtifact(inner, claudeConfigDir)
      } else if (isAnyCursorSandResumeId(resumeId)) {
        r = null // malformed sand id
      } else {
        // Native cursor: chats/<md5(cwd)>/<id>/store.db — only checkable with a cwd.
        const ws = typeof ctx.workspacePath === 'string' ? ctx.workspacePath.trim() : ''
        if (!ws || !UUID_RE.test(resumeId)) {
          r = 'unknown'
        } else {
          r = nonEmptyFile(cursorResumeStorePath(ws, resumeId))
        }
      }
      break
    }
    case 'codex':
      r = codexRolloutArtifact(resumeId, codexHome)
      break
    case 'grok':
      r = grokSessionArtifact(resumeId, openclaudeHome)
      break
    case 'zcode':
      r = zcodeSessionArtifact(resumeId, openclaudeHome)
      break
    default:
      r = 'unknown'
  }
  if (r === 'unknown') return { exists: true }
  if (r === null) return { exists: false }
  return r
}

export function resumeArtifactExists(
  engine: string,
  resumeId: string,
  ctx: ResumeArtifactContext = {},
): boolean {
  return probeResumeArtifact(engine, resumeId, ctx).exists
}

/** Upper bound on remembered prior ids per session. Small on purpose: this is
 *  a fallback ladder for "the newest id never landed", not an archive. */
export const RESUME_HISTORY_MAX = 4

/**
 * Pick the first id (newest first) whose artifact positively exists. `head` is
 * tried first; `history` is newest-first. Returns undefined when nothing on the
 * ladder is resumable. Ids equal to `head` in history are skipped.
 */
export function pickResumableId(
  engine: string,
  head: string | undefined,
  history: readonly string[],
  ctx: ResumeArtifactContext = {},
): { id: string; fromHistory: boolean; probe: ResumeArtifactProbe } | undefined {
  if (head) {
    const probe = probeResumeArtifact(engine, head, ctx)
    if (probe.exists) return { id: head, fromHistory: false, probe }
  }
  const seen = new Set<string>(head ? [head] : [])
  for (const id of history) {
    if (!id || seen.has(id)) continue
    seen.add(id)
    const probe = probeResumeArtifact(engine, id, ctx)
    // History fallback requires a *positive* hit; an 'unknown' probe on a
    // stale older id would otherwise resurrect something we can't vouch for.
    if (probe.exists && probe.path) return { id, fromHistory: true, probe }
  }
  return undefined
}
