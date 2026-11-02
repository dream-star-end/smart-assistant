import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CC5_INTERACTIVE_BACKEND,
  CC5_NATIVE_MODEL,
  assertCc5BackendBinding,
  cc5BackendIdentity,
  isCc5BackendAuthority,
  isCc5ExecutionBackend,
  parseCc5ExecutionBackend,
  sameCc5ExecutionBackend,
} from '../cc5Backend.js'

const scope = {
  kind: CC5_INTERACTIVE_BACKEND,
  sessionKey: 'agent:main:webchat:dm:new_chat_123',
  operationId: '11111111-1111-4111-8111-111111111111',
} as const

test('cc5 backend parses a closed, immutable scope for one normal web chat', () => {
  const parsed = parseCc5ExecutionBackend(scope)
  assert.deepEqual(parsed, scope)
  assert.notEqual(parsed, scope)
  assert.equal(Object.isFrozen(parsed), true)
  assert.equal(isCc5ExecutionBackend(scope), true)
})

test('invalid/unknown backend, ambiguous scope and auxiliary sessions are rejected', () => {
  const invalid: unknown[] = [null, undefined, [], '', 1, {},
    { ...scope, other: true }, { ...scope, kind: 'unknown-v1' },
    { ...scope, sessionKey: '' }, { ...scope, sessionKey: 'agent:main:main' },
    { ...scope, sessionKey: 'agent:main:cron:dm:new_chat_123' },
    { ...scope, sessionKey: 'agent:main:webchat:group:new_chat_123' },
    { ...scope, sessionKey: `${scope.sessionKey}\n` },
    { ...scope, sessionKey: `agent:main:webchat:dm:${'a'.repeat(51)}` },
    { ...scope, operationId: `${scope.operationId}\n` },
    { ...scope, operationId: 'not-a-uuid' },
  ]
  for (const value of invalid) {
    assert.equal(isCc5ExecutionBackend(value), false)
    assert.throws(() => parseCc5ExecutionBackend(value), /CC5_BACKEND_SCOPE_INVALID/)
  }
})

test('backend identity isolates local/remote, operation and session for the same model/engine', () => {
  assert.equal(sameCc5ExecutionBackend(undefined, undefined), true)
  assert.equal(sameCc5ExecutionBackend(scope, { ...scope }), true)
  assert.notEqual(cc5BackendIdentity(scope), cc5BackendIdentity(undefined))
  assert.equal(sameCc5ExecutionBackend(scope, undefined), false)
  assert.equal(sameCc5ExecutionBackend(scope, { ...scope, sessionKey: 'agent:main:webchat:dm:other_chat_123' }), false)
  assert.equal(sameCc5ExecutionBackend(scope, { ...scope, operationId: '22222222-2222-4222-8222-222222222222' }), false)
})

test('scope equality does not authorize another canonical model, engine, operation or session', () => {
  const authority = { engine: 'ccb', canonicalModel: CC5_NATIVE_MODEL, executionBackend: scope }
  const binding = {
    backendKind: CC5_INTERACTIVE_BACKEND, canonicalModel: CC5_NATIVE_MODEL,
    sessionKey: scope.sessionKey, operationId: scope.operationId,
  }
  assert.equal(isCc5BackendAuthority(authority), true)
  assert.doesNotThrow(() => assertCc5BackendBinding(authority, binding))
  for (const value of [
    { ...authority, canonicalModel: 'cc5-remote-t1555u' },
    { ...authority, canonicalModel: 'box-claude-opus-5' },
    { ...authority, engine: 'cursor' },
    { ...authority, executionBackend: undefined },
  ]) {
    assert.equal(isCc5BackendAuthority(value), false)
    assert.throws(() => assertCc5BackendBinding(value, binding), /CC5_BACKEND_BINDING_MISMATCH/)
  }
  assert.throws(() => assertCc5BackendBinding(authority, { ...binding,
    operationId: '22222222-2222-4222-8222-222222222222' }), /CC5_BACKEND_BINDING_MISMATCH/)
  assert.throws(() => assertCc5BackendBinding(authority, { ...binding,
    sessionKey: 'agent:main:webchat:dm:other_chat_123' }), /CC5_BACKEND_BINDING_MISMATCH/)
  assert.throws(() => assertCc5BackendBinding(authority, binding, 'agent:main:webchat:dm:other_chat_123'),
    /CC5_BACKEND_BINDING_MISMATCH/)
})
