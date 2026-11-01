import assert from 'node:assert/strict'
import test from 'node:test'
import { agentRemoteContentHash, remoteCanonical } from './agentRemote.js'
import {
  type NativeFrame,
  type NativeScope,
  nativeCallbackHash,
  nativeExecutionHash,
  nativeManifestHash,
  nativeOperationKey,
  verifyNativeFrame,
} from './agentRemoteNative.js'
function verify(value: unknown, expected: NativeScope, peer: 'worker' | 'execution' = 'execution') {
  return verifyNativeFrame(value, expected, peer)
}
const scope: NativeScope = {
  binding: {
    principalId: 'u1',
    sessionId: 's1',
    bindingRevision: 1,
    workerId: 'w1',
    workerInstanceId: 'wi1',
    environmentId: 'e1',
    environmentGeneration: 1,
  },
  nativeSessionId: '00000000-0000-4000-8000-000000000001',
  environmentIncarnation: 'boot1',
  lease: { ownerInstanceId: 'wi1', epoch: 1 },
  connectionId: 'connection1',
  challenge: 'a'.repeat(64),
}
function execute(): NativeFrame {
  const body = {
    kind: 'native.execute' as const,
    contextRevision: 1,
    manifestRevision: 'b'.repeat(64),
    deadlineAtMs: 10000,
    toolUse: { id: 'use1', name: 'Read', input: { file_path: '/workspace/a' } },
    assistantMessage: { type: 'assistant', message: { role: 'assistant', content: [] } },
  }
  return {
    nativeProtocolVersion: 1,
    scope: structuredClone(scope),
    sender: 'worker',
    operationId: 'op1',
    sequence: 1,
    body: { ...body, payloadHash: nativeExecutionHash(scope, 'op1', body) },
  }
}
function frame(
  body: NativeFrame['body'],
  sender: NativeFrame['sender'] = 'execution',
): NativeFrame {
  if (body.kind === 'native.callback')
    body = { ...body, callbackHash: nativeCallbackHash(scope, 'op1', body.callback) }
  return {
    nativeProtocolVersion: 1,
    scope: structuredClone(scope),
    sender,
    operationId: 'op1',
    sequence: 1,
    body,
  }
}

test('native execution uses a distinct scoped protocol and immutable semantic hash', () => {
  const request = execute()
  verify(request, scope, 'worker')
  const changed = structuredClone(request)
  assert.equal(changed.body.kind, 'native.execute')
  if (changed.body.kind !== 'native.execute') throw new Error('fixture')
  changed.body.toolUse.input.file_path = '/workspace/other'
  assert.throws(() => verify(changed, scope, 'worker'), /native-payload-hash/)
  assert.throws(() => verify({ ...request, nativeProtocolVersion: 2 }, scope), /bad-shape/)
  assert.throws(() => verify({ ...request, providerKey: 'synthetic' }, scope), /bad-shape/)
})
test('cross-user, environment incarnation/generation, worker, connection and epoch claims reject', () => {
  const request = execute()
  for (const mutate of [
    (s: NativeScope) => {
      s.binding.principalId = 'u2'
    },
    (s: NativeScope) => {
      s.binding.sessionId = 's2'
    },
    (s: NativeScope) => {
      s.binding.environmentGeneration++
    },
    (s: NativeScope) => {
      s.environmentIncarnation = 'boot2'
    },
    (s: NativeScope) => {
      s.binding.workerInstanceId = 'wi2'
    },
    (s: NativeScope) => {
      s.binding.bindingRevision++
    },
    (s: NativeScope) => {
      s.lease.epoch++
    },
    (s: NativeScope) => {
      s.connectionId = 'connection2'
    },
    (s: NativeScope) => {
      s.challenge = 'b'.repeat(64)
    },
  ]) {
    const forged = structuredClone(request)
    mutate(forged.scope)
    assert.throws(() => verify(forged, scope, 'worker'), /native-scope-mismatch/)
  }
  const inconsistent = structuredClone(scope)
  inconsistent.lease.ownerInstanceId = 'wi2'
  assert.throws(
    () => verify({ ...request, scope: inconsistent }, inconsistent, 'worker'),
    /native-owner-instance/,
  )
})
test('transport reconnect changes neither operation key nor input hash; old challenge still rejects', () => {
  const request = execute()
  if (request.body.kind !== 'native.execute') throw new Error('fixture')
  const next = structuredClone(scope)
  next.connectionId = 'reconnected'
  next.challenge = 'c'.repeat(64)
  next.lease.epoch++
  const { payloadHash, ...semantic } = request.body
  assert.equal(nativeExecutionHash(next, 'op1', semantic), payloadHash)
  assert.equal(nativeOperationKey(next, 'op1'), nativeOperationKey(scope, 'op1'))
  assert.throws(() => verify(request, next), /native-scope-mismatch/)
  verify({ ...request, scope: next }, next, 'worker')
})
test('functions, lazy context modifiers, getters, sparse arrays and oversized messages fail before serialization', () => {
  const request = frame({ kind: 'native.progress', message: { type: 'progress' } })
  const message = (request.body as { message: Record<string, unknown> }).message
  message.contextModifier = {
    modifyContext: () => {
      throw new Error('must never execute')
    },
  }
  assert.throws(() => verify(request, scope, 'worker'), /native-json-value/)
  message.contextModifier = null
  Object.defineProperty(message, 'trap', {
    enumerable: true,
    get() {
      throw new Error('getter executed')
    },
  })
  assert.throws(() => verify(request, scope, 'worker'), /native-json-property/)
  assert.throws(
    () => verify(frame({ kind: 'native.progress', message: { data: new Array(1) } }), scope),
    /native-json-array/,
  )
  const array: unknown[] = []
  Object.defineProperty(array, Symbol.iterator, {
    value: () => {
      throw new Error('iterator executed')
    },
  })
  assert.throws(
    () => verify(frame({ kind: 'native.progress', message: { array } }), scope),
    /native-json-array/,
  )
  assert.throws(
    () =>
      verify(
        frame({ kind: 'native.progress', message: { data: 'x'.repeat(9 * 1024 * 1024) } }),
        scope,
      ),
    /native-frame-size/,
  )
})
test('typed task ownership and policy revisions preserve shell versus agent boundaries', () => {
  const task = {
    kind: 'shell' as const,
    owner: 'execution' as const,
    binding: scope.binding,
    nativeSessionId: scope.nativeSessionId,
    taskId: 'task1',
    sourceOperationId: 'op1',
  }
  const patch = {
    kind: 'task.updated' as const,
    expectedRevision: 1,
    revision: 2,
    task,
    state: 'running' as const,
    stdoutCursorBytes: 0,
    stderrCursorBytes: 0,
  }
  verify(frame({ kind: 'native.patch', patch }), scope)
  assert.throws(
    () => verify(frame({ kind: 'native.patch', patch: { ...patch, revision: 4 } }), scope),
    /native-patch-revision/,
  )
  assert.throws(
    () =>
      verify(
        frame(
          { kind: 'native.patch', patch: { ...patch, task: { ...task, owner: 'worker' } } },
          'worker',
        ),
        scope,
        'worker',
      ),
    /native-task-owner/,
  )
  assert.throws(
    () =>
      verify(
        frame({
          kind: 'native.patch',
          patch: { ...patch, task: { ...task, binding: { ...scope.binding, sessionId: 'other' } } },
        }),
        scope,
      ),
    /native-task-scope/,
  )
})
test('hook occurrences and native transcript callbacks cannot refer to another operation/session', () => {
  const callback = {
    kind: 'hook.model' as const,
    callbackId: 'cb1',
    occurrence: {
      parentOperationId: 'op1',
      hookConfigRevision: 'd'.repeat(64),
      index: 0,
      hookId: 'hook1',
    },
    hookKind: 'agent' as const,
    input: {},
    policyRevision: 1,
  }
  verify(frame({ kind: 'native.callback', callbackHash: '0'.repeat(64), callback }), scope)
  assert.throws(
    () =>
      verify(
        frame({
          kind: 'native.callback',
          callbackHash: '0'.repeat(64),
          callback: {
            ...callback,
            occurrence: { ...callback.occurrence, parentOperationId: 'other' },
          },
        }),
        scope,
      ),
    /native-hook-scope/,
  )
  const resource = {
    kind: 'native.resource.read' as const,
    callbackId: 'read1',
    nativeSessionId: scope.nativeSessionId,
    committedHead: 'head1',
    resource: 'transcript' as const,
    offsetBytes: 0,
    limitBytes: 100,
  }
  verify(
    frame({ kind: 'native.callback', callbackHash: '0'.repeat(64), callback: resource }),
    scope,
  )
  assert.throws(
    () =>
      verify(
        frame({
          kind: 'native.callback',
          callbackHash: '0'.repeat(64),
          callback: { ...resource, nativeSessionId: '00000000-0000-4000-8000-000000000002' },
        }),
        scope,
      ),
    /native-resource-scope/,
  )
})
test('artifact references are session scoped, relative and unique', () => {
  const artifact = {
    nativeSessionId: scope.nativeSessionId,
    relativePath: 'tool-results/toolu_fixture.txt',
    sizeBytes: 10,
    sha256: 'a'.repeat(64),
  }
  verify(frame({ kind: 'native.artifacts', artifacts: [artifact] }), scope)
  assert.throws(
    () => verify(frame({ kind: 'native.artifacts', artifacts: [artifact, artifact] }), scope),
    /native-artifact-duplicate/,
  )
  for (const relativePath of [
    '/etc/passwd',
    'tool-results/../../credentials',
    'tool-results/.secret',
    'tool-results/a\\b',
  ])
    assert.throws(
      () =>
        verify(
          frame({ kind: 'native.artifacts', artifacts: [{ ...artifact, relativePath }] }),
          scope,
        ),
      /native-artifact-path/,
    )
})
test('manifest hashes and unambiguous alias ownership protect dispatcher selection', () => {
  const semantic = {
    name: 'Read',
    aliases: ['ReadFile'],
    owner: 'execution' as const,
    description: 'native Read',
    inputSchema: { type: 'object' },
  }
  const tool = {
    ...semantic,
    revision: agentRemoteContentHash(`agent-remote-native-tool-v1\n${remoteCanonical(semantic)}`),
  }
  const body = {
    kind: 'native.manifest' as const,
    contextRevision: 1,
    tools: [tool],
    logicalCwd: '/workspace',
    context: { git: '', rules: '', skills: [], mcpInstructions: [] },
  }
  const manifest = { ...body, manifestRevision: nativeManifestHash(body) }
  verify(frame(manifest), scope)
  const bad = { ...manifest, tools: [tool, { ...tool, name: 'Other' }] }
  assert.throws(() => verify(frame(bad), scope), /native-manifest-duplicate|native-tool-revision/)
  assert.throws(
    () => verify(frame({ ...manifest, logicalCwd: '/different' }), scope),
    /native-manifest-revision/,
  )
  assert.throws(() => verify({ ...execute(), sender: 'execution' }, scope), /native-direction/)
})

test('connection peer role cannot be forged by changing the sender field', () => {
  const receipt = frame({
    kind: 'native.receipt',
    payloadHash: 'a'.repeat(64),
    status: 'completed',
  })
  assert.throws(() => verify(receipt, scope, 'worker'), /native-peer-role/)
})
test('callback results require the kind-specific decision/cursor shape and request correlation hash', () => {
  const base = {
    kind: 'native.callback.result' as const,
    callbackId: 'cb1',
    requestHash: 'd'.repeat(64),
    outcome: 'completed' as const,
  }
  verify(
    frame(
      { ...base, callbackKind: 'permission', result: { decision: 'deny', policyRevision: 1 } },
      'worker',
    ),
    scope,
    'worker',
  )
  assert.throws(
    () =>
      verify(
        frame({ ...base, callbackKind: 'permission', result: {} } as never, 'worker'),
        scope,
        'worker',
      ),
    /bad-shape/,
  )
  const contentUtf8 = '中文🌏'
  const result = {
    contentUtf8,
    offsetBytes: 0,
    nextOffsetBytes: 10,
    totalBytes: 10,
    eof: true,
    sha256: agentRemoteContentHash(contentUtf8),
  }
  verify(
    frame({ ...base, callbackKind: 'native.resource.read', result }, 'worker'),
    scope,
    'worker',
  )
  assert.throws(
    () =>
      verify(
        frame(
          {
            ...base,
            callbackKind: 'native.resource.read',
            result: { ...result, nextOffsetBytes: 9 },
          },
          'worker',
        ),
        scope,
        'worker',
      ),
    /native-resource-cursor/,
  )
  assert.throws(
    () =>
      verify(
        frame(
          {
            ...base,
            callbackKind: 'hook.model',
            result: { disposition: 'modify', policyRevision: 1 },
          },
          'worker',
        ),
        scope,
        'worker',
      ),
    /native-hook-input/,
  )
})

test('non-EOF resource page must advance the UTF8 byte cursor', () => {
  const body = {
    kind: 'native.callback.result' as const,
    callbackId: 'cb1',
    requestHash: 'a'.repeat(64),
    callbackKind: 'native.resource.read' as const,
    outcome: 'completed' as const,
    result: {
      contentUtf8: '',
      offsetBytes: 0,
      nextOffsetBytes: 0,
      totalBytes: 10,
      eof: false,
      sha256: agentRemoteContentHash(''),
    },
  }
  assert.throws(() => verify(frame(body, 'worker'), scope, 'worker'), /native-resource-cursor/)
})
