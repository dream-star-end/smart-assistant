/**
 * OCV5-281: a foreground Bash tool_result already delivered to the model must
 * not open another billed turn when CLI 2.1.280 later emits task_notification
 * without task_notification_delivered.
 *
 * Drives the real CcbMessageParser, the three-state table, and
 * finalizeCcbLocalAgentPendingInjections (the function server flush calls).
 *
 * Run: npx tsx --test --test-force-exit packages/gateway/src/__tests__/ccbForegroundBashCallback.test.ts
 */
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { CcbMessageParser, type SessionStreamEvent } from '../ccbMessageParser.js'
import {
  CCB_FOREGROUND_BASH_ALREADY_DELIVERED,
  finalizeCcbLocalAgentPendingInjections,
  getCcbLocalAgentCallbackState,
  noteCcbTaskNotification,
  noteForegroundBashToolResult,
  resetCcbLocalAgentCallbackDedupeForTest,
} from '../ccbLocalAgentCallback.js'

const SESSION = 'agent:main:webchat:dm:ocv5-281'

function bashUse(id: string) {
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'echo hi' } }],
    },
  }
}

function bashResult(id: string, content: string) {
  return {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, content }] },
  }
}

function notification(taskId: string, toolUseId?: string) {
  return {
    type: 'system',
    subtype: 'task_notification',
    task_id: taskId,
    status: 'completed',
    summary: 'Spot-check MetaRow and restart classification',
    output_file: '',
    ...(toolUseId ? { tool_use_id: toolUseId } : {}),
  }
}

const MOVED_TO_BACKGROUND =
  'Command did not complete within its 120000ms timeout and was moved to the background (ID: bgtask1).'

function drive(messages: unknown[]) {
  const decisions: string[] = []
  const parser = new CcbMessageParser({
    toolUseIdToName: new Map(),
    onEvent: (event: SessionStreamEvent) => {
      if (event.kind === 'block' && event.block.kind === 'tool_result') {
        const block = event.block as {
          toolUseBlockId?: string
          toolName?: string
          output?: string
          parentToolUseId?: string
        }
        noteForegroundBashToolResult({
          sessionKey: SESSION,
          toolUseId: block.toolUseBlockId,
          toolName: block.toolName,
          output: block.output,
          parentToolUseId: block.parentToolUseId,
        })
        return
      }
      if (event.kind !== 'task_notification') return
      decisions.push(noteCcbTaskNotification({
        sessionKey: SESSION,
        hasInFlightTurn: true,
        userId: '3',
        notification: {
          taskId: event.taskId,
          status: event.status,
          outputFile: event.outputFile,
          summary: event.summary,
          toolUseId: event.toolUseId,
        },
      }))
    },
    onFinish: () => {},
    sessionTotals: { totalCostUSD: 0, turns: 0, _lastCcbCumulativeCost: 0 },
  })
  for (const message of messages) parser.parse(message as never)
  const flushed = finalizeCcbLocalAgentPendingInjections(SESSION)
  return { decisions, ...flushed }
}

afterEach(() => {
  resetCcbLocalAgentCallbackDedupeForTest()
})

describe('foreground bash task_notification is not a new turn', () => {
  it('foreground bash tool_result already delivered then task_notification with no ack injects 0', () => {
    const result = drive([
      bashUse('toolu_fg'),
      bashResult('toolu_fg', 'hi\n'),
      notification('b2k0kp4ey', 'toolu_fg'),
    ])
    assert.deepEqual(result.decisions, ['wait'])
    assert.equal(result.inject.length, 0)
    assert.equal(result.dropped.length, 1)
    assert.equal(result.dropped[0]?.taskId, 'b2k0kp4ey')
    assert.equal(result.dropped[0]?.toolUseId, 'toolu_fg')
    assert.equal(result.dropped[0]?.reason, CCB_FOREGROUND_BASH_ALREADY_DELIVERED)
    assert.equal(getCcbLocalAgentCallbackState(SESSION, 'b2k0kp4ey'), 'delivered')
    assert.equal(finalizeCcbLocalAgentPendingInjections(SESSION).inject.length, 0)
  })

  it('timeout moved to background tool_result then task_notification injects 1', () => {
    const output = `${'x'.repeat(4000)}\n${MOVED_TO_BACKGROUND}`
    const result = drive([
      bashUse('toolu_bg'),
      bashResult('toolu_bg', output),
      notification('bbvk1lgf8', 'toolu_bg'),
    ])
    assert.deepEqual(result.decisions, ['wait'])
    assert.equal(result.dropped.length, 0)
    assert.equal(result.inject.length, 1)
    assert.equal(result.inject[0]?.payload.taskId, 'bbvk1lgf8')
    assert.equal(result.inject[0]?.payload.toolUseId, 'toolu_bg')
    assert.equal(getCcbLocalAgentCallbackState(SESSION, 'bbvk1lgf8'), 'pending')
  })

  it('task_notification without tool_use_id still injects 1', () => {
    const result = drive([
      bashUse('toolu_noid'),
      bashResult('toolu_noid', 'full foreground output\n'),
      notification('bnotoolid'),
    ])
    assert.deepEqual(result.decisions, ['wait'])
    assert.equal(result.dropped.length, 0)
    assert.equal(result.inject.length, 1)
    assert.equal(result.inject[0]?.payload.taskId, 'bnotoolid')
    assert.equal(result.inject[0]?.payload.toolUseId, undefined)
  })

  it('bookend before foreground tool_result still injects 0', () => {
    const notedOnly = drive([notification('bb29d36b3', 'toolu_early')])
    assert.deepEqual(notedOnly.decisions, ['wait'])
    assert.equal(notedOnly.dropped.length, 0)
    assert.equal(notedOnly.inject.length, 1)
    assert.equal(getCcbLocalAgentCallbackState(SESSION, 'bb29d36b3'), 'pending')

    const result = drive([
      bashUse('toolu_early'),
      bashResult('toolu_early', 'done\n'),
    ])
    assert.equal(result.inject.length, 0)
    assert.equal(result.dropped.length, 1)
    assert.equal(result.dropped[0]?.toolUseId, 'toolu_early')
    assert.equal(getCcbLocalAgentCallbackState(SESSION, 'bb29d36b3'), 'delivered')
  })
})
