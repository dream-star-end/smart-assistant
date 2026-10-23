import { loadSessionUsageModels } from '@openclaude/storage'
import { readLiveRunnerModel } from '../localExecution.js'
import type { AgentSession } from '../sessionManager.js'
import type { TicketRun } from './domain.js'
import { taskboardRunControls } from './runControl.js'

/** Keep only whole UTF-8 characters, without allocating an unbounded output. */
function tailText(text: string, bytes: number): string {
  const buffer = Buffer.from(text.slice(-bytes), 'utf8')
  let start = Math.max(0, buffer.length - bytes)
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start += 1
  return buffer.subarray(start).toString('utf8')
}

export function taskboardPreview(session: AgentSession): NonNullable<TicketRun['preview']> {
  const blocks = session._durableDelegateTranscript ?? []
  let text = ''
  const toolNames: string[] = []
  // Only inspect a fixed tail. Never stringify the collector or tool arguments.
  for (let i = Math.max(0, blocks.length - 80); i < blocks.length; i += 1) {
    const value = blocks[i]
    if (!value || typeof value !== 'object') continue
    const block = value as Record<string, unknown>
    if (block.kind === 'text' && typeof block.text === 'string') {
      text = tailText(text + tailText(block.text, 3072), 3072)
    } else if (block.kind === 'tool_use' && typeof block.toolName === 'string') {
      const name = tailText(block.toolName.replace(/[\u0000-\u001f\u007f]/g, ''), 64)
      if (name && !toolNames.includes(name)) {
        toolNames.push(name)
        if (toolNames.length > 8) toolNames.shift()
      }
    }
  }
  const preview = { text, toolNames, lastActivityAt: session._taskboardLastActivityAt ?? null }
  // JSON escaping also consumes bytes (code and line breaks can double them).
  let budget = 3072
  while (Buffer.byteLength(JSON.stringify(preview), 'utf8') > 4096) {
    budget = Math.floor(budget * 0.75)
    preview.text = tailText(preview.text, budget)
  }
  return preview
}

/** Database-selected runs only; one indexed usage lookup for the whole page. */
export async function projectTaskboardRunSnapshots(
  runs: readonly TicketRun[],
  getSession: (key: string) => AgentSession | undefined,
  loadModels: typeof loadSessionUsageModels = loadSessionUsageModels,
): Promise<Record<string, Pick<TicketRun, 'actualModels' | 'preview' | 'stopRequested'>>> {
  if (runs.length > 200) throw new RangeError('taskboard snapshot exceeds run page')
  const keys = [...new Set(runs.flatMap((run) => run.sessionKey ? [run.sessionKey] : []))]
  let recorded: Record<string, string[]> = Object.create(null)
  try { recorded = await loadModels(keys) } catch { /* Live feedback survives a temporary usage database failure. */ }
  const result: Record<string, Pick<TicketRun, 'actualModels' | 'preview' | 'stopRequested'>> = Object.create(null)
  for (const run of runs) {
    const actualModels = [...(run.sessionKey ? recorded[run.sessionKey] ?? [] : [])]
    let preview: TicketRun['preview']
    const session = run.status === 'running' && run.sessionKey ? getSession(run.sessionKey) : undefined
    if (session && session.sessionKey === run.sessionKey && session.channel === 'taskboard' && session.agentId === run.agentId) {
      const live = readLiveRunnerModel(session)
      if (live && live !== 'auto' && !actualModels.includes(live)) actualModels.push(live)
      preview = taskboardPreview(session)
    }
    const control = run.leaseOwner ? taskboardRunControls.get(run.id, run.ticketId, run.leaseOwner) : undefined
    result[run.id] = { actualModels, stopRequested: control?.signal.aborted === true, ...(preview ? { preview } : {}) }
  }
  return result
}
