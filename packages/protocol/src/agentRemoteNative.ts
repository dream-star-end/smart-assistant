/** Native RPC is a distinct protocol; it is never an opaque process.exec command.
 * Claims below must be checked against trusted connection/fence state by the host.
 */
import { type Static, Type } from '@sinclair/typebox'
import {
  BindingSchema,
  LeaseSchema,
  agentRemoteContentHash,
  remoteCanonical,
  requireRemote,
  validateRemote,
} from './agentRemote.js'
import { nativeToolArtifactPathAllowed } from './agentRemoteState.js'
const closed = { additionalProperties: false }
const id = Type.String({ minLength: 1, maxLength: 160, pattern: '^[A-Za-z0-9_.:-]+$' })
const integer = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })
const digest = Type.String({ pattern: '^[a-f0-9]{64}$' })
const nativeId = Type.String({
  pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',
})
const path = Type.String({ minLength: 1, maxLength: 4096, pattern: '^/[^\\u0000]*$' })
const json = Type.Unknown() // verifyNativeFrame checks bounded plain JSON, including nested values.
const object = Type.Record(Type.String(), json)
const owner = Type.Union([Type.Literal('worker'), Type.Literal('execution')])
export const NATIVE_FRAME_MAX_BYTES = 8 * 1024 * 1024
export const NativeScopeSchema = Type.Object(
  {
    binding: BindingSchema,
    nativeSessionId: nativeId,
    environmentIncarnation: id,
    lease: LeaseSchema,
    connectionId: id,
    challenge: digest,
  },
  closed,
)
export type NativeScope = Static<typeof NativeScopeSchema>
export const NativeToolUseSchema = Type.Object(
  {
    // Provider IDs include opaque Google replay signatures; only the complete
    // frame budget bounds their size. Never hash or truncate replay identity.
    id: Type.String({ minLength: 1, maxLength: NATIVE_FRAME_MAX_BYTES }),
    name: Type.String({ minLength: 1, maxLength: 256 }),
    input: object,
  },
  closed,
)
export const NativeTaskRefSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal('shell'),
      Type.Literal('agent'),
      Type.Literal('browser'),
      Type.Literal('mcp'),
    ]),
    owner,
    binding: BindingSchema,
    nativeSessionId: nativeId,
    taskId: id,
    sourceOperationId: id,
  },
  closed,
)
export const NativeArtifactSchema = Type.Object(
  {
    nativeSessionId: nativeId,
    relativePath: Type.String({ minLength: 1, maxLength: 4096 }),
    sizeBytes: integer,
    sha256: digest,
  },
  closed,
)
export type NativeArtifact = Static<typeof NativeArtifactSchema>
export const NativeToolDescriptorSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 256 }),
    aliases: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 32 }),
    owner: Type.Union([owner, Type.Literal('task-ref')]),
    description: Type.String({ maxLength: 131072 }),
    inputSchema: object,
    revision: digest,
  },
  closed,
)
export type NativeToolDescriptor = Static<typeof NativeToolDescriptorSchema>
export const NativeStatePatchSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal('cwd.changed'), expectedRevision: integer, revision: positive, cwd: path },
    closed,
  ),
  Type.Object(
    {
      kind: Type.Literal('permission.rules.patch'),
      expectedRevision: integer,
      revision: positive,
      source: id,
      allow: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 1000 }),
      deny: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 1000 }),
      ask: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 1000 }),
    },
    closed,
  ),
  Type.Object(
    {
      kind: Type.Literal('task.updated'),
      expectedRevision: integer,
      revision: positive,
      task: NativeTaskRefSchema,
      state: Type.Union(
        (['running', 'completed', 'failed', 'cancelled', 'unknown'] as const).map((value) =>
          Type.Literal(value),
        ),
      ),
      stdoutCursorBytes: integer,
      stderrCursorBytes: integer,
    },
    closed,
  ),
])
const occurrence = Type.Object(
  { parentOperationId: id, hookConfigRevision: digest, index: integer, hookId: id },
  closed,
)
export const NativeCallbackSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('permission'),
      callbackId: id,
      toolUse: NativeToolUseSchema,
      policyRevision: integer,
    },
    closed,
  ),
  Type.Object(
    {
      kind: Type.Literal('hook.model'),
      callbackId: id,
      occurrence,
      hookKind: Type.Union([Type.Literal('prompt'), Type.Literal('agent')]),
      input: object,
      policyRevision: integer,
    },
    closed,
  ),
  Type.Object(
    {
      kind: Type.Literal('aux.model'),
      callbackId: id,
      purpose: Type.String({ minLength: 1, maxLength: 160 }),
      model: id,
      request: object,
    },
    closed,
  ),
  Type.Object(
    {
      kind: Type.Literal('native.resource.read'),
      callbackId: id,
      nativeSessionId: nativeId,
      committedHead: id,
      resource: Type.Literal('transcript'),
      offsetBytes: integer,
      limitBytes: Type.Integer({ minimum: 1, maximum: 262144 }),
    },
    closed,
  ),
  Type.Object(
    { kind: Type.Literal('elicitation'), callbackId: id, serverName: id, request: object },
    closed,
  ),
])
const callbackResultBase = {
  kind: Type.Literal('native.callback.result'),
  callbackId: id,
  requestHash: digest,
}
const completedCallback = { ...callbackResultBase, outcome: Type.Literal('completed') }
const hookDisposition = Type.Object(
  {
    disposition: Type.Union(
      (['allow', 'deny', 'ask', 'modify'] as const).map((value) => Type.Literal(value)),
    ),
    policyRevision: integer,
    updatedInput: Type.Optional(object),
    reason: Type.Optional(Type.String({ maxLength: 65536 })),
  },
  closed,
)
export const NativeCallbackResultSchema = Type.Union([
  Type.Object(
    {
      ...completedCallback,
      callbackKind: Type.Literal('permission'),
      result: Type.Object(
        {
          decision: Type.Union([Type.Literal('allow'), Type.Literal('deny'), Type.Literal('ask')]),
          policyRevision: integer,
          updatedInput: Type.Optional(object),
        },
        closed,
      ),
    },
    closed,
  ),
  Type.Object(
    { ...completedCallback, callbackKind: Type.Literal('hook.model'), result: hookDisposition },
    closed,
  ),
  Type.Object(
    {
      ...completedCallback,
      callbackKind: Type.Literal('aux.model'),
      result: Type.Object({ response: object }, closed),
    },
    closed,
  ),
  Type.Object(
    {
      ...completedCallback,
      callbackKind: Type.Literal('native.resource.read'),
      result: Type.Object(
        {
          contentUtf8: Type.String({ maxLength: 262144 }),
          offsetBytes: integer,
          nextOffsetBytes: integer,
          totalBytes: integer,
          eof: Type.Boolean(),
          sha256: digest,
        },
        closed,
      ),
    },
    closed,
  ),
  Type.Object(
    {
      ...completedCallback,
      callbackKind: Type.Literal('elicitation'),
      result: Type.Object(
        {
          action: Type.Union([
            Type.Literal('accept'),
            Type.Literal('decline'),
            Type.Literal('cancel'),
          ]),
          content: Type.Optional(object),
        },
        closed,
      ),
    },
    closed,
  ),
  Type.Object(
    {
      ...callbackResultBase,
      callbackKind: Type.Union(
        (
          ['permission', 'hook.model', 'aux.model', 'native.resource.read', 'elicitation'] as const
        ).map((value) => Type.Literal(value)),
      ),
      outcome: Type.Union([
        Type.Literal('denied'),
        Type.Literal('failed'),
        Type.Literal('unknown'),
      ]),
      result: Type.Object(
        { code: id, message: Type.Optional(Type.String({ maxLength: 65536 })) },
        closed,
      ),
    },
    closed,
  ),
])
export const NativeExecutionBodySchema = Type.Object(
  {
    kind: Type.Literal('native.execute'),
    payloadHash: digest,
    contextRevision: positive,
    manifestRevision: digest,
    deadlineAtMs: positive,
    toolUse: NativeToolUseSchema,
    assistantMessage: object,
  },
  closed,
)
export const NativeDeliveryAckSchema = Type.Object(
  {
    kind: Type.Literal('native.delivery.ack'),
    receiptHash: digest,
    nativeHeadRevision: id,
    nativeHeadHash: digest,
    artifactManifestHash: digest,
  },
  closed,
)
export const NativeReceiptBodySchema = Type.Object(
  {
    kind: Type.Literal('native.receipt'),
    payloadHash: digest,
    status: Type.Union(
      (['completed', 'failed', 'cancelled', 'unknown'] as const).map((value) =>
        Type.Literal(value),
      ),
    ),
    message: Type.Optional(object),
    code: Type.Optional(id),
  },
  closed,
)
export const NativeBodySchema = Type.Union([
  Type.Object({ kind: Type.Literal('runtime.bootstrap'), contextRevision: integer }, closed),
  Type.Object({ kind: Type.Literal('runtime.refresh'), expectedRevision: integer }, closed),
  Type.Object(
    {
      kind: Type.Literal('native.manifest'),
      contextRevision: positive,
      manifestRevision: digest,
      tools: Type.Array(NativeToolDescriptorSchema, { maxItems: 4096 }),
      logicalCwd: path,
      context: Type.Object(
        {
          git: Type.String({ maxLength: 1048576 }),
          rules: Type.String({ maxLength: 2097152 }),
          skills: Type.Array(
            Type.Object(
              { name: id, logicalPath: path, content: Type.String({ maxLength: 1048576 }) },
              closed,
            ),
            { maxItems: 1024 },
          ),
          mcpInstructions: Type.Array(Type.String({ maxLength: 1048576 }), { maxItems: 1024 }),
        },
        closed,
      ),
    },
    closed,
  ),
  NativeExecutionBodySchema,
  Type.Object({ kind: Type.Literal('native.query'), payloadHash: digest }, closed),
  Type.Object({ kind: Type.Literal('native.cancel'), payloadHash: digest }, closed),
  Type.Object({ kind: Type.Literal('native.progress'), message: object }, closed),
  Type.Object({ kind: Type.Literal('native.patch'), patch: NativeStatePatchSchema }, closed),
  Type.Object(
    {
      kind: Type.Literal('native.artifacts'),
      artifacts: Type.Array(NativeArtifactSchema, { maxItems: 2048 }),
    },
    closed,
  ),
  Type.Object(
    { kind: Type.Literal('native.callback'), callbackHash: digest, callback: NativeCallbackSchema },
    closed,
  ),
  NativeCallbackResultSchema,
  NativeDeliveryAckSchema,
  NativeReceiptBodySchema,
])
export const NativeFrameSchema = Type.Object(
  {
    nativeProtocolVersion: Type.Literal(1),
    scope: NativeScopeSchema,
    sender: owner,
    operationId: id,
    sequence: positive,
    body: NativeBodySchema,
  },
  closed,
)
export type NativeFrame = Static<typeof NativeFrameSchema>
export type NativeExecutionBody = Extract<NativeFrame['body'], { kind: 'native.execute' }>

function boundedJson(value: unknown, depth = 0, budget = { nodes: 0 }): void {
  requireRemote(depth <= 64 && ++budget.nodes <= 250000, 'native-json-bound')
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return
  if (typeof value === 'number') {
    requireRemote(Number.isFinite(value), 'native-json-number')
    return
  }
  requireRemote(typeof value === 'object', 'native-json-value')
  if (Array.isArray(value)) {
    requireRemote(
      Object.getPrototypeOf(value) === Array.prototype &&
        Object.getOwnPropertySymbols(value).length === 0,
      'native-json-array',
    )
    const properties = Object.getOwnPropertyDescriptors(value)
    requireRemote(Object.keys(properties).length === value.length + 1, 'native-json-array')
    for (let index = 0; index < value.length; index++) {
      const descriptor = properties[String(index)]
      requireRemote(
        descriptor && !descriptor.get && !descriptor.set && descriptor.enumerable,
        'native-json-array',
      )
      boundedJson(descriptor.value, depth + 1, budget)
    }
    return
  }
  requireRemote(
    Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null,
    'native-json-object',
  )
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    requireRemote(
      !descriptor.get && !descriptor.set && descriptor.enumerable,
      'native-json-property',
    )
    boundedJson(descriptor.value, depth + 1, budget)
  }
  requireRemote(Object.getOwnPropertySymbols(value).length === 0, 'native-json-symbol')
}
export function nativeExecutionHash(
  scope: Pick<NativeScope, 'binding' | 'nativeSessionId' | 'environmentIncarnation'>,
  operationId: string,
  body: Omit<NativeExecutionBody, 'payloadHash'>,
): string {
  // Transport epoch/challenge change on reconnect. Business request semantics do not.
  return agentRemoteContentHash(
    `agent-remote-native-execute-v1\n${remoteCanonical({
      binding: scope.binding,
      nativeSessionId: scope.nativeSessionId,
      environmentIncarnation: scope.environmentIncarnation,
      operationId,
      ...body,
    })}`,
  )
}
export function nativeCallbackHash(
  scope: Pick<NativeScope, 'binding' | 'nativeSessionId' | 'environmentIncarnation'>,
  operationId: string,
  callback: Static<typeof NativeCallbackSchema>,
): string {
  return agentRemoteContentHash(
    `agent-remote-native-callback-v1\n${remoteCanonical({
      binding: scope.binding,
      nativeSessionId: scope.nativeSessionId,
      environmentIncarnation: scope.environmentIncarnation,
      operationId,
      callback,
    })}`,
  )
}
export function nativeManifestHash(
  body: Omit<Extract<NativeFrame['body'], { kind: 'native.manifest' }>, 'manifestRevision'>,
): string {
  return agentRemoteContentHash(`agent-remote-native-manifest-v1\n${remoteCanonical(body)}`)
}
export function nativeOperationKey(
  scope: Pick<NativeScope, 'binding' | 'nativeSessionId'>,
  operationId: string,
): string {
  return remoteCanonical([
    'native-v1',
    scope.binding.principalId,
    scope.binding.sessionId,
    scope.nativeSessionId,
    scope.binding.environmentId,
    scope.binding.environmentGeneration,
    operationId,
  ])
}
export function verifyNativeJson(value: unknown): void {
  boundedJson(value)
  requireRemote(
    Buffer.byteLength(remoteCanonical(value), 'utf8') <= NATIVE_FRAME_MAX_BYTES,
    'native-frame-size',
  )
}
export function verifyNativeFrame(
  value: unknown,
  expected: NativeScope,
  expectedSender: 'worker' | 'execution',
): asserts value is NativeFrame {
  boundedJson(value)
  const encoded = remoteCanonical(value)
  requireRemote(Buffer.byteLength(encoded, 'utf8') <= NATIVE_FRAME_MAX_BYTES, 'native-frame-size')
  validateRemote<NativeFrame>(NativeFrameSchema, value)
  validateRemote<NativeScope>(NativeScopeSchema, expected)
  requireRemote(remoteCanonical(value.scope) === remoteCanonical(expected), 'native-scope-mismatch')
  requireRemote(value.sender === expectedSender, 'native-peer-role')
  requireRemote(
    value.scope.lease.ownerInstanceId === value.scope.binding.workerInstanceId,
    'native-owner-instance',
  )
  verifyNativeBodySemantics(value.scope, value.operationId, value.sender, value.body)
}
/** Shared wire/replay semantics. Connection authentication remains the caller's job. */
export function verifyNativeBodySemantics(
  scope: Pick<NativeScope, 'binding' | 'nativeSessionId' | 'environmentIncarnation'>,
  operationId: string,
  sender: 'worker' | 'execution',
  body: NativeFrame['body'],
): void {
  const workerKinds = new Set([
    'runtime.bootstrap',
    'runtime.refresh',
    'native.execute',
    'native.delivery.ack',
    'native.query',
    'native.cancel',
    'native.callback.result',
  ])
  const executionKinds = new Set([
    'native.manifest',
    'native.progress',
    'native.artifacts',
    'native.callback',
    'native.receipt',
  ])
  requireRemote(
    !(workerKinds.has(body.kind) && sender !== 'worker') &&
      !(executionKinds.has(body.kind) && sender !== 'execution'),
    'native-direction',
  )
  if (body.kind === 'native.patch') {
    const patch = body.patch
    const expectedSender =
      patch.kind === 'permission.rules.patch'
        ? 'worker'
        : patch.kind === 'task.updated'
          ? patch.task.owner
          : 'execution'
    requireRemote(sender === expectedSender, 'native-direction')
  }
  if (body.kind === 'native.execute') {
    const { payloadHash, ...semantic } = body
    requireRemote(
      payloadHash === nativeExecutionHash(scope, operationId, semantic),
      'native-payload-hash',
    )
  }
  if (body.kind === 'native.patch')
    requireRemote(body.patch.revision === body.patch.expectedRevision + 1, 'native-patch-revision')
  if (body.kind === 'native.callback.result' && body.outcome === 'completed') {
    if (body.callbackKind === 'native.resource.read') {
      const result = body.result
      const bytes = Buffer.byteLength(result.contentUtf8, 'utf8')
      requireRemote(
        bytes <= 262144 &&
          result.nextOffsetBytes === result.offsetBytes + bytes &&
          result.nextOffsetBytes <= result.totalBytes &&
          result.eof === (result.nextOffsetBytes === result.totalBytes) &&
          (result.eof || bytes > 0),
        'native-resource-cursor',
      )
      requireRemote(
        result.sha256 === agentRemoteContentHash(result.contentUtf8),
        'native-resource-hash',
      )
    }
    if (body.callbackKind === 'hook.model' && body.result.disposition === 'modify')
      requireRemote(body.result.updatedInput !== undefined, 'native-hook-input')
  }
  if (body.kind === 'native.manifest') {
    const names = new Set<string>()
    for (const tool of body.tools) {
      for (const name of [tool.name, ...tool.aliases]) {
        requireRemote(!names.has(name), 'native-manifest-duplicate')
        names.add(name)
      }
      const { revision, ...semantic } = tool
      requireRemote(
        revision ===
          agentRemoteContentHash(`agent-remote-native-tool-v1\n${remoteCanonical(semantic)}`),
        'native-tool-revision',
      )
    }
    const { manifestRevision, ...semantic } = body
    requireRemote(manifestRevision === nativeManifestHash(semantic), 'native-manifest-revision')
  }
  if (body.kind === 'native.patch' && body.patch.kind === 'task.updated') {
    const task = body.patch.task
    requireRemote(
      remoteCanonical(task.binding) === remoteCanonical(scope.binding) &&
        task.nativeSessionId === scope.nativeSessionId,
      'native-task-scope',
    )
    requireRemote(
      task.owner === (task.kind === 'agent' ? 'worker' : 'execution'),
      'native-task-owner',
    )
  }
  if (body.kind === 'native.callback') {
    const callback = body.callback
    requireRemote(
      body.callbackHash === nativeCallbackHash(scope, operationId, callback),
      'native-callback-hash',
    )
    if (callback.kind === 'hook.model')
      requireRemote(callback.occurrence.parentOperationId === operationId, 'native-hook-scope')
    if (callback.kind === 'native.resource.read')
      requireRemote(callback.nativeSessionId === scope.nativeSessionId, 'native-resource-scope')
  }
  if (body.kind === 'native.artifacts') {
    const names = new Set<string>()
    for (const artifact of body.artifacts) {
      requireRemote(artifact.nativeSessionId === scope.nativeSessionId, 'native-artifact-session')
      requireRemote(!names.has(artifact.relativePath), 'native-artifact-duplicate')
      names.add(artifact.relativePath)
      requireRemote(nativeToolArtifactPathAllowed(artifact.relativePath), 'native-artifact-path')
    }
  }
}
