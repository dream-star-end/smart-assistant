/** Idle compact: freeze the tail, then either summarize once or rebuild
 * the same post-compact messages from a stored capsule. Hooks are not run. */
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { UUID } from 'crypto'
import type { Message, UserMessage } from '../../types/message.js'
import type { CompactionResult } from './compact.js'
import { groupMessagesByApiRound } from './grouping.js'

export const IDLE_COMPACT_INSTRUCTIONS =
  'preserve the user goal, decisions, constraints, current work, files, errors, and next steps'

/** Outer transcript size, not the inner leaf's post-compact token count. */
export const IDLE_OUTER_TOKEN_FLOOR = 167_000
/** Same budget as session-memory tail retention. String bodies count. */
const IDLE_TAIL_MAX_TOKENS = 40_000
const IDLE_TAIL_MIN_TOKENS = 10_000
const IDLE_TAIL_MIN_TEXT = 5

export function outerHistoryNeedsCompact(messages: readonly unknown[]): boolean {
  return JSON.stringify(messages).length / 4 >= IDLE_OUTER_TOKEN_FLOOR
}

export function trustedIdleOpId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.CLAUDE_CODE_EXTRA_METADATA
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as { oc_turn_key?: unknown }
    return typeof parsed.oc_turn_key === 'string' && /^[0-9a-f]{64}$/.test(parsed.oc_turn_key)
      ? parsed.oc_turn_key
      : undefined
  } catch {
    return undefined
  }
}

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
  /** Loader receipt stored. The file stays readable; it is not the active op. */
  applied?: boolean
  /** Digest of the post-compact projection this process wrote. */
  artifact?: IdleArtifact
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

export function listIdleNativeFiles(sessionId: string, home = idleNativeHome()): string[] {
  let names: string[] = []
  try { names = readdirSync(nativeDir(sessionId, home)) } catch { return [] }
  return names
    .filter((name) => name.endsWith('.json') && !name.endsWith('.tmp') && !name.endsWith('.done.json'))
    .map((name) => join(nativeDir(sessionId, home), name))
}

/** Active op only. Applied files stay on disk for receipt recovery. Ambiguous → throw. */
export function findIdleNativeFile(sessionId: string, home = idleNativeHome()): string | undefined {
  const paths = listIdleNativeFiles(sessionId, home)
  if (paths.length === 0) return undefined
  const active = paths.filter((path) => !readIdleNativeFile(path).applied)
  if (active.length === 1) return active[0]
  if (active.length === 0) return undefined
  throw new Error('IDLE_HISTORY_PENDING')
}

export function readIdleNativeByOp(sessionId: string, opId: string, home = idleNativeHome()): string | undefined {
  return listIdleNativeFiles(sessionId, home).find((path) => readIdleNativeFile(path).opId === opId)
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

function messageTokens(message: Message): number {
  return Math.max(1, Math.ceil(JSON.stringify(message).length / 4))
}

function blockIds(message: Message, kind: 'tool_use' | 'tool_result'): string[] {
  const content = (message as UserMessage).message?.content
  if (!Array.isArray(content)) return []
  return content.flatMap((block) => {
    const row = block as { type?: string; id?: string; tool_use_id?: string }
    if (kind === 'tool_use' && row.type === 'tool_use' && row.id) return [row.id]
    if (kind === 'tool_result' && row.type === 'tool_result' && row.tool_use_id) return [row.tool_use_id]
    return []
  })
}

/** Complete tool groups, then single messages. A result stays with its tool_use.
 *  A long user prefix stays splittable so pairing cannot copy it all back. */
function atomicGroups(messages: readonly Message[]): Message[][] {
  const rounds = groupMessagesByApiRound([...messages])
  const groups: Message[][] = []
  const open = new Map<string, number>()
  for (const round of rounds) {
    const roundTokens = round.reduce((sum, message) => sum + messageTokens(message), 0)
    if (roundTokens <= IDLE_TAIL_MAX_TOKENS) {
      groups.push(round)
      continue
    }
    for (const message of round) {
      const joined = blockIds(message, 'tool_result')
        .map((id) => open.get(id))
        .find((index) => index !== undefined)
      if (joined !== undefined) {
        groups[joined]!.push(message)
        continue
      }
      groups.push([message])
      const index = groups.length - 1
      for (const id of blockIds(message, 'tool_use')) open.set(id, index)
    }
  }
  return groups
}

function boundedTail(messages: readonly Message[]): Message[] {
  const groups = atomicGroups(messages)
  const kept: Message[][] = []
  let tokens = 0
  let textCount = 0
  for (let index = groups.length - 1; index >= 0; index--) {
    const group = groups[index]!
    const groupTokens = group.reduce((sum, message) => sum + messageTokens(message), 0)
    if (kept.length > 0 && tokens >= IDLE_TAIL_MAX_TOKENS) break
    if (kept.length > 0 && tokens + groupTokens > IDLE_TAIL_MAX_TOKENS
      && tokens >= IDLE_TAIL_MIN_TOKENS && textCount >= IDLE_TAIL_MIN_TEXT) break
    kept.unshift(group)
    tokens += groupTokens
    textCount += group.filter((message) => messageText(message).length > 0).length
    if (tokens >= IDLE_TAIL_MAX_TOKENS) break
    if (tokens >= IDLE_TAIL_MIN_TOKENS && textCount >= IDLE_TAIL_MIN_TEXT) break
  }
  return kept.flat()
}

/** Keep a bounded tail and the attachments that belong to it.
 *  Parents already on disk are not rewritten. */
export function selectIdlePreserve(messages: readonly Message[]): {
  tail: IdleFrozenTail[]
  attachments: IdleFrozenAttachment[]
} {
  const conversational: Array<{ index: number; message: Message }> = []
  const attachmentRows: Array<{ index: number; message: Message }> = []
  messages.forEach((message, index) => {
    if (message.type === 'attachment') {
      attachmentRows.push({ index, message })
      return
    }
    if (message.type !== 'user' && message.type !== 'assistant') return
    const text = messageText(message)
    if (text.startsWith('/compact') || text.startsWith(IDLE_COMPACT_INSTRUCTIONS)) return
    conversational.push({ index, message })
  })
  const kept = boundedTail(conversational.map((row) => row.message))
  const keptIds = new Set(kept.map((message) => message.uuid))
  const first = conversational.find((row) => keptIds.has(row.message.uuid))
  const start = first?.index ?? Number.POSITIVE_INFINITY
  const tail = kept.map((message) => {
    const copy = cloneMessage(message)
    return {
      uuid: copy.uuid,
      parentUuid: (copy as { parentUuid?: string | null }).parentUuid ?? null,
      message: copy,
    }
  })
  const attachments = attachmentRows
    .filter((row) => row.index >= start)
    .map((row) => ({ uuid: row.message.uuid, message: cloneMessage(row.message) }))
  return { tail, attachments }
}

function userMessage(uuid: string, text: string, summary = false): UserMessage {
  return {
    type: 'user',
    uuid: uuid as UserMessage['uuid'],
    isMeta: summary ? true : undefined,
    isCompactSummary: summary ? true : undefined,
    isVisibleInTranscriptOnly: summary ? true : undefined,
    message: { role: 'user', content: text },
  } as UserMessage
}

/** Newest chain participant. Its clock is the real write time plus the same
 *  100ms resume margin stock /compact uses. The preserved tail is not restamped. */
function resumeLeaf(opId: string): Message {
  return {
    type: 'system',
    subtype: 'informational',
    content: 'Conversation compacted',
    isMeta: true,
    level: 'info',
    uuid: idleUuid(opId, 'resume-leaf'),
    timestamp: new Date(Date.now() + 100).toISOString(),
  } as Message
}

export function buildIdleCompactionResult(file: IdleNativeFile, _messages: readonly Message[],
  annotate: (boundary: CompactionResult['boundaryMarker'], anchor: UUID, kept: readonly Message[]) =>
    CompactionResult['boundaryMarker'] = (boundary) => boundary): {
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
  const summaryMessage = userMessage(summaryUuid, file.summaryText, true)
  const kept = file.frozenTail.map((item) => JSON.parse(JSON.stringify(item.message)) as Message)
  const boundary = annotate({
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    isMeta: false,
    timestamp: new Date().toISOString(),
    uuid: boundaryUuid as UUID,
    level: 'info',
    compactMetadata: {
      trigger: 'manual',
      preTokens: 0,
      idleReceiptDigest: artifact.digest,
      idleOpId: file.opId,
    },
  } as CompactionResult['boundaryMarker'], summaryUuid as UUID, kept)
  const result: CompactionResult = {
    boundaryMarker: boundary,
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
    role: (message as { message?: { role?: unknown } }).message?.role ?? null,
    content: (message as { message?: { content?: unknown } }).message?.content
      ?? (message as { content?: unknown }).content ?? null,
    attachment: (message as { attachment?: unknown }).attachment ?? null,
    subtype: (message as { subtype?: unknown }).subtype ?? null,
  })
  const expected = input.messages.map((item) => stable(item as Message))
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
  const opId = trustedIdleOpId()
  const path = (opId ? readIdleNativeByOp(input.sessionId, opId, input.home) : undefined)
    ?? findIdleNativeFile(input.sessionId, input.home)
  if (!path) return undefined
  let file = readIdleNativeFile(path)
  if (file.sessionId !== input.sessionId) throw new Error('IDLE_RECOVERY_CORRUPT')
  if (file.applied && !file.summaryText) return { path, file }
  if (file.frozenTail.length === 0 && file.attachments.length === 0) {
    const preserved = selectIdlePreserve(input.messages)
    file = { ...file, frozenTail: preserved.tail, attachments: preserved.attachments }
    writeIdleNativeFile(path, file)
  }
  if (!file.summaryText && !file.modelStarted && !outerHistoryNeedsCompact(input.messages)) {
    file = { ...file, applied: true }
    writeIdleNativeFile(path, file)
    return { path, file }
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
  record: (
    messages: Message[],
    teamInfo?: { teamName?: string; agentName?: string },
    startingParentUuid?: string,
    allMessages?: readonly Message[],
    preserveMessageTimestamp?: boolean,
  ) => Promise<unknown>
  flush: () => Promise<void>
  load: (sessionId: string) => Promise<{ messages: Message[] } | null>
}): Promise<CompactionResult | 'short' | undefined> {
  const resumed = await resumeIdleSummary(input)
  if (!resumed) return undefined
  if (resumed.file.applied && !resumed.file.summaryText) return 'short'
  const { annotateBoundaryWithPreservedSegment, buildPostCompactMessages } = await import('./compact.js')
  const built = buildIdleCompactionResult(resumed.file, input.messages, annotateBoundaryWithPreservedSegment)
  const result: CompactionResult = resumed.file.frozenTail.length === 0
    ? built.result
    : { ...built.result, hookResults: [resumeLeaf(resumed.file.opId) as CompactionResult['hookResults'][number]] }
  const messages = buildPostCompactMessages(result)
  // recordTranscript's 5th argument preserves the leaf clock. true in the
  // 2nd argument is teamInfo and would stamp the leaf with now().
  await input.record(messages, undefined, undefined, undefined, true)
  await applyIdleTranscript({
    sessionId: input.sessionId,
    messages,
    artifact: built.artifact,
    record: (rows) => input.record(rows),
    flush: input.flush,
    load: input.load,
  })
  writeIdleNativeFile(resumed.path, { ...resumed.file, applied: true, artifact: built.artifact })
  return result
}
