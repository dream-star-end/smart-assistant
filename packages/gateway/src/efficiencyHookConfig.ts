/**
 * Engine-session hook injection: CCB settings.json + Cursor hooks.json.
 * Command strings point at efficiencyHookRunner.cjs (fail-open wrapper),
 * which execs efficiencyPreToolHook.ts. Policy still lives in
 * agentEfficiencyGuard.ts — this file only builds config.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveGuardMode, type GuardMode } from './agentEfficiencyGuard.js'

export type HookProtocol = 'ccb' | 'cursor'

/** Engine-side backstop (seconds). Our runner times out well below this. */
export const EFFICIENCY_HOOK_ENGINE_TIMEOUT_SEC = 3

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function resolveEfficiencyHookRunner(): string {
  return fileURLToPath(new URL('./efficiencyHookRunner.cjs', import.meta.url))
}

export function resolveEfficiencyHookCommand(
  protocol: HookProtocol,
  mode: GuardMode = resolveGuardMode(),
): string | null {
  if (mode === 'off') return null
  return `${shellQuote(process.execPath)} ${shellQuote(resolveEfficiencyHookRunner())} --protocol=${protocol} --mode=${mode}`
}

/** tmp + rename so a crash cannot leave a half-written JSON the engine will parse. */
export function atomicWriteJsonFile(target: string, value: unknown, mode = 0o600): void {
  const dir = dirname(target)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = join(dir, `.${target.split('/').pop()}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode })
    renameSync(tmp, target)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      /* ignore */
    }
    throw err
  }
}

export function buildCcbEfficiencySettings(
  mode: GuardMode = resolveGuardMode(),
): Record<string, unknown> | null {
  const command = resolveEfficiencyHookCommand('ccb', mode)
  if (!command) return null
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash|Shell',
          hooks: [{ type: 'command', command, timeout: EFFICIENCY_HOOK_ENGINE_TIMEOUT_SEC }],
        },
      ],
    },
  }
}

export function buildCursorEfficiencyHooks(
  mode: GuardMode = resolveGuardMode(),
): Record<string, unknown> | null {
  const command = resolveEfficiencyHookCommand('cursor', mode)
  if (!command) return null
  return {
    version: 1,
    hooks: {
      beforeShellExecution: [
        {
          command,
          timeout: EFFICIENCY_HOOK_ENGINE_TIMEOUT_SEC,
          failClosed: false,
        },
      ],
    },
  }
}
