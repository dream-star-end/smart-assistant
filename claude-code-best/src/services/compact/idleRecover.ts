/** Idle compact: freeze the tail, then either summarize once or rebuild
 * the same post-compact messages from a stored capsule. Hooks are not run. */
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Message, UserMessage } from '../../types/message.js'
import type { CompactionResult } from './compact.js'

export const IDLE_COMPACT_INSTRUCTIONS =
  'preserve the user goal, decisions, constraints, current work, files, errors, and next steps'

export interface IdleFrozenTail {
  uuid: string
  parentUuid: string | null
  text: string
}

export interface IdleFrozenAttachment {
  uuid: string
  text: string
}

export interface IdleNativeFile {
  v: 1
  opId: string
  revision: string
  sessionId: string
  summaryText?: string
  modelCalls: number
  modelStarted?: boolean
  frozenTail: IdleFrozenTail[]
  attachments: IdleFrozenAttachment[]
}

export interface IdleArtifact {
  messages: Array<Record<string, unknown>>
  digest: string
}

export function idleUuid(opId: string, role: string): string {
  const hex = createHash('sha256').update(`${opId}:${role}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** Same projection the gateway stores. Order matches buildPostCompactMessages. */
export function projectIdleArtifact(input: {
  opId: string
  summaryText: string
  tail: readonly IdleFrozenTail[]
  attachments: readonly IdleFrozenAttachment[]
}): IdleArtifact {
  const boundary = idleUuid(input.opId, 'boundary')
  const summary = idleUuid(input.opId, 'summary')
  const anchor = input.tail[input.tail.length - 1]?.uuid ?? null
  const messages: Array<Record<string, unknown>> = [
    { uuid: boundary, type: 'system', subtype: 'compact_boundary', parentUuid: anchor },
    { uuid: summary, type: 'user', isSynthetic: true, parentUuid: boundary, text: input.summaryText },
    ...input.tail.map((item) => ({ uuid: item.uuid, parentUuid: item.parentUuid, type: 'user', text: item.text })),
    ...input.attachments.map((item) => ({ uuid: item.uuid, type: 'attachment', parentUuid: summary, text: item.text })),
  ]
  return { messages, digest: createHash('sha256').update(JSON.stringify(messages)).digest('hex') }
}

export function idleNativeHome(): string {
  return process.env.OPENCLAUDE_HOME ?? join(homedir(), '.openclaude')
}

function nativeDir(sessionId: string, home = idleNativeHome()): string {
  return join(home, 'idle-native', encodeURIComponent(sessionId))
}

export function readIdleNativeFile(path: string): IdleNativeFile {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as IdleNativeFile
  if (parsed.v !== 1 || typeof parsed.opId !== 'string' || typeof parsed.revision !== 'string') {
    throw new Error('IDLE_RECOVERY_CORRUPT')
  }
  return parsed
}

export function writeIdleNativeFile(path: string, file: IdleNativeFile): void {
  mkdirSync(join(path, '..'), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(file))
  renameSync(tmp, path)
}

export function findIdleNativeFile(sessionId: string, home = idleNativeHome()): string | undefined {
  let names: string[] = []
  try { names = readdirSync(nativeDir(sessionId, home)) } catch { return undefined }
  const pending = names.filter((name) => name.endsWith('.json') && !name.endsWith('.tmp'))
  if (pending.length !== 1) return undefined
  return join(nativeDir(sessionId, home), pending[0]!)
}

export function messageText(message: Message): string {
  const content = (message as UserMessage).message?.content ?? (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((block) => {
    const row = block as { type?: unknown; text?: unknown }
    return row?.type === 'text' && typeof row.text === 'string' ? row.text : ''
  }).join('')
}

export function selectIdleTail(messages: readonly Message[]): IdleFrozenTail[] {
  const kept = messages.filter((message) => {
    if (message.type !== 'user' && message.type !== 'assistant') return false
    const text = messageText(message)
    return text.trim().length > 0 && !text.startsWith('/compact')
      && !text.startsWith(IDLE_COMPACT_INSTRUCTIONS)
  })
  return kept.slice(-6).map((message) => ({
    uuid: message.uuid,
    parentUuid: (message as { parentUuid?: string | null }).parentUuid ?? null,
    text: messageText(message),
  }))
}

function userMessage(uuid: string, text: string, summary = false): UserMessage {
  return {
    type: 'user',
    uuid: uuid as UserMessage['uuid'],
    timestamp: '1970-01-01T00:00:00.000Z',
    isMeta: summary ? true : undefined,
    isCompactSummary: summary ? true : undefined,
    isVisibleInTranscriptOnly: summary ? true : undefined,
    message: { role: 'user', content: text },
  } as UserMessage
}

export function buildIdleCompactionResult(file: IdleNativeFile, messages: readonly Message[]): {
  result: CompactionResult
  artifact: IdleArtifact
} {
  if (!file.summaryText) throw new Error('IDLE_HISTORY_PENDING')
  const artifact = projectIdleArtifact({
    opId: file.opId,
    summaryText: file.summaryText,
    tail: file.frozenTail,
    attachments: file.attachments,
  })
  const boundaryUuid = artifact.messages[0]!.uuid as string
  const summaryUuid = artifact.messages[1]!.uuid as string
  const originals = new Map(messages.map((message) => [message.uuid, message]))
  const anchor = file.frozenTail[file.frozenTail.length - 1]?.uuid
  const result: CompactionResult = {
    boundaryMarker: {
      type: 'system',
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
      isMeta: false,
      timestamp: '1970-01-01T00:00:00.000Z',
      uuid: boundaryUuid,
      level: 'info',
      logicalParentUuid: anchor,
      compactMetadata: {
        trigger: 'manual',
        preTokens: 0,
        idleReceiptDigest: artifact.digest,
        idleOpId: file.opId,
      },
    } as CompactionResult['boundaryMarker'],
    summaryMessages: [userMessage(summaryUuid, file.summaryText, true)],
    messagesToKeep: file.frozenTail.map((item) => originals.get(item.uuid) ?? userMessage(item.uuid, item.text)),
    attachments: file.attachments.map((item) => ({
      type: 'attachment',
      uuid: item.uuid,
      timestamp: '1970-01-01T00:00:00.000Z',
      attachment: { type: 'idle', text: item.text },
    })) as CompactionResult['attachments'],
    hookResults: [],
    preCompactTokenCount: 0,
    truePostCompactTokenCount: 0,
    idleStable: true,
  }
  return { result, artifact }
}

export async function applyIdleTranscript(input: {
  sessionId: string
  messages: Message[]
  artifact: IdleArtifact
  record: (messages: Message[]) => Promise<unknown>
  flush: () => Promise<void>
  load: (sessionId: string) => Promise<{ messages: Message[] } | null>
}): Promise<void> {
  await input.record(input.messages)
  await input.flush()
  const loaded = await input.load(input.sessionId)
  if (!loaded) throw new Error('IDLE_ARTIFACT_MISSING')
  const byId = new Map(loaded.messages.map((message) => [message.uuid, message]))
  for (const item of input.artifact.messages) {
    const found = byId.get(String(item.uuid))
    if (!found) throw new Error('IDLE_ARTIFACT_MISSING')
    if (typeof item.text === 'string' && !messageText(found).includes(item.text)) {
      throw new Error('IDLE_ARTIFACT_MISSING')
    }
  }
}

/**
 * Freeze the tail and obtain the summary without hooks.
 * modelStarted is durable before the model call, so a crash does not call it again.
 */
export async function resumeIdleSummary(input: {
  sessionId: string
  messages: readonly Message[]
  home?: string
  summarize?: (messages: Message[]) => Promise<string>
}): Promise<{ path: string; file: IdleNativeFile } | undefined> {
  const path = findIdleNativeFile(input.sessionId, input.home)
  if (!path) return undefined
  let file = readIdleNativeFile(path)
  if (file.sessionId !== input.sessionId) throw new Error('IDLE_RECOVERY_CORRUPT')
  if (file.frozenTail.length === 0) {
    file = { ...file, frozenTail: selectIdleTail(input.messages) }
    writeIdleNativeFile(path, file)
  }
  if (!file.summaryText) {
    if (file.modelStarted || !input.summarize) throw new Error('IDLE_HISTORY_PENDING')
    file = { ...file, modelStarted: true }
    writeIdleNativeFile(path, file)
    const summaryText = (await input.summarize([...input.messages])).trim()
    if (!summaryText) throw new Error('IDLE_HISTORY_PENDING')
    file = { ...file, summaryText, modelCalls: file.modelCalls + 1 }
    writeIdleNativeFile(path, file)
  }
  return { path, file }
}

/**
 * Returns undefined when this session has no gateway idle file, so a normal
 * /compact keeps its existing path.
 */
export async function runIdleCompact(input: {
  sessionId: string
  messages: Message[]
  home?: string
  summarize?: (messages: Message[]) => Promise<string>
  record: (messages: Message[]) => Promise<unknown>
  flush: () => Promise<void>
  load: (sessionId: string) => Promise<{ messages: Message[] } | null>
}): Promise<CompactionResult | undefined> {
  const resumed = await resumeIdleSummary(input)
  if (!resumed) return undefined
  const { buildPostCompactMessages } = await import('./compact.js')
  const built = buildIdleCompactionResult(resumed.file, input.messages)
  const messages = buildPostCompactMessages(built.result)
  await applyIdleTranscript({
    sessionId: input.sessionId,
    messages,
    artifact: built.artifact,
    record: input.record,
    flush: input.flush,
    load: input.load,
  })
  return built.result
}
