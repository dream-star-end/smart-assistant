/**
 * Thin PreToolUse / beforeShellExecution adapter.
 *
 * CCB and Cursor spawn efficiencyHookRunner.cjs, which execs this file
 * (JSON on stdin → JSON on stdout). All policy lives in
 * agentEfficiencyGuard.ts and actionPolicyEngine.ts — this file only
 * translates protocols.
 *
 * Fault semantics:
 *   - Pure efficiency-guard mode (`OPENCLAUDE_ACTION_POLICY=off|0|false`) or
 *     failures after Action Policy has cleanly allowed: fail-open (allow, exit 0).
 *   - Action Policy enabled (default): policy evaluation exceptions, malformed
 *     payloads, or timeouts NEVER fail-open to allow; CCB emits `ask` and
 *     Cursor emits fail-closed `deny` (`requiresHumanApproval: true`), exit 0.
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ActionPolicyEvaluation } from '@openclaude/protocol'
import { scrubToolBrokerEnv } from '@openclaude/protocol/exec-env'
import {
  auditEfficiencyEscape,
  evaluateShellForHook,
  resolveGuardMode,
  type GuardMode,
  type HookDecision,
} from './agentEfficiencyGuard.js'
import {
  evaluateActionPolicy,
  isActionPolicyEnabled,
  type AiReviewHook,
  type LoadedActionPolicy,
} from './actionPolicyEngine.js'

export type HookProtocol = 'ccb' | 'cursor'

const INNER_TIMEOUT_MS = 1200

function resolveInnerTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.OPENCLAUDE_EFFICIENCY_HOOK_TIMEOUT_MS)
  if (!Number.isFinite(raw) || raw < 200) return INNER_TIMEOUT_MS
  return Math.min(4800, Math.max(INNER_TIMEOUT_MS, Math.trunc(raw) - 200))
}

export function parseHookProtocol(argv: string[] = process.argv): HookProtocol {
  const flag = argv.find((a) => a.startsWith('--protocol='))
  return flag?.slice('--protocol='.length) === 'cursor' ? 'cursor' : 'ccb'
}

export function parseHookMode(argv: string[] = process.argv): GuardMode {
  const flag = argv.find((a) => a.startsWith('--mode='))
  const raw = flag?.slice('--mode='.length)
  if (raw === 'off' || raw === 'warn' || raw === 'deny') return raw
  return resolveGuardMode()
}

export function extractShellCommand(input: Record<string, unknown>): string {
  if (typeof input.command === 'string') return input.command
  const toolInput = input.tool_input
  if (toolInput && typeof toolInput === 'object') {
    const rec = toolInput as Record<string, unknown>
    for (const key of ['command', 'cmd', 'script']) {
      if (typeof rec[key] === 'string') return rec[key] as string
    }
  }
  return ''
}

function isShellTool(input: Record<string, unknown>): boolean {
  const name = input.tool_name ?? input.tool
  if (typeof name !== 'string' || !name) return true
  return /^(Bash|Shell|bash|shell)$/i.test(name)
}

export function formatCcbAllow(): Record<string, unknown> {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
    },
  }
}

export function formatCursorAllow(): Record<string, unknown> {
  return { permission: 'allow' }
}

export function formatAllow(protocol: HookProtocol): Record<string, unknown> {
  return protocol === 'cursor' ? formatCursorAllow() : formatCcbAllow()
}

export function formatCcbHookResponse(decision: HookDecision): Record<string, unknown> {
  if (decision.decision === 'deny') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: decision.message ?? 'Blocked by efficiency guard',
      },
      reason: decision.message ?? 'Blocked by efficiency guard',
    }
  }
  if (decision.message) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        additionalContext: decision.message,
      },
    }
  }
  return formatCcbAllow()
}

export function formatCursorHookResponse(decision: HookDecision): Record<string, unknown> {
  if (decision.decision === 'deny') {
    return {
      permission: 'deny',
      agent_message: decision.message ?? 'Blocked by efficiency guard',
      user_message: decision.message ?? 'Blocked by efficiency guard',
    }
  }
  if (decision.message) {
    return { permission: 'allow', agent_message: decision.message }
  }
  return formatCursorAllow()
}

export interface ToolBrokerHookEvalRequest {
  readonly toolName: string
  readonly arguments: Readonly<Record<string, unknown>>
  readonly command?: string
  readonly target?: string
  readonly mainModel?: string
  readonly guardMode: GuardMode
}

export interface ToolBrokerHookEvalResponse {
  readonly decision: 'allow' | 'deny'
  readonly code?: string
  readonly reason?: string
  readonly message?: string
  readonly approvalStatus?: 'not_required' | 'approved' | 'denied' | 'detached_pending'
}

export { scrubToolBrokerEnv }

export function formatBrokerHookDecision(
  protocol: HookProtocol,
  result: ToolBrokerHookEvalResponse,
): Record<string, unknown> {
  if (result.decision === 'allow') {
    if (protocol === 'cursor') {
      return result.message ? { permission: 'allow', agent_message: result.message } : formatCursorAllow()
    }
    if (result.message) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          additionalContext: result.message,
        },
      }
    }
    return formatCcbAllow()
  }
  const reason = result.reason || result.code || 'Blocked by ToolBroker policy'
  if (protocol === 'cursor') {
    return {
      permission: 'deny',
      ...(result.approvalStatus === 'detached_pending' || result.code === 'APPROVAL_DEFERRED_DETACHED'
        ? { requiresHumanApproval: true }
        : {}),
      agent_message: reason,
      user_message: reason,
    }
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
    reason,
  }
}

export interface PreToolHookActionPolicyOptions {
  /** Override whether action-policy evaluation runs (defaults to OPENCLAUDE_ACTION_POLICY env). */
  actionPolicyEnabled?: boolean
  /** Pre-loaded policy or explicit YAML path (for tests / custom wiring). */
  loadedPolicy?: LoadedActionPolicy
  policyPath?: string
  /** Active main strong model id for `ai_review` inheritance. */
  mainModel?: string
  /** Strong-model read-only pre-review hook. */
  aiReviewHook?: AiReviewHook
  /** Optional live ToolBroker evaluator; when provided, delegates before offline fallback. */
  brokerEvaluate?: (req: ToolBrokerHookEvalRequest) => Promise<ToolBrokerHookEvalResponse>
}

function extractToolName(input: Record<string, unknown>): string {
  const name = input.tool_name ?? input.tool
  return typeof name === 'string' && name.trim() ? name.trim() : 'Bash'
}

function extractTarget(input: Record<string, unknown>): string | undefined {
  const direct = input.target
  if (typeof direct === 'string' && direct.trim()) return direct.trim()
  const toolInput = input.tool_input
  if (toolInput && typeof toolInput === 'object') {
    const rec = toolInput as Record<string, unknown>
    for (const key of ['target', 'provider', 'site', 'slug', 'url']) {
      if (typeof rec[key] === 'string' && (rec[key] as string).trim()) {
        return (rec[key] as string).trim()
      }
    }
  }
  return undefined
}

export function formatActionPolicyHookResponse(
  protocol: HookProtocol,
  evaluation: ActionPolicyEvaluation,
  extraMessage?: string | null,
): Record<string, unknown> | null {
  if (evaluation.tier === 'allow') return null
  const tag = evaluation.matchedRuleId ? `[action-policy:${evaluation.matchedRuleId}] ` : '[action-policy] '
  const baseReason = `${tag}${evaluation.reason}`
  const reason = extraMessage ? `${baseReason}\n${extraMessage}` : baseReason

  if (evaluation.tier === 'deny') {
    if (protocol === 'cursor') {
      return {
        permission: 'deny',
        agent_message: reason,
        user_message: reason,
        actionPolicy: evaluation,
      }
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
      reason,
      actionPolicy: evaluation,
    }
  }

  // `human_approval` (and any unescalated `ai_review`):
  //   - CCB natively supports `permissionDecision: 'ask'`.
  //   - Cursor ONLY supports `permission: 'allow' | 'deny'`; emitting `ask` would be
  //     rejected by Cursor / runner as invalid JSON! Fail closed as `deny` with an
  //     explicit human-approval-required message instead of ever allowing.
  if (protocol === 'cursor') {
    const approvalMsg = `需要人工审批后执行（Cursor 不支持原生 ask，已 fail-closed 拦截）：${reason}`
    return {
      permission: 'deny',
      requiresHumanApproval: true,
      agent_message: approvalMsg,
      user_message: approvalMsg,
      actionPolicy: evaluation,
    }
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: reason,
    },
    reason,
    actionPolicy: evaluation,
  }
}

export function formatActionPolicyFailClosed(
  protocol: HookProtocol,
  reason: string,
): Record<string, unknown> {
  const evaluation: ActionPolicyEvaluation = {
    tier: 'human_approval',
    initialTier: 'human_approval',
    matchedRuleId: null,
    category: null,
    reason,
  }
  return (
    formatActionPolicyHookResponse(protocol, evaluation) ??
    (protocol === 'cursor'
      ? {
          permission: 'deny',
          requiresHumanApproval: true,
          agent_message: reason,
          user_message: reason,
        }
      : {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'ask',
            permissionDecisionReason: reason,
          },
          reason,
        })
  )
}

async function tryEvaluatePreToolViaBroker(
  input: Record<string, unknown>,
  command: string,
  toolName: string,
  protocol: HookProtocol,
  mode: GuardMode,
  policyEnabled: boolean,
  options: PreToolHookActionPolicyOptions,
): Promise<Record<string, unknown> | null> {
  if (!options.brokerEvaluate) return null
  const toolInputObj =
    input.tool_input && typeof input.tool_input === 'object' && !Array.isArray(input.tool_input)
      ? (input.tool_input as Record<string, unknown>)
      : command
        ? { command }
        : {}
  const target = extractTarget(input)
  try {
    const brokerResult = await options.brokerEvaluate({
      toolName,
      arguments: toolInputObj,
      ...(command ? { command } : {}),
      ...(target ? { target } : {}),
      ...(options.mainModel
        ? { mainModel: options.mainModel }
        : typeof input.model === 'string'
          ? { mainModel: input.model }
          : {}),
      guardMode: mode,
    })
    return formatBrokerHookDecision(protocol, brokerResult)
  } catch (err) {
    if (policyEnabled) {
      const msg = err instanceof Error ? err.message : String(err)
      return formatActionPolicyFailClosed(
        protocol,
        `ToolBroker hook evaluation failed (fail-closed): ${msg}`,
      )
    }
    return null
  }
}

async function evaluateHookActionPolicySafe(
  input: Record<string, unknown>,
  toolName: string,
  command: string,
  options: PreToolHookActionPolicyOptions,
): Promise<{ readonly evaluation: ActionPolicyEvaluation; readonly clean: boolean }> {
  const toolInputObj =
    input.tool_input && typeof input.tool_input === 'object' && !Array.isArray(input.tool_input)
      ? (input.tool_input as Record<string, unknown>)
      : undefined
  try {
    const evaluation = await evaluateActionPolicy(
      {
        toolName,
        command: command || undefined,
        target: extractTarget(input),
        args: toolInputObj,
        mainModel:
          options.mainModel ??
          (typeof input.model === 'string' ? input.model : process.env.OPENCLAUDE_MAIN_MODEL),
        sessionKey: typeof input.session_key === 'string' ? input.session_key : undefined,
      },
      {
        loaded: options.loadedPolicy,
        policyPath: options.policyPath,
        mainModel: options.mainModel,
        aiReviewHook: options.aiReviewHook,
      },
    )
    return { evaluation, clean: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      clean: false,
      evaluation: {
        tier: 'human_approval',
        initialTier: 'human_approval',
        matchedRuleId: null,
        category: null,
        reason: `Action policy evaluation failed (fail-closed): ${msg}`,
      },
    }
  }
}

async function resolveCombinedPreToolDecision(
  protocol: HookProtocol,
  mode: GuardMode,
  command: string,
  shellTool: boolean,
  policyEvaluation: ActionPolicyEvaluation | null,
  effDecision: HookDecision | null,
): Promise<Record<string, unknown>> {
  // 1. Hard deny from either guard wins immediately (combine reasons if both flagged).
  if (policyEvaluation?.tier === 'deny') {
    return formatActionPolicyHookResponse(protocol, policyEvaluation, effDecision?.message) ?? formatAllow(protocol)
  }
  if (effDecision?.decision === 'deny') {
    const combinedMessage =
      policyEvaluation && policyEvaluation.tier !== 'allow'
        ? `${effDecision.message ?? 'Blocked by efficiency guard'}\n[action-policy] ${policyEvaluation.reason}`
        : effDecision.message
    const merged: HookDecision = { ...effDecision, message: combinedMessage ?? null }
    return protocol === 'cursor' ? formatCursorHookResponse(merged) : formatCcbHookResponse(merged)
  }
  // 2. Non-allow action-policy (`human_approval` / escalated `ai_review`) wins over warn/allow.
  if (policyEvaluation && policyEvaluation.tier !== 'allow') {
    return (
      formatActionPolicyHookResponse(protocol, policyEvaluation, effDecision?.message) ??
      formatActionPolicyFailClosed(protocol, policyEvaluation.reason)
    )
  }
  // 3. Action-policy allowed: fall through to efficiency guard (or allow for non-shell tools).
  if (!shellTool || !effDecision) return formatAllow(protocol)
  if (effDecision.escaped) await auditEfficiencyEscape(command, { protocol, mode })
  return protocol === 'cursor' ? formatCursorHookResponse(effDecision) : formatCcbHookResponse(effDecision)
}

export async function handlePreToolHookInput(
  raw: unknown,
  protocol: HookProtocol,
  mode: GuardMode = resolveGuardMode(),
  options: PreToolHookActionPolicyOptions = {},
): Promise<Record<string, unknown>> {
  const policyEnabled = options.actionPolicyEnabled ?? isActionPolicyEnabled()
  let policyEvaluatedCleanly = false
  try {
    if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
      if (policyEnabled) {
        return formatActionPolicyFailClosed(
          protocol,
          'Action policy received empty or malformed hook payload; human confirmation required.',
        )
      }
      return formatAllow(protocol)
    }

    const input = raw as Record<string, unknown>
    const command = extractShellCommand(input)
    const toolName = extractToolName(input)
    const hasActionablePayload =
      typeof input.tool_name === 'string' || typeof input.tool === 'string' || command.length > 0

    if (policyEnabled && !hasActionablePayload) {
      return formatActionPolicyFailClosed(
        protocol,
        'Action policy received empty hook event without tool or command; human confirmation required.',
      )
    }

    const brokerOut = hasActionablePayload
      ? await tryEvaluatePreToolViaBroker(input, command, toolName, protocol, mode, policyEnabled, options)
      : null
    if (brokerOut) return brokerOut

    let policyEvaluation: ActionPolicyEvaluation | null = null
    if (policyEnabled && hasActionablePayload) {
      const evaluated = await evaluateHookActionPolicySafe(input, toolName, command, options)
      policyEvaluation = evaluated.evaluation
      policyEvaluatedCleanly = evaluated.clean
    } else {
      policyEvaluatedCleanly = true
    }

    const shellTool = isShellTool(input)
    let effDecision: HookDecision | null = null
    if (shellTool) {
      try {
        effDecision = evaluateShellForHook(command, mode)
      } catch {
        effDecision = null
      }
    }

    return await resolveCombinedPreToolDecision(
      protocol,
      mode,
      command,
      shellTool,
      policyEvaluation,
      effDecision,
    )
  } catch (err) {
    if (policyEnabled && !policyEvaluatedCleanly) {
      const msg = err instanceof Error ? err.message : String(err)
      return formatActionPolicyFailClosed(
        protocol,
        `Action policy evaluation exception (fail-closed): ${msg}`,
      )
    }
    return formatAllow(protocol)
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')
}

function writeJson(obj: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
}

async function main(): Promise<void> {
  const protocol = parseHookProtocol()
  const mode = parseHookMode()
  const policyEnabled = isActionPolicyEnabled()
  const timer = setTimeout(() => {
    writeJson(
      policyEnabled
        ? formatActionPolicyFailClosed(protocol, 'Action policy evaluation timed out (fail-closed).')
        : formatAllow(protocol),
    )
    process.exit(0)
  }, resolveInnerTimeoutMs())
  try {
    let parsed: unknown = {}
    try {
      const raw = (await readStdin()).trim()
      if (!raw) {
        if (policyEnabled) {
          clearTimeout(timer)
          writeJson(
            formatActionPolicyFailClosed(
              protocol,
              'Action policy received empty stdin payload (fail-closed).',
            ),
          )
          return
        }
        parsed = {}
      } else {
        parsed = JSON.parse(raw)
      }
    } catch (err) {
      if (policyEnabled) {
        clearTimeout(timer)
        writeJson(
          formatActionPolicyFailClosed(
            protocol,
            `Action policy failed to read or parse stdin (fail-closed): ${err instanceof Error ? err.message : String(err)}`,
          ),
        )
        return
      }
      parsed = {}
    }
    const out = await handlePreToolHookInput(parsed, protocol, mode)
    clearTimeout(timer)
    writeJson(out)
  } catch (err) {
    clearTimeout(timer)
    writeJson(
      policyEnabled
        ? formatActionPolicyFailClosed(
            protocol,
            `Action policy hook exception (fail-closed): ${err instanceof Error ? err.message : String(err)}`,
          )
        : formatAllow(protocol),
    )
  }
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (invoked) {
  main().catch((err) => {
    const protocol = parseHookProtocol()
    writeJson(
      isActionPolicyEnabled()
        ? formatActionPolicyFailClosed(
            protocol,
            `Action policy hook fatal error (fail-closed): ${err instanceof Error ? err.message : String(err)}`,
          )
        : formatAllow(protocol),
    )
    process.exit(0)
  })
}
