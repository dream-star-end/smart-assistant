/**
 * Engine-session hook injection: CCB settings.json + Cursor hooks.json.
 * Command strings point at efficiencyPreToolHook.ts, which imports
 * agentEfficiencyGuard.ts — one policy source.
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { resolveGuardMode, type GuardMode } from './agentEfficiencyGuard.js'

export type HookProtocol = 'ccb' | 'cursor'

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function resolveTsxRunner(execPath = process.execPath): string {
  try {
    const require = createRequire(import.meta.url)
    return `${shellQuote(execPath)} ${shellQuote(require.resolve('tsx/cli'))}`
  } catch {
    return `${shellQuote(execPath)} --import tsx`
  }
}

export function resolveEfficiencyHookScript(): string {
  return fileURLToPath(new URL('./efficiencyPreToolHook.ts', import.meta.url))
}

export function resolveEfficiencyHookCommand(
  protocol: HookProtocol,
  mode: GuardMode = resolveGuardMode(),
): string | null {
  if (mode === 'off') return null
  return `${resolveTsxRunner()} ${shellQuote(resolveEfficiencyHookScript())} --protocol=${protocol} --mode=${mode}`
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
          hooks: [{ type: 'command', command, timeout: 8 }],
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
      beforeShellExecution: [{ command, timeout: 8 }],
    },
  }
}
