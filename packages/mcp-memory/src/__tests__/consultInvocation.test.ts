import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  CCB_TOOL_USE_META_KEY,
  resolveConsultInvocationId,
} from '../consultInvocation.js'

describe('resolveConsultInvocationId', () => {
  it('uses CCB _meta toolUseId and ignores JSON-RPC request id', () => {
    const got = resolveConsultInvocationId({
      mcpMeta: { [CCB_TOOL_USE_META_KEY]: 'toolu_same_call' },
      jsonRpcId: 17,
    })
    assert.equal(got.ok, true)
    if (!got.ok) return
    assert.equal(got.invocationId, 'toolu_same_call')
    assert.equal(got.source, 'mcp-meta')
  })

  it('does not treat JSON-RPC id as a retry identity when _meta is missing', () => {
    const got = resolveConsultInvocationId({ jsonRpcId: 'rpc-99' })
    assert.equal(got.ok, false)
    if (got.ok) return
    assert.match(got.error, /JSON-RPC request id is not a retry identity/)
  })

  it('prefers an already-forwarded header over _meta (HTTP hop retry)', () => {
    const got = resolveConsultInvocationId({
      header: 'toolu_same_call',
      mcpMeta: { [CCB_TOOL_USE_META_KEY]: 'toolu_other' },
      jsonRpcId: 1,
    })
    assert.equal(got.ok, true)
    if (!got.ok) return
    assert.equal(got.invocationId, 'toolu_same_call')
    assert.equal(got.source, 'header')
  })

  it('accepts per-call env for CLI engines that inject the tool_use id', () => {
    const got = resolveConsultInvocationId({
      env: { OPENCLAUDE_CONSULT_INVOCATION: 'call_cursor_shell_1' },
    })
    assert.equal(got.ok, true)
    if (!got.ok) return
    assert.equal(got.source, 'env')
    assert.equal(got.invocationId, 'call_cursor_shell_1')
  })

  it('never mints a random cinv- id', () => {
    const first = resolveConsultInvocationId({})
    const second = resolveConsultInvocationId({})
    assert.equal(first.ok, false)
    assert.equal(second.ok, false)
  })
})
