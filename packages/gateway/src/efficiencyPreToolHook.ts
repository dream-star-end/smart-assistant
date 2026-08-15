/**
 * Thin PreToolUse / beforeShellExecution adapter.
 *
 * CCB and Cursor spawn efficiencyHookRunner.cjs, which execs this file
 * (JSON on stdin → JSON on stdout). All policy lives in
 * agentEfficiencyGuard.ts — this file only translates protocols.
 *
 * Any exception path returns a protocol-valid allow and exits 0 (fail-open).
 * The runner is the outer belt; this is the inner one.
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

const INNER_TIMEOUT_MS = 1200

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

export async function handlePreToolHookInput(
  raw: unknown,
  protocol: HookProtocol,
  mode: GuardMode = resolveGuardMode(),
): Promise<Record<string, unknown>> {
  try {
    const input = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    if (!isShellTool(input)) {
      return formatAllow(protocol)
    }
    const command = extractShellCommand(input)
    const decision = evaluateShellForHook(command, mode)
    if (decision.escaped) {
      await auditEfficiencyEscape(command, { protocol, mode })
    }
    return protocol === 'cursor' ? formatCursorHookResponse(decision) : formatCcbHookResponse(decision)
  } catch {
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
  const timer = setTimeout(() => {
    writeJson(formatAllow(protocol))
    process.exit(0)
  }, INNER_TIMEOUT_MS)
  try {
    let parsed: unknown = {}
    try {
      const raw = (await readStdin()).trim()
      parsed = raw ? JSON.parse(raw) : {}
    } catch {
      parsed = {}
    }
    const out = await handlePreToolHookInput(parsed, protocol, mode)
    clearTimeout(timer)
    writeJson(out)
  } catch {
    clearTimeout(timer)
    writeJson(formatAllow(protocol))
  }
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (invoked) {
  main().catch(() => {
    const protocol = parseHookProtocol()
    writeJson(formatAllow(protocol))
    process.exit(0)
  })
}
