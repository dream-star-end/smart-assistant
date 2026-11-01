/** P2 native state references. These are not a second dispatch/tape authority. */
import { type Static, Type } from '@sinclair/typebox'
import {
  agentRemoteContentHash,
  remoteCanonical,
  requireRemote,
  validateRemote,
} from './agentRemote.js'
const closed = { additionalProperties: false }
const id = Type.String({ minLength: 1, maxLength: 160, pattern: '^[A-Za-z0-9_.:-]+$' })
const integer = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })
const digest = Type.String({ pattern: '^[a-f0-9]{64}$' })
const nativeId = Type.String({
  pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',
})
export const NativeCheckpointSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    checkpointId: digest,
    principalId: id,
    sessionId: id,
    nativeSessionId: nativeId,
    engine: Type.Literal('ccb'),
    engineVersion: id,
    cwd: Type.String({ minLength: 1, maxLength: 4096, pattern: '^/[^\\u0000]*$' }),
    environmentId: id,
    environmentGeneration: positive,
    bindingRevision: positive,
    // References must be supplied from the existing committed dispatch/tape owner.
    authority: Type.Object(
      { dispatchId: id, turnKey: id, tapeCursor: integer, nativeHeadUuid: id },
      closed,
    ),
    createdAtMs: positive,
    transcriptRelativePath: Type.String({ minLength: 1, maxLength: 4096 }),
    files: Type.Array(
      Type.Object(
        {
          relativePath: Type.String({ minLength: 1, maxLength: 4096 }),
          sizeBytes: integer,
          sha256: digest,
        },
        closed,
      ),
      { minItems: 1, maxItems: 2048 },
    ),
  },
  closed,
)
export type NativeCheckpoint = Static<typeof NativeCheckpointSchema>
export const NativeCheckpointIdentitySchema = Type.Pick(
  NativeCheckpointSchema,
  [
    'principalId',
    'sessionId',
    'nativeSessionId',
    'engine',
    'engineVersion',
    'cwd',
    'environmentId',
    'environmentGeneration',
  ],
  closed,
)
export type NativeCheckpointIdentity = Static<typeof NativeCheckpointIdentitySchema>
export function nativeCheckpointId(value: Omit<NativeCheckpoint, 'checkpointId'>): string {
  return agentRemoteContentHash(`agent-remote-native-checkpoint-v1\n${remoteCanonical(value)}`)
}
/** Exact allowed session subtree. No HOME/config/credential or global map copy. */
export function nativeSessionPathAllowed(
  path: string,
  nativeSessionId: string,
  kind: 'file' | 'directory' = 'file',
): boolean {
  if (
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))
  )
    return false
  const parts = path.split('/')
  if (parts[0] !== 'projects' || !/^[A-Za-z0-9_-]+$/.test(parts[1] ?? '')) return false
  if (kind === 'directory')
    return (
      parts[2] === nativeSessionId &&
      (parts.length === 3 ||
        (parts.length === 4 && ['subagents', 'tool-results'].includes(parts[3]!)))
    )
  if (parts.length === 3) return parts[2] === `${nativeSessionId}.jsonl`
  if (parts.length !== 5 || parts[2] !== nativeSessionId) return false
  if (parts[3] === 'subagents')
    return /^agent-a(?:[A-Za-z0-9_-]{1,96}-)?[a-f0-9]{16}\.(jsonl|meta\.json)$/.test(parts[4]!)
  if (parts[3] === 'tool-results') return /^toolu_[A-Za-z0-9_-]{1,128}\.(txt|json)$/.test(parts[4]!)
  return false
}
export function verifyNativeCheckpoint(value: unknown): asserts value is NativeCheckpoint {
  validateRemote<NativeCheckpoint>(NativeCheckpointSchema, value)
  const { checkpointId, ...semantic } = value
  requireRemote(checkpointId === nativeCheckpointId(semantic), 'checkpoint-hash')
  requireRemote(
    nativeSessionPathAllowed(value.transcriptRelativePath, value.nativeSessionId) &&
      value.transcriptRelativePath.endsWith(`${value.nativeSessionId}.jsonl`),
    'checkpoint-path',
  )
  const names = value.files.map((file) => file.relativePath)
  requireRemote(
    new Set(names).size === names.length && names.includes(value.transcriptRelativePath),
    'checkpoint-file-list',
  )
  requireRemote(
    names.every((path) => nativeSessionPathAllowed(path, value.nativeSessionId)),
    'checkpoint-path',
  )
  requireRemote(
    names.every((name, index) => index === 0 || names[index - 1]! < name),
    'checkpoint-file-order',
  )
}
export function checkpointMatchesIdentity(
  checkpoint: NativeCheckpoint,
  expected: NativeCheckpointIdentity,
): void {
  validateRemote<NativeCheckpointIdentity>(NativeCheckpointIdentitySchema, expected)
  for (const key of Object.keys(expected) as (keyof NativeCheckpointIdentity)[])
    requireRemote(checkpoint[key] === expected[key], 'checkpoint-identity')
}
