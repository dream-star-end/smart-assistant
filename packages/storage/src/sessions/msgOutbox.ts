import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { paths } from '../paths.js'
import { getActiveBackend } from './backendRegistry.js'
import type { QueuedMessage } from './types.js'

const TERMINAL_OUTBOX_DROP_REASONS = new Set([
  'already_exists',
  'session_not_found',
  'session_deleted',
  'malformed',
  'oversized',
])

export function queuedMessageToLine(entry: QueuedMessage): string {
  return `${JSON.stringify(entry)}\n`
}

export function parseQueuedMessageLine(line: string): QueuedMessage | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as QueuedMessage
    if (
      !parsed ||
      typeof parsed.sessId !== 'string' ||
      typeof parsed.userId !== 'string' ||
      !parsed.message ||
      typeof parsed.message.id !== 'string'
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export async function queueMessageToOutbox(entry: QueuedMessage): Promise<void> {
  await mkdir(dirname(paths.msgOutbox), { recursive: true })
  await appendFile(paths.msgOutbox, queuedMessageToLine(entry), { encoding: 'utf8' })
}

export async function appendServerAuthoredMessageDurable(
  sessId: string,
  userId: string,
  message: {
    id: string
    role: 'assistant' | 'user' | 'system' | 'thinking' | 'tool' | 'permission'
    text?: string
    ts?: number
    [k: string]: unknown
  },
): Promise<
  | { applied: true }
  | { applied: false; reason: 'already_exists' | 'malformed' | 'session_deleted' | 'oversized' }
  | { applied: false; reason: 'queued_to_outbox'; error: string }
> {
  try {
    const r = await getActiveBackend().appendServerAuthoredMessage(sessId, userId, message)
    if (r.applied) return { applied: true }
    if (r.reason === 'session_not_found') {
      await queueMessageToOutbox({
        sessId,
        userId,
        message,
        queuedAt: Date.now(),
        reason: 'session_not_found',
      })
      return { applied: false, reason: 'queued_to_outbox', error: 'session_not_found' }
    }
    if (r.reason === 'session_deleted') return { applied: false, reason: 'session_deleted' }
    if (r.reason === 'oversized') return { applied: false, reason: 'oversized' }
    return { applied: false, reason: r.reason ?? 'malformed' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    try {
      await queueMessageToOutbox({
        sessId,
        userId,
        message,
        queuedAt: Date.now(),
        reason: msg,
      })
    } catch {
      throw err
    }
    return { applied: false, reason: 'queued_to_outbox', error: msg }
  }
}

async function replayOneOutboxEntry(
  entry: QueuedMessage,
): Promise<'applied' | 'dropped' | 'requeued'> {
  try {
    const r = await getActiveBackend().appendServerAuthoredMessage(
      entry.sessId,
      entry.userId,
      entry.message,
    )
    if (r.applied) return 'applied'
    if (r.reason && TERMINAL_OUTBOX_DROP_REASONS.has(r.reason)) return 'dropped'
    return 'requeued'
  } catch {
    return 'requeued'
  }
}

export async function replayMsgOutbox(): Promise<{
  processed: number
  applied: number
  dropped: number
  requeued: number
  malformed: number
}> {
  let raw: string
  try {
    raw = await readFile(paths.msgOutbox, { encoding: 'utf8' })
  } catch (err: unknown) {
    if (err && typeof err === 'object' && (err as { code?: unknown }).code === 'ENOENT') {
      return { processed: 0, applied: 0, dropped: 0, requeued: 0, malformed: 0 }
    }
    throw err
  }
  const lines = raw.split('\n')
  let applied = 0
  let dropped = 0
  let malformed = 0
  const survivors: string[] = []

  for (const line of lines) {
    if (!line.trim()) continue
    const entry = parseQueuedMessageLine(line)
    if (!entry) {
      malformed++
      continue
    }
    const outcome = await replayOneOutboxEntry(entry)
    if (outcome === 'applied') applied++
    else if (outcome === 'dropped') dropped++
    else survivors.push(queuedMessageToLine(entry).trimEnd())
  }

  const requeued = survivors.length
  const processed = applied + dropped + requeued + malformed
  const tmp = `${paths.msgOutbox}.tmp-${process.pid}-${Date.now()}`
  const content = survivors.length > 0 ? `${survivors.join('\n')}\n` : ''
  await mkdir(dirname(paths.msgOutbox), { recursive: true })
  await writeFile(tmp, content, { encoding: 'utf8' })
  await rename(tmp, paths.msgOutbox)

  return { processed, applied, dropped, requeued, malformed }
}
