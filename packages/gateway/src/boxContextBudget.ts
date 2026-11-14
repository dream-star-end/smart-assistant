/**
 * OCV5-755 phase 2: Box Claude context budget.
 *
 * - Autocompact window: CCB compacts at a 400k working window while the model
 *   still runs with its full 1M window, so a session already above 400k
 *   compacts once at its next turn instead of failing.
 * - Pre-expiry idle compaction: a Box session that stays idle is compacted
 *   shortly before the 1h provider prompt cache expires (the summary request
 *   still reads the warm cache), instead of right after every turn.
 *
 * Each knob: env wins, then `<home>/runtime-flags/<name>`; `off` disables.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isBoxApiModel } from '@openclaude/protocol'

export const BOX_AUTO_COMPACT_WINDOW_DEFAULT = 400_000
/** Before the 1h cache TTL, leaving time for a 3 min idle turn. */
export const BOX_IDLE_PRE_EXPIRY_MS_DEFAULT = 50 * 60_000
/** Same floor master uses for compactRequired (boxIdleChain IDLE_COMPACT_USAGE_FLOOR). */
export const BOX_IDLE_PRE_EXPIRY_MIN_TOKENS = 167_000

function knob(home: string, name: string, envValue: string | undefined): string | undefined {
  if (envValue !== undefined && envValue.trim() !== '') return envValue.trim().toLowerCase()
  try {
    const raw = readFileSync(join(home, 'runtime-flags', name), 'utf8').trim().toLowerCase()
    return raw || undefined
  } catch {
    return undefined
  }
}

function intKnob(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback
  if (raw === 'off' || raw === '0') return 0
  const n = Number(raw)
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : fallback
}

/** CCB env value: the window for Box Claude models, '' (live CCB default) otherwise. */
export function boxAutoCompactWindowEnv(
  model: string | undefined,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!isBoxApiModel(model)) return ''
  const window = intKnob(
    knob(home, 'box-autocompact-window', env.OC_BOX_AUTO_COMPACT_WINDOW),
    BOX_AUTO_COMPACT_WINDOW_DEFAULT,
    100_000,
    1_000_000,
  )
  return window > 0 ? String(window) : ''
}

/** Idle delay before a pre-expiry compaction; 0 = old behavior (compact right after the turn). */
export function boxIdlePreExpiryMs(home: string, env: NodeJS.ProcessEnv = process.env): number {
  return intKnob(
    knob(home, 'box-idle-pre-expiry', env.OC_BOX_IDLE_PRE_EXPIRY_MS),
    BOX_IDLE_PRE_EXPIRY_MS_DEFAULT,
    60_000,
    58 * 60_000,
  )
}

/** OCV5-755: a later user turn, reset or teardown supersedes an armed pre-expiry compaction. */
export function cancelIdlePreExpiry(session: {
  _idlePreExpiryTimer?: ReturnType<typeof setTimeout>
  _idlePreExpirySource?: unknown
}): void {
  if (session._idlePreExpiryTimer) clearTimeout(session._idlePreExpiryTimer)
  session._idlePreExpiryTimer = undefined
  session._idlePreExpirySource = undefined
}
