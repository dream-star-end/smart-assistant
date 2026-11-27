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
import { isActionPolicyEnabled } from './actionPolicyEngine.js'

export type HookProtocol = 'ccb' | 'cursor'

/** Engine-side backstop (seconds) in efficiency-only mode. */
export const EFFICIENCY_HOOK_ENGINE_TIMEOUT_SEC = 4
/** Engine-side backstop (seconds) when Action Policy is enabled (> runner 5s max timeout). */
export const ACTION_POLICY_HOOK_ENGINE_TIMEOUT_SEC = 6
/** Engine-side backstop (seconds) when live ToolBroker 55s async approval is active. */
export const TOOL_BROKER_HOOK_ENGINE_TIMEOUT_SEC = 65

export interface EfficiencyBrokerHookBinding {
  readonly brokerUrl: string
  readonly hookTokenFile: string
  readonly revoke: () => void
}

export interface EfficiencyBrokerHookProviderRequest {
  readonly protocol: HookProtocol
  readonly sessionKey: string
  readonly gatewayPort: number
  readonly readOnly?: boolean
  readonly hermeticNoTools?: boolean
  readonly tokenFilePath?: string
  readonly workspaceCwd?: string
}

export type EfficiencyBrokerHookProvider = (
  req: EfficiencyBrokerHookProviderRequest,
) => Promise<EfficiencyBrokerHookBinding | null> | EfficiencyBrokerHookBinding | null

export interface EfficiencyHookBuildOptions {
  readonly brokerApprovalActive?: boolean
  readonly brokerHook?: Pick<EfficiencyBrokerHookBinding, 'brokerUrl' | 'hookTokenFile'> | null
}

let activeEfficiencyBrokerHookProvider: EfficiencyBrokerHookProvider | null = null

/** Register Gateway selfhost ToolBroker hook provider for CCB/Cursor (L3 rt-misc -> rt-context-policy). */
export function registerEfficiencyBrokerHookProvider(
  provider: EfficiencyBrokerHookProvider | null,
): () => void {
  activeEfficiencyBrokerHookProvider = provider
  return () => {
    if (activeEfficiencyBrokerHookProvider === provider) {
      activeEfficiencyBrokerHookProvider = null
    }
  }
}

/** B03: Distinguish optional standalone mode (false) from enabled selfhost broker (true, fail-closed spawn). */
export function isEfficiencyBrokerHookRequired(): boolean {
  return activeEfficiencyBrokerHookProvider !== null
}

export async function resolveActiveEfficiencyBrokerHook(
  req: EfficiencyBrokerHookProviderRequest,
): Promise<EfficiencyBrokerHookBinding | null> {
  if (!activeEfficiencyBrokerHookProvider) return null
  return await activeEfficiencyBrokerHookProvider(req)
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function resolveEfficiencyHookRunner(): string {
  return fileURLToPath(new URL('./efficiencyHookRunner.cjs', import.meta.url))
}

export function resolveEfficiencyHookCommand(
  protocol: HookProtocol,
  mode: GuardMode = resolveGuardMode(),
  actionPolicyEnabled: boolean = isActionPolicyEnabled(),
  opts?: EfficiencyHookBuildOptions,
): string | null {
  const brokerHook = opts?.brokerHook ?? null
  // Decouple action-policy enforcement from efficiency guard: only omit hook
  // registration when efficiency guard, action-policy, AND broker hook are all off.
  if (mode === 'off' && !actionPolicyEnabled && !brokerHook) return null
  const parts = [
    shellQuote(process.execPath),
    shellQuote(resolveEfficiencyHookRunner()),
    `--protocol=${protocol}`,
    `--mode=${mode}`,
  ]
  if (brokerHook) {
    parts.push(`--broker-url=${shellQuote(brokerHook.brokerUrl)}`)
    parts.push(`--broker-token-file=${shellQuote(brokerHook.hookTokenFile)}`)
  }
  return parts.join(' ')
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
  actionPolicyEnabled: boolean = isActionPolicyEnabled(),
  opts?: EfficiencyHookBuildOptions,
): Record<string, unknown> | null {
  const command = resolveEfficiencyHookCommand('ccb', mode, actionPolicyEnabled, opts)
  if (!command) return null
  const brokerActive = opts?.brokerApprovalActive === true || Boolean(opts?.brokerHook)
  const timeout = brokerActive
    ? TOOL_BROKER_HOOK_ENGINE_TIMEOUT_SEC
    : actionPolicyEnabled
      ? ACTION_POLICY_HOOK_ENGINE_TIMEOUT_SEC
      : EFFICIENCY_HOOK_ENGINE_TIMEOUT_SEC
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash|Shell',
          hooks: [{ type: 'command', command, timeout }],
        },
      ],
    },
  }
}

export function buildCursorEfficiencyHooks(
  mode: GuardMode = resolveGuardMode(),
  actionPolicyEnabled: boolean = isActionPolicyEnabled(),
  opts?: EfficiencyHookBuildOptions,
): Record<string, unknown> | null {
  const command = resolveEfficiencyHookCommand('cursor', mode, actionPolicyEnabled, opts)
  if (!command) return null
  const brokerActive = opts?.brokerApprovalActive === true || Boolean(opts?.brokerHook)
  const timeout = brokerActive
    ? TOOL_BROKER_HOOK_ENGINE_TIMEOUT_SEC
    : actionPolicyEnabled
      ? ACTION_POLICY_HOOK_ENGINE_TIMEOUT_SEC
      : EFFICIENCY_HOOK_ENGINE_TIMEOUT_SEC
  return {
    version: 1,
    hooks: {
      beforeShellExecution: [
        {
          command,
          timeout,
          failClosed: actionPolicyEnabled || brokerActive,
        },
      ],
    },
  }
}
