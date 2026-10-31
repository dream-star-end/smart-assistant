/**
 * OCV5-704: per-turn cap on oc-figcheck vision reviews.
 *
 * The scientific-figures skill says one image may be reviewed at most 3 times.
 * That was prose only: a MiniMax turn ran a 4th review and then kept redrawing.
 * The CLI counts successful vision calls for one image path inside one turn.
 * The 4th call skips vision and tells the agent to deliver.
 *
 * No turn id (a manual shell, or a test that did not set one) is not capped.
 * Production CCB writes OC_FIGCHECK_TURN_ID on every turn; oc_turn_key in
 * CLAUDE_CODE_EXTRA_METADATA is the same id and is the fallback.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const FIGCHECK_TURN_ID_ENV = 'OC_FIGCHECK_TURN_ID'
export const FIGCHECK_VISION_ROUND_MAX = 3

const TURN_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/
const HEX64 = /^[0-9a-f]{64}$/
const LEDGER_TTL_MS = 48 * 60 * 60 * 1000

type Ledger = { images: Record<string, number> }

/** Always present so a turn with no key clears the previous turn's id. */
export function figcheckTurnIdEnv(turnKey: string | undefined): { OC_FIGCHECK_TURN_ID: string } {
  const id = typeof turnKey === 'string' && HEX64.test(turnKey) ? turnKey : ''
  return { OC_FIGCHECK_TURN_ID: id }
}

export function resolveFigcheckTurnId(env: NodeJS.ProcessEnv): string | null {
  const explicit = env[FIGCHECK_TURN_ID_ENV]?.trim() ?? ''
  if (explicit && TURN_ID_RE.test(explicit)) return explicit
  const meta = env.CLAUDE_CODE_EXTRA_METADATA
  if (typeof meta === 'string' && meta.trim()) {
    try {
      const parsed = JSON.parse(meta) as { oc_turn_key?: unknown }
      if (typeof parsed.oc_turn_key === 'string' && HEX64.test(parsed.oc_turn_key)) {
        return parsed.oc_turn_key
      }
    } catch {
      // Malformed metadata is not a turn id.
    }
  }
  return null
}

export function figcheckRoundsDir(env: NodeJS.ProcessEnv): string {
  const home = (env.OPENCLAUDE_HOME || env.HOME || '').trim() || homedir()
  return join(home, 'figcheck-rounds')
}

export function figcheckCapHint(used: number, issueCount: number): string {
  const pending =
    issueCount > 0 ? `确定性检查还有 ${issueCount} 项未过。` : '确定性检查没有新的硬伤。'
  const reviewed = `同一回合这张图的视觉复核已做 ${used} 次（上限 ${FIGCHECK_VISION_ROUND_MAX} 次）`
  const stop = '本次不再做视觉复核。'
  const why = '原因：视觉复核几乎总会再列出新的建议，继续改图去换 PASS 不会收敛。'
  const deliver = '请交付当前版本，并在回复里列出尚未处理的问题，让用户决定。'
  return `已达上限，按当前结果交付。${reviewed}，${stop}${pending}${why}${deliver}`
}

function ledgerFile(dir: string, turnId: string): string {
  const name = `${createHash('sha256').update(turnId).digest('hex')}.json`
  return join(dir, name)
}

function emptyLedger(): Ledger {
  return { images: {} }
}

function readLedger(file: string): Ledger {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { images?: unknown }
    if (!parsed || typeof parsed.images !== 'object' || parsed.images === null) return emptyLedger()
    const images: Record<string, number> = {}
    for (const [key, value] of Object.entries(parsed.images as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 1000) {
        images[key] = value
      }
    }
    return { images }
  } catch {
    return emptyLedger()
  }
}

function writeLedger(file: string, ledger: Ledger): void {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(ledger), { mode: 0o600 })
  renameSync(tmp, file)
}

function pruneOldLedgers(dir: string): void {
  const cutoff = Date.now() - LEDGER_TTL_MS
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const file = join(dir, name)
    try {
      if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true })
    } catch {
      // A raced unlink is fine; the next record prunes again.
    }
  }
}

/** Returns undefined when the lock cannot be taken. Callers then fail open. */
function withLock<T>(dir: string, fn: () => T): T | undefined {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const lock = join(dir, '.lock')
  let held = false
  try {
    for (let i = 0; i < 40; i++) {
      try {
        mkdirSync(lock)
        held = true
        break
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'EEXIST') throw err
        try {
          if (Date.now() - statSync(lock).mtimeMs > 30_000) {
            rmSync(lock, { recursive: true, force: true })
            continue
          }
        } catch {
          // The lock disappeared between the failed mkdir and the stat.
        }
        try {
          execFileSync('sleep', ['0.05'])
        } catch {
          // sleep missing: retry immediately rather than skip the cap.
        }
      }
    }
    if (!held) return undefined
    return fn()
  } finally {
    if (held) rmSync(lock, { recursive: true, force: true })
  }
}

export function peekFigcheckVisionRounds(dir: string, turnId: string, imagePath: string): number {
  const found = withLock(dir, () => readLedger(ledgerFile(dir, turnId)).images[imagePath] ?? 0)
  return found ?? 0
}

/** Count one successful vision call. Returns the new total, or the old total if the lock was lost. */
export function recordFigcheckVisionRound(dir: string, turnId: string, imagePath: string): number {
  const recorded = withLock(dir, () => {
    pruneOldLedgers(dir)
    const file = ledgerFile(dir, turnId)
    const ledger = readLedger(file)
    const next = (ledger.images[imagePath] ?? 0) + 1
    ledger.images[imagePath] = next
    writeLedger(file, ledger)
    return next
  })
  if (recorded !== undefined) return recorded
  return readLedger(ledgerFile(dir, turnId)).images[imagePath] ?? 0
}
