/**
 * Thin PreToolUse / beforeShellExecution adapter.
 *
 * CCB and Cursor spawn this as a command hook (JSON on stdin → JSON on stdout).
 * All policy lives in agentEfficiencyGuard.ts — this file only translates protocols.
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  auditEfficiencyEscape,
  evaluateShellForHook,
  resolveGuardMode,
  type GuardMode,
  type HookDecision,
} from './agentEfficiencyGuard.js'

export type HookProtocol = 'ccb' | 'cursor'

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
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
    },
  }
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
  return { permission: 'allow' }
}

export async function handlePreToolHookInput(
  raw: unknown,
  protocol: HookProtocol,
  mode: GuardMode = resolveGuardMode(),
): Promise<Record<string, unknown>> {
  const input = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  if (!isShellTool(input)) {
    return protocol === 'cursor' ? { permission: 'allow' } : formatCcbHookResponse({
      decision: 'allow',
      escaped: false,
      hits: [],
      message: null,
    })
  }
  const command = extractShellCommand(input)
  const decision = evaluateShellForHook(command, mode)
  if (decision.escaped) {
    await auditEfficiencyEscape(command, { protocol, mode })
  }
  return protocol === 'cursor' ? formatCursorHookResponse(decision) : formatCcbHookResponse(decision)
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

async function main(): Promise<void> {
  const protocol = parseHookProtocol()
  const mode = parseHookMode()
  let parsed: unknown = {}
  try {
    const raw = (await readStdin()).trim()
    parsed = raw ? JSON.parse(raw) : {}
  } catch {
    parsed = {}
  }
  const out = await handlePreToolHookInput(parsed, protocol, mode)
  process.stdout.write(`${JSON.stringify(out)}\n`)
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (invoked) {
  main().catch((err) => {
    console.error('[oc-efficiency-guard] hook failed', err)
    process.stdout.write(`${JSON.stringify({ permission: 'allow' })}\n`)
  })
}
