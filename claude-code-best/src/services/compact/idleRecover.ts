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
  message: Message
}

export interface IdleFrozenAttachment {
  uuid: string
  message: Message
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
  const kept = (item: IdleFrozenTail) => ({
    ...item.message,
    uuid: item.uuid,
    parentUuid: (item.message as { parentUuid?: string | null }).parentUuid ?? item.parentUuid,
  })
  const messages: Array<Record<string, unknown>> = [
    { uuid: boundary, type: 'system', subtype: 'compact_boundary', parentUuid: anchor },
    { uuid: summary, type: 'user', isSynthetic: true, parentUuid: boundary,
      message: { role: 'user', content: input.summaryText } },
    ...input.tail.map((item) => kept(item)),
    ...input.attachments.map((item) => ({
      ...item.message,
      uuid: item.uuid,
      parentUuid: (item.message as { parentUuid?: string | null }).parentUuid ?? summary,
    })),
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
  const pending = names.filter((name) => name.endsWith('.json')
    && !name.endsWith('.done.json') && !name.endsWith('.tmp'))
  if (pending.length !== 1) return undefined
  return join(nativeDir(sessionId, home), pending[0]!)
}

export function archiveIdleNativeFile(path: string): void {
  if (!path.endsWith('.json') || path.endsWith('.done.json')) return
  try { renameSync(path, path.replace(/\.json$/, '.done.json')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
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

function cloneMessage(message: Message): Message {
  return JSON.parse(JSON.stringify(message)) as Message
}

/** Keep real messages. Attachments stay attachments. Nothing is reduced to text. */
export function selectIdlePreserve(messages: readonly Message[]): {
  tail: IdleFrozenTail[]
  attachments: IdleFrozenAttachment[]
} {
  const attachments = messages.filter((message) => message.type === 'attachment').map((message) => ({
    uuid: message.uuid,
    message: cloneMessage(message),
  }))
  const conversational = messages.filter((message) => {
    if (message.type !== 'user' && message.type !== 'assistant') return false
    const text = messageText(message)
    return !text.startsWith('/compact') && !text.startsWith(IDLE_COMPACT_INSTRUCTIONS)
  })
  return {
    tail: conversational.slice(-6).map((message) => ({
      uuid: message.uuid,
      parentUuid: (message as { parentUuid?: string | null }).parentUuid ?? null,
      message: cloneMessage(message),
    })),
    attachments,
  }
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

export function buildIdleCompactionResult(file: IdleNativeFile, _messages: readonly Message[]): {
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
  const anchor = file.frozenTail[file.frozenTail.length - 1]?.uuid
  const summaryMessage = userMessage(summaryUuid, file.summaryText, true)
  ;(summaryMessage as { parentUuid?: string }).parentUuid = boundaryUuid
  let previous = summaryUuid
  const kept = file.frozenTail.map((item) => {
    const message = JSON.parse(JSON.stringify(item.message)) as Message
    ;(message as { parentUuid?: string }).parentUuid = previous
    previous = message.uuid
    return message
  })
  const result: CompactionResult = {
    boundaryMarker: {
      type: 'system',
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
      isMeta: false,
      timestamp: '1970-01-01T00:00:00.000Z',
      uuid: boundaryUuid,
      level: 'info',
      parentUuid: null,
      logicalParentUuid: anchor,
      compactMetadata: {
        trigger: 'manual',
        preTokens: 0,
        idleReceiptDigest: artifact.digest,
        idleOpId: file.opId,
      },
    } as CompactionResult['boundaryMarker'],
    summaryMessages: [summaryMessage],
    messagesToKeep: kept,
    attachments: file.attachments.map((item) => item.message) as CompactionResult['attachments'],
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
  const stable = (message: Message | Record<string, unknown>) => ({
    uuid: message.uuid,
    type: message.type ?? null,
    parentUuid: (message as { parentUuid?: unknown }).parentUuid
      ?? (message as { logicalParentUuid?: unknown }).logicalParentUuid ?? null,
    role: (message as { message?: { role?: unknown } }).message?.role ?? null,
    content: (message as { message?: { content?: unknown } }).message?.content
      ?? (message as { content?: unknown }).content ?? null,
    attachment: (message as { attachment?: unknown }).attachment ?? null,
    subtype: (message as { subtype?: unknown }).subtype ?? null,
  })
  const expected = input.artifact.messages.map((item) => stable(item))
  const loadedById = new Map(loaded.messages.map((message) => [message.uuid, message]))
  const ordered = expected.map((item) => loadedById.get(String(item.uuid)))
  if (ordered.some((item) => !item)) throw new Error('IDLE_ARTIFACT_MISSING')
  const got = ordered.map((item) => stable(item as Message))
  if (JSON.stringify(got) !== JSON.stringify(expected)) throw new Error('IDLE_ARTIFACT_MISSING')
  const seen = loaded.messages.filter((message) => expected.some((item) => item.uuid === message.uuid))
  if (seen.map((message) => message.uuid).join() !== expected.map((item) => item.uuid).join()) {
    throw new Error('IDLE_ARTIFACT_MISSING')
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
  if (file.frozenTail.length === 0 && file.attachments.length === 0) {
    const preserved = selectIdlePreserve(input.messages)
    file = { ...file, frozenTail: preserved.tail, attachments: preserved.attachments }
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
  archiveIdleNativeFile(resumed.path)
  return built.result
}
