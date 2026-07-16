import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import type { ToolCalledEvent } from '@openclaude/protocol'
import type { SkillMetadata } from '@openclaude/storage'

import {
  SKILL_SHADOW_DEFAULT_SAMPLE_RATE,
  SKILL_SHADOW_ENV,
  type SkillShadowEvent,
  makeSkillShadowReporter,
  parseSkillShadowSampleRate,
  readSkillShadowConfig,
  startSkillShadowReporter,
} from '../skillShadowReporter.js'
import { SKILL_VIEW_TOOL } from '../skillUsageReporter.js'

const TRACE = 'a'.repeat(32)

class FakeBus {
  listener: ((event: ToolCalledEvent) => void) | null = null
  onCalls = 0

  on(_name: 'tool.called', listener: (event: ToolCalledEvent) => void): void {
    this.onCalls += 1
    this.listener = listener
  }

  off(_name: 'tool.called', listener: (event: ToolCalledEvent) => void): void {
    if (this.listener === listener) this.listener = null
  }
}

function config(sampleRate = 1) {
  return { masterBaseUrl: 'http://master', containerToken: 'token', sampleRate }
}

function oneSkill(): SkillMetadata[] {
  return [
    {
      name: 'office-spreadsheet',
      description: 'Create Excel spreadsheets',
      tags: ['excel'],
      path: '/skills/office-spreadsheet',
      source: 'platform',
      layer: 'platform',
      writable: false,
      agentIds: ['main'],
    },
  ]
}

async function waitForCount(events: SkillShadowEvent[], count: number): Promise<void> {
  for (let i = 0; i < 50 && events.length < count; i++) await delay(2)
  assert.equal(events.length, count)
}

describe('skill shadow reporter', () => {
  test('missing env is fail-safe off with no listener or master side effect', () => {
    const bus = new FakeBus()
    assert.equal(startSkillShadowReporter({ env: {}, eventBus: bus as never }), null)
    assert.equal(bus.onCalls, 0)
    assert.equal(bus.listener, null)
    assert.equal(readSkillShadowConfig({ [SKILL_SHADOW_ENV]: '0.1' }), null)
  })

  test('sample rate parser is closed by default and supports explicit 10% default', () => {
    assert.equal(parseSkillShadowSampleRate(undefined), 0)
    assert.equal(parseSkillShadowSampleRate(''), 0)
    assert.equal(parseSkillShadowSampleRate('bogus'), 0)
    assert.equal(parseSkillShadowSampleRate('0'), 0)
    assert.equal(parseSkillShadowSampleRate('default'), SKILL_SHADOW_DEFAULT_SAMPLE_RATE)
    assert.equal(parseSkillShadowSampleRate('true'), SKILL_SHADOW_DEFAULT_SAMPLE_RATE)
    assert.equal(parseSkillShadowSampleRate('0.25'), 0.25)
    assert.equal(parseSkillShadowSampleRate('1'), 1)
  })

  test('observeTurn is asynchronous and stores no raw message in the event', async () => {
    const bus = new FakeBus()
    const events: SkillShadowEvent[] = []
    let release!: () => void
    const loadGate = new Promise<void>((resolve) => {
      release = () => resolve()
    })
    const reporter = makeSkillShadowReporter({
      config: config(),
      eventBus: bus as never,
      loadSkills: async () => {
        await loadGate
        return oneSkill()
      },
      sendEvent: async (event) => {
        events.push(event)
      },
      // This case proves fire-and-forget/privacy, not the deadline. Keep it well
      // above full-suite scheduler starvation; the dedicated test below pins the
      // timeout path with a 5ms budget.
      budgetMs: 5_000,
    })

    const sampled = reporter.observeTurn({
      traceId: TRACE,
      sessionKey: 'agent:main:webchat:dm:p1',
      agentId: 'main',
      userMessage: 'make a secret Excel report',
    })
    assert.equal(sampled, true)
    assert.equal(events.length, 0, 'turn path did not await skill listing/ranking')
    release()
    await waitForCount(events, 1)
    const selection = events[0]
    assert.equal(selection.kind, 'selection')
    if (selection.kind === 'selection') {
      assert.equal(selection.status, 'ok')
      assert.equal(selection.messageHash.length, 64)
      assert.ok(!JSON.stringify(selection).includes('secret'))
      assert.deepEqual(selection.routes.existing_keyword_fallback, ['office-spreadsheet'])
    }
    reporter.stop()
  })

  test('50ms-style budget records one timeout and never retries', async () => {
    const events: SkillShadowEvent[] = []
    let rankCalls = 0
    const reporter = makeSkillShadowReporter({
      config: config(),
      loadSkills: async () => {
        await delay(40)
        return oneSkill()
      },
      sendEvent: async (event) => {
        events.push(event)
      },
      rank: async () => {
        rankCalls += 1
        throw new Error('rank must not run after the budget expired')
      },
      budgetMs: 5,
    })
    assert.equal(
      reporter.observeTurn({
        traceId: TRACE,
        sessionKey: 's1',
        agentId: 'main',
        userMessage: 'Excel report',
      }),
      true,
    )
    await waitForCount(events, 1)
    assert.equal(events[0].kind, 'selection')
    if (events[0].kind === 'selection') assert.equal(events[0].status, 'timeout')
    await delay(60)
    assert.equal(events.length, 1, 'timed-out work was not retried/reported twice')
    assert.equal(rankCalls, 0, 'late catalog I/O did not start ranking after timeout')
    reporter.stop()
  })

  test('actual usage follows the existing successful skill_view tool.called口径', async () => {
    const bus = new FakeBus()
    const events: SkillShadowEvent[] = []
    const reporter = makeSkillShadowReporter({
      config: config(),
      eventBus: bus as never,
      resolveTraceId: () => TRACE,
      loadSkills: async () => oneSkill(),
      sendEvent: async (event) => {
        events.push(event)
      },
    })
    reporter.observeTurn({
      traceId: TRACE,
      sessionKey: 's1',
      agentId: 'main',
      userMessage: 'Excel report',
    })
    await waitForCount(events, 1)
    bus.listener?.({
      schemaVersion: 1,
      type: 'tool.called',
      id: 'tool-1',
      timestamp: Date.now(),
      agentId: 'main',
      sessionKey: 's1',
      toolName: SKILL_VIEW_TOOL,
      inputPreview: JSON.stringify({ name: 'office-spreadsheet' }),
      isError: false,
    } as ToolCalledEvent)
    await waitForCount(events, 2)
    assert.deepEqual(events[1], {
      kind: 'usage',
      traceId: TRACE,
      skillName: 'office-spreadsheet',
    })
    reporter.stop()
    assert.equal(bus.listener, null)
  })
})
