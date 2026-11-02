/** Streaming readback for the actual native Writer. The caller holds the native
 * UUID flock and a managed SessionReadHandle through control commit. */
import { createHash } from 'node:crypto'
import { requireRemote } from '@openclaude/protocol/agentRemote'
import {
  type NativeMessageProjection,
  type NativeTranscriptTarget,
  nativeMessageProjectionsHash,
  nativeTranscriptMessageHash,
  nativeTranscriptTargetKey,
} from '@openclaude/protocol/agentRemoteNativeDelivery'
import { createNativeTranscriptLines } from './nativeTranscriptLines.js'
import type { SessionReadHandle } from './sessionFileIo.js'
export interface NativeTranscriptReadback {
  readonly headBytes: number
  readonly prefixHash: string
  readonly headUuid?: string
  readonly foundCount: number
  readonly transcriptRecords: number
  readonly anchorUuids: readonly string[]
  readonly assistantUuids: readonly string[]
  readonly projectionsHash: string
}
export async function readNativeTranscriptDelivery(
  file: SessionReadHandle,
  nativeSessionId: string,
  target: NativeTranscriptTarget,
  expected: readonly NativeMessageProjection[],
  requireAll: boolean,
): Promise<NativeTranscriptReadback> {
  const targetKey = nativeTranscriptTargetKey(target)
  requireRemote(
    expected.every((message) => nativeTranscriptTargetKey(message.target) === targetKey),
    'native-proof-target',
  )
  const indexes = new Map(expected.map((message, index) => [message.uuid, index]))
  requireRemote(indexes.size === expected.length, 'native-proof-duplicate-projection')
  const initial = await file.stat()
  requireRemote(
    initial.isFile() && initial.nlink > 0 && Number.isSafeInteger(initial.size),
    'native-proof-file',
  )
  const hash = createHash('sha256')
  const buffer = Buffer.alloc(65536)
  let position = 0
  let headUuid: string | undefined
  let foundCount = 0
  let transcriptRecords = 0
  const requiredAnchors = new Set(
    expected
      .flatMap((message) => [message.parentUuid, message.logicalParentUuid])
      .filter((uuid): uuid is string => typeof uuid === 'string'),
  )
  const anchors = new Map<string, string>()
  const lines = createNativeTranscriptLines((text) => {
    if (!text.trim()) return
    const entry: unknown = JSON.parse(text)
    requireRemote(
      entry && typeof entry === 'object' && !Array.isArray(entry),
      'native-proof-record',
    )
    const row = entry as Record<string, unknown>
    if (row.sessionId !== undefined)
      requireRemote(row.sessionId === nativeSessionId, 'native-proof-session')
    if (typeof row.uuid !== 'string') return
    const transcript = ['user', 'assistant', 'attachment', 'system'].includes(String(row.type))
    const index = indexes.get(row.uuid)
    if (index !== undefined) {
      requireRemote(
        index === foundCount,
        index < foundCount ? 'native-proof-duplicate-uuid' : 'native-proof-nonprefix',
      )
      const message = expected[index]!
      requireRemote(
        transcript &&
          row.sessionId === nativeSessionId &&
          row.timestamp === message.timestamp &&
          row.parentUuid === message.parentUuid &&
          row.logicalParentUuid === message.logicalParentUuid &&
          row.isSidechain === (target.kind === 'sidechain') &&
          row.agentId === (target.kind === 'sidechain' ? target.agentId : undefined) &&
          nativeTranscriptMessageHash(row) === message.projectionHash,
        'native-proof-projection-conflict',
      )
      for (const anchor of [message.parentUuid, message.logicalParentUuid])
        if (typeof anchor === 'string')
          requireRemote(anchors.has(anchor), 'native-proof-parent-missing')
      if (row.type === 'user' && row.sourceToolAssistantUUID)
        requireRemote(
          row.sourceToolAssistantUUID === message.parentUuid &&
            anchors.get(String(row.sourceToolAssistantUUID)) === 'assistant',
          'native-proof-source-parent',
        )
      if (
        target.kind === 'main' &&
        message.parentUuid === null &&
        !(row.type === 'system' && row.subtype === 'compact_boundary')
      )
        requireRemote(transcriptRecords === 0, 'native-proof-root-conflict')
      foundCount++
    }
    headUuid = row.uuid
    if (transcript) {
      transcriptRecords++
      if (requiredAnchors.has(row.uuid)) anchors.set(row.uuid, String(row.type))
    }
  })
  while (position < initial.size) {
    const { bytesRead } = await file.read(
      buffer,
      0,
      Math.min(buffer.length, initial.size - position),
      position,
    )
    requireRemote(bytesRead > 0, 'native-proof-short-read')
    const bytes = buffer.subarray(0, bytesRead)
    hash.update(bytes)
    position += bytesRead
    lines.push(bytes)
  }
  requireRemote(lines.complete(), 'native-proof-partial-line')
  const final = await file.stat()
  requireRemote(
    initial.dev === final.dev &&
      initial.ino === final.ino &&
      initial.size === final.size &&
      initial.mtimeMs === final.mtimeMs &&
      initial.ctimeMs === final.ctimeMs,
    'native-proof-file-changed',
  )
  if (requireAll) requireRemote(foundCount === expected.length, 'native-proof-message-missing')
  return {
    headBytes: position,
    prefixHash: hash.digest('hex'),
    headUuid,
    foundCount,
    transcriptRecords,
    anchorUuids: Object.freeze([...anchors.keys()]),
    assistantUuids: Object.freeze(
      [...anchors.entries()].filter(([, type]) => type === 'assistant').map(([uuid]) => uuid),
    ),
    projectionsHash: nativeMessageProjectionsHash(expected.slice(0, foundCount)),
  }
}
