import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  cursorDelegateCliHint,
  isCursorHiddenDelegateTool,
} from '../cursorDelegatePolicy.js'

describe('cursorDelegatePolicy', () => {
  it('hides sync delegate MCP tools only on cursor', () => {
    assert.equal(isCursorHiddenDelegateTool('delegate_task', 'cursor'), true)
    assert.equal(isCursorHiddenDelegateTool('delegate_tasks', 'cursor'), true)
    assert.equal(isCursorHiddenDelegateTool('request_review', 'cursor'), true)
    assert.equal(isCursorHiddenDelegateTool('send_to_agent', 'cursor'), false)
    assert.equal(isCursorHiddenDelegateTool('delegate_task', 'ccb'), false)
    assert.equal(isCursorHiddenDelegateTool('delegate_task', ''), false)
  })

  it('CLI hint names oc-memory delegate and forbids MCP', () => {
    assert.match(cursorDelegateCliHint('delegate_task'), /oc-memory delegate/)
    assert.match(cursorDelegateCliHint('delegate_task'), /不要再调 MCP/)
    assert.match(cursorDelegateCliHint('request_review'), /oc-memory request-review/)
    assert.match(cursorDelegateCliHint('delegate_tasks'), /并行发起多条 Bash/)
  })
})
