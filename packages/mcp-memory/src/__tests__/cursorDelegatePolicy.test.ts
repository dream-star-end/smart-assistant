import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  cursorDelegateCliHint,
  delegateWaitDisabledText,
  filterListedDelegateTools,
  isCursorHiddenDelegateTool,
  isCursorMcpWaitEnabled,
  shouldExposeDelegateWait,
} from '../cursorDelegatePolicy.js'

describe('cursorDelegatePolicy', () => {
  it('hides sync delegate MCP tools only on cursor', () => {
    assert.equal(isCursorHiddenDelegateTool('delegate_task', 'cursor'), true)
    assert.equal(isCursorHiddenDelegateTool('delegate_tasks', 'cursor'), true)
    assert.equal(isCursorHiddenDelegateTool('request_review', 'cursor'), true)
    assert.equal(isCursorHiddenDelegateTool('send_to_agent', 'cursor'), false)
    assert.equal(isCursorHiddenDelegateTool('delegate_wait', 'cursor'), false)
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

describe('OC_DELEGATE_CURSOR_MCP_WAIT flag', () => {
  const tools = [
    { name: 'delegate_task' },
    { name: 'delegate_tasks' },
    { name: 'delegate_wait' },
    { name: 'request_review' },
    { name: 'send_to_agent' },
  ]

  it('defaults off; only 1/true/on enable', () => {
    assert.equal(isCursorMcpWaitEnabled({}), false)
    assert.equal(isCursorMcpWaitEnabled({ OC_DELEGATE_CURSOR_MCP_WAIT: '0' }), false)
    assert.equal(isCursorMcpWaitEnabled({ OC_DELEGATE_CURSOR_MCP_WAIT: '1' }), true)
    assert.equal(isCursorMcpWaitEnabled({ OC_DELEGATE_CURSOR_MCP_WAIT: 'true' }), true)
    assert.equal(isCursorMcpWaitEnabled({ OC_DELEGATE_CURSOR_MCP_WAIT: 'on' }), true)
  })

  it('exposes wait only on Cursor when the flag is on', () => {
    const on = { OC_DELEGATE_CURSOR_MCP_WAIT: '1' }
    assert.equal(shouldExposeDelegateWait('cursor', on), true)
    assert.equal(shouldExposeDelegateWait('ccb', on), false)
    assert.equal(shouldExposeDelegateWait('cursor', { OC_DELEGATE_CURSOR_MCP_WAIT: '0' }), false)
    assert.equal(shouldExposeDelegateWait('cursor', {}), false)
  })

  it('flag off: Cursor list hides wait and the sync trio; CallTool copy is disabled', () => {
    const listed = filterListedDelegateTools(tools, 'cursor', { OC_DELEGATE_CURSOR_MCP_WAIT: '0' })
    assert.deepEqual(
      listed.map((t) => t.name),
      ['send_to_agent'],
    )
    assert.match(delegateWaitDisabledText(), /status=disabled/)
    assert.match(delegateWaitDisabledText(), /OC_DELEGATE_CURSOR_MCP_WAIT=0/)
  })

  it('flag on: Cursor lists wait but still hides the sync trio', () => {
    const listed = filterListedDelegateTools(tools, 'cursor', { OC_DELEGATE_CURSOR_MCP_WAIT: '1' })
    assert.deepEqual(
      listed.map((t) => t.name),
      ['delegate_wait', 'send_to_agent'],
    )
  })

  it('non-Cursor keeps the sync trio and does not list wait even if flag is on', () => {
    const listed = filterListedDelegateTools(tools, 'ccb', { OC_DELEGATE_CURSOR_MCP_WAIT: '1' })
    assert.deepEqual(
      listed.map((t) => t.name),
      ['delegate_task', 'delegate_tasks', 'request_review', 'send_to_agent'],
    )
  })
})
