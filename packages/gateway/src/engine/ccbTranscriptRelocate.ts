/**
 * Make a Claude Code transcript resumable from the cwd we are about to spawn in.
 *
 * Claude Code keys transcripts by working directory:
 *   `$CLAUDE_CONFIG_DIR/projects/<sanitize(realpath(cwd))>/<session_id>.jsonl`
 * and `--resume <uuid>` looks ONLY in that one directory
 * (utils/sessionStorage.ts `loadSessionFile` → `getProjectDir(getOriginalCwd())`).
 *
 * The gateway's resume-map probe (`ccbJsonlArtifact`) scans *every* project dir,
 * so the two disagree as soon as a session's spawn cwd changes between turns:
 *
 *   - isolated_v1: first turn admitted before the project binding landed →
 *     cwd = `workspace/sessions/<id>`; the follow-up is bound → cwd = `workspace`
 *   - GitHub repo overlay flipping to `ready` → cwd = repo workspaceDir
 *   - desktop OPENCLAUDE_ENGINE_CWD / OPENCLAUDE_ADD_DIRS changing
 *
 * Turn 1's transcript is then fully intact on disk but under the old cwd's
 * directory. Gateway says "resumable", CCB says `No conversation found with
 * session ID`, exits 1, the crash handler re-promotes the same id from the
 * history ladder, and the session is stuck in a STALE_RESUME_ID loop
 * (2026-09-07 selfhost incident, sessions webmtqk468nmfkvrb / webmtqncc67pa7w1a).
 *
 * Fix: before spawning with `--resume`, hard-link the transcript into the
 * directory CCB derives from the spawn cwd. Same inode ⇒ CCB's appends after
 * resume are visible through both paths and multi-MB tapes cost nothing to
 * "move". Copy as a fallback when linking is impossible (cross-device). The
 * source is never deleted so older probes and a later cwd flip-back still work.
 *
 * This module deliberately imports nothing from the engine layer so both
 * `subprocessRunner` and `resumeArtifacts` can depend on it without a cycle.
 */
import {
  copyFileSync,
  existsSync,
  constants as fsConstants,
  linkSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '../logger.js'

const log = createLogger({ module: 'ccbTranscriptRelocate' })

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Mirror of Claude Code's `sanitizePath` (utils/sessionStoragePortable.ts).
 *  Paths longer than 200 chars get a hash suffix whose algorithm differs
 *  between bun and node; we return undefined for those so callers leave the
 *  transcript where it is instead of guessing. */
export const CCB_MAX_SANITIZED_LENGTH = 200
export function ccbProjectDirName(canonicalCwd: string): string | undefined {
  const sanitized = canonicalCwd.replace(/[^a-zA-Z0-9]/g, '-')
  return sanitized.length <= CCB_MAX_SANITIZED_LENGTH ? sanitized : undefined
}

/** Exact directory CCB will search for `<id>.jsonl` when spawned with `cwd`.
 *  CCB canonicalises cwd with realpath + NFC (bootstrap/state.ts). */
export function ccbProjectDirForCwd(cwd: string, claudeConfigDir: string): string | undefined {
  if (!claudeConfigDir || !cwd) return undefined
  let canonical = cwd
  try {
    canonical = realpathSync(cwd)
  } catch {
    /* dir not created yet — CCB would also fall back to the raw path */
  }
  const name = ccbProjectDirName(canonical.normalize('NFC'))
  return name ? join(claudeConfigDir, 'projects', name) : undefined
}

function nonEmptyFile(path: string): boolean {
  try {
    const st = statSync(path)
    return st.isFile() && st.size > 0
  } catch {
    return false
  }
}

/** First `<projects>/<any>/<id>.jsonl` with size > 0, or undefined. */
export function findCcbJsonlAnywhere(innerId: string, claudeConfigDir: string): string | undefined {
  const projectsDir = join(claudeConfigDir, 'projects')
  if (!existsSync(projectsDir)) return undefined
  let entries: string[]
  try {
    entries = readdirSync(projectsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return undefined
  }
  for (const name of entries) {
    const candidate = join(projectsDir, name, `${innerId}.jsonl`)
    if (nonEmptyFile(candidate)) return candidate
  }
  return undefined
}

export interface CcbJsonlRelocation {
  /** Transcript path under the spawn cwd's project dir. */
  path: string
  /** True when we had to link/copy it in; false when it was already there. */
  relocated: boolean
  /** Source project dir (only when relocated). */
  from?: string
}

/**
 * Ensure `<innerId>.jsonl` is present in the project dir CCB derives from `cwd`.
 * Returns undefined when nothing needed/possible (malformed id, no config dir,
 * no artifact anywhere, unprojectable long path). Never throws — callers treat
 * undefined as "spawn with the bare id exactly as before".
 */
export function relocateCcbJsonlToCwd(opts: {
  innerId: string
  cwd: string
  claudeConfigDir?: string
  env?: NodeJS.ProcessEnv
}): CcbJsonlRelocation | undefined {
  try {
    const env = opts.env ?? process.env
    const claudeConfigDir = opts.claudeConfigDir ?? env.CLAUDE_CONFIG_DIR?.trim() ?? ''
    if (!UUID_RE.test(opts.innerId) || !claudeConfigDir) return undefined
    const targetDir = ccbProjectDirForCwd(opts.cwd, claudeConfigDir)
    if (!targetDir) return undefined
    const target = join(targetDir, `${opts.innerId}.jsonl`)
    if (nonEmptyFile(target)) return { path: target, relocated: false }
    const source = findCcbJsonlAnywhere(opts.innerId, claudeConfigDir)
    if (!source) return undefined
    if (source === target) return { path: target, relocated: false }
    mkdirSync(targetDir, { recursive: true, mode: 0o700 })
    try {
      linkSync(source, target)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code
      if (code === 'EEXIST') {
        // Lost a race with a concurrent relocation or CCB itself; whatever is
        // there now is authoritative as long as it has content.
        return nonEmptyFile(target) ? { path: target, relocated: false } : undefined
      }
      copyFileSync(source, target, fsConstants.COPYFILE_EXCL)
    }
    const from = source.slice(0, -`/${opts.innerId}.jsonl`.length)
    log.info('relocated CCB transcript to spawn cwd project dir', {
      innerId: opts.innerId,
      from,
      to: targetDir,
    })
    return { path: target, relocated: true, from }
  } catch (err) {
    log.warn('CCB transcript relocation failed; resuming with bare id', {
      innerId: opts.innerId,
      cwd: opts.cwd,
      err: String(err),
    })
    return undefined
  }
}
