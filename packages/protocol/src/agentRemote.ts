/** Experimental v1. No production caller. Never grants authority by itself. */
import { createHash } from 'node:crypto'
import { type Static, Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { type JsonValue, canonicalizePayload } from './modelAuthority.js'

export const AGENT_REMOTE_VERSION = 1 as const
const closed = { additionalProperties: false }
const id = Type.String({ minLength: 1, maxLength: 160, pattern: '^[A-Za-z0-9_.:-]+$' })
const integer = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' })
const path = Type.String({ minLength: 1, maxLength: 4096, pattern: '^/[^\\u0000]*$' })
const literalUnion = <const T extends readonly string[]>(values: T) =>
  Type.Unsafe<T[number]>(Type.Union(values.map((value) => Type.Literal(value))))
export const AGENT_REMOTE_CAPABILITIES = [
  'file.read',
  'file.write',
  'file.edit',
  'file.cas',
  'process.exec',
  'process.status',
  'process.logs',
  'process.stop',
  'process.stop-tree',
  'process.pty',
  'journal.durable',
] as const
export const CapabilitySchema = literalUnion(AGENT_REMOTE_CAPABILITIES)
export type AgentRemoteCapability = Static<typeof CapabilitySchema>
export const WorkerSchema = Type.Object(
  {
    protocolVersion: Type.Literal(AGENT_REMOTE_VERSION),
    principalId: id,
    workerId: id,
    workerInstanceId: id,
    engines: Type.Array(id, { minItems: 1, uniqueItems: true }),
  },
  closed,
)
export type AgentRemoteWorker = Static<typeof WorkerSchema>
export const EnvironmentSchema = Type.Object(
  {
    protocolVersion: Type.Literal(AGENT_REMOTE_VERSION),
    principalId: id,
    environmentId: id,
    generation: positive,
    kind: Type.Literal('container'),
    containerId: id,
    containerIncarnation: id,
    runtimeRevision: id,
    workspaceRoot: path,
    capabilities: Type.Array(CapabilitySchema, { uniqueItems: true }),
  },
  closed,
)
export type AgentRemoteEnvironment = Static<typeof EnvironmentSchema>
export const BindingSchema = Type.Object(
  {
    principalId: id,
    sessionId: id,
    bindingRevision: positive,
    workerId: id,
    workerInstanceId: id,
    environmentId: id,
    environmentGeneration: positive,
  },
  closed,
)
export type AgentRemoteBinding = Static<typeof BindingSchema>
export const LeaseSchema = Type.Object(
  {
    ownerInstanceId: id,
    epoch: positive,
  },
  closed,
)
export type AgentRemoteLeaseToken = Static<typeof LeaseSchema>
const job = { jobId: id, sourceOperationId: id }
export const CommandSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('file.read'),
      path,
      offsetBytes: integer,
      limitBytes: Type.Integer({ minimum: 1, maximum: 262144 }),
    },
    closed,
  ),
  Type.Object(
    {
      kind: Type.Literal('file.write'),
      path,
      contentUtf8: Type.String({ maxLength: 262144 }),
      expectedSha256: Type.Optional(hash),
    },
    closed,
  ),
  Type.Object(
    {
      kind: Type.Literal('file.edit'),
      path,
      oldText: Type.String({ minLength: 1, maxLength: 262144 }),
      newText: Type.String({ maxLength: 262144 }),
      expectedSha256: hash,
    },
    closed,
  ),
  Type.Object(
    {
      kind: Type.Literal('process.exec'),
      command: Type.String({ minLength: 1, maxLength: 65536 }),
      cwd: path,
      timeoutMs: Type.Integer({ minimum: 1, maximum: 3600000 }),
    },
    closed,
  ),
  Type.Object({ kind: Type.Literal('process.status'), ...job }, closed),
  Type.Object(
    { kind: Type.Literal('process.stop'), ...job, scope: literalUnion(['leader', 'process-tree']) },
    closed,
  ),
  Type.Object(
    {
      kind: Type.Literal('process.logs'),
      ...job,
      stream: literalUnion(['stdout', 'stderr']),
      offsetBytes: integer,
      limitBytes: Type.Integer({ minimum: 1, maximum: 262144 }),
    },
    closed,
  ),
])
export type AgentRemoteCommand = Static<typeof CommandSchema>
export const RequestSchema = Type.Object(
  {
    protocolVersion: Type.Literal(AGENT_REMOTE_VERSION),
    binding: BindingSchema,
    operationId: id,
    payloadHash: hash,
    lease: LeaseSchema,
    deadlineAtMs: positive,
    command: CommandSchema,
  },
  closed,
)
export type AgentRemoteRequest = Static<typeof RequestSchema>
export const JobRefSchema = Type.Object({ jobId: id, sourceOperationId: id }, closed)
export type AgentRemoteJobRef = Static<typeof JobRefSchema>
export const ResultSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('file.read'),
      path,
      offsetBytes: integer,
      nextOffsetBytes: integer,
      totalBytes: integer,
      eof: Type.Boolean(),
      contentUtf8: Type.String({ maxLength: 262144 }),
      contentSha256: hash,
      fileSha256: hash,
    },
    closed,
  ),
  Type.Object(
    { kind: Type.Literal('file.write'), path, totalBytes: integer, sha256: hash },
    closed,
  ),
  Type.Object(
    {
      kind: Type.Literal('file.edit'),
      path,
      totalBytes: integer,
      sha256: hash,
      previousSha256: hash,
      replacements: Type.Literal(1),
    },
    closed,
  ),
  Type.Object(
    {
      kind: Type.Literal('process.status'),
      job: JobRefSchema,
      state: literalUnion(['running', 'completed', 'failed', 'cancelled', 'unknown']),
      exitCode: Type.Optional(Type.Integer({ minimum: -2147483648, maximum: 2147483647 })),
    },
    closed,
  ),
  Type.Object(
    {
      kind: Type.Literal('process.logs'),
      job: JobRefSchema,
      stream: literalUnion(['stdout', 'stderr']),
      offsetBytes: integer,
      nextOffsetBytes: integer,
      eof: Type.Boolean(),
      text: Type.String({ maxLength: 262144 }),
    },
    closed,
  ),
  Type.Object(
    {
      kind: Type.Literal('process.stop'),
      job: JobRefSchema,
      stopScope: literalUnion(['leader', 'process-tree']),
    },
    closed,
  ),
])
export type AgentRemoteResult = Static<typeof ResultSchema>
export const ReceiptSchema = Type.Union([
  Type.Object(
    {
      status: Type.Literal('completed'),
      exitCode: Type.Optional(Type.Integer({ minimum: -2147483648, maximum: 2147483647 })),
      result: Type.Optional(ResultSchema),
    },
    closed,
  ),
  Type.Object({ status: Type.Literal('failed'), code: id }, closed),
  Type.Object(
    {
      status: Type.Literal('cancelled'),
      stopScope: literalUnion(['not-started', 'leader', 'process-tree']),
    },
    closed,
  ),
])
export type AgentRemoteReceipt = Static<typeof ReceiptSchema>
export const EventBodySchema = Type.Union([
  Type.Object({ type: Type.Literal('started'), job: Type.Optional(JobRefSchema) }, closed),
  Type.Object(
    {
      type: Type.Literal('output'),
      stream: literalUnion(['stdout', 'stderr']),
      offsetBytes: integer,
      text: Type.String({ maxLength: 65536 }),
    },
    closed,
  ),
  Type.Object({ type: Type.Literal('receipt'), receipt: ReceiptSchema }, closed),
])
export const EventSchema = Type.Object(
  {
    protocolVersion: Type.Literal(AGENT_REMOTE_VERSION),
    binding: BindingSchema,
    operationId: id,
    payloadHash: hash,
    lease: LeaseSchema,
    sequence: positive,
    body: EventBodySchema,
  },
  closed,
)
export type AgentRemoteEvent = Static<typeof EventSchema>
export type AgentRemoteOperationState =
  | 'accepted'
  | 'dispatched'
  | 'started'
  | 'unknown'
  | 'completed'
  | 'failed'
  | 'cancelled'

export class AgentRemoteError extends Error {
  constructor(public readonly code: string) {
    super(code)
    this.name = 'AgentRemoteError'
  }
}
export function requireRemote(condition: unknown, code: string): asserts condition {
  if (!condition) throw new AgentRemoteError(code)
}
export function validateRemote<T>(
  schema: Parameters<typeof Value.Check>[0],
  value: unknown,
): asserts value is T {
  requireRemote(Value.Check(schema, value), 'bad-shape')
}
export function remoteCanonical(value: unknown): string {
  return canonicalizePayload(value as JsonValue)
}
/** Epoch/owner are transport claims, excluded so a retry cannot create new work. */
export function agentRemoteContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}
export function agentRemotePayloadHash(
  request: Omit<AgentRemoteRequest, 'payloadHash' | 'lease'>,
): string {
  return createHash('sha256')
    .update('agent-remote-operation-v1\n')
    .update(remoteCanonical(request))
    .digest('hex')
}
export function verifyRemoteRequest(value: unknown): asserts value is AgentRemoteRequest {
  validateRemote<AgentRemoteRequest>(RequestSchema, value)
  const { payloadHash, lease: _lease, ...semantic } = value
  requireRemote(payloadHash === agentRemotePayloadHash(semantic), 'payload-hash-mismatch')
}
export function requiredRemoteCapabilities(command: AgentRemoteCommand): AgentRemoteCapability[] {
  const capabilities: AgentRemoteCapability[] = [command.kind]
  if (
    command.kind === 'file.edit' ||
    (command.kind === 'file.write' && command.expectedSha256 !== undefined)
  )
    capabilities.push('file.cas')
  if (command.kind === 'process.stop' && command.scope === 'process-tree')
    capabilities.push('process.stop-tree')
  return capabilities
}
/** Stable across epoch/owner; bindingRevision is checked via semantic hash instead. */
export function agentRemoteOperationKey(binding: AgentRemoteBinding, operationId: string): string {
  return remoteCanonical([
    binding.principalId,
    binding.sessionId,
    binding.environmentId,
    binding.environmentGeneration,
    operationId,
  ])
}
export function remoteTerminal(state: AgentRemoteOperationState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled'
}
