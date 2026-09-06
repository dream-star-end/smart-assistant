/**
 * OPENCLAUDE_ENGINES allowlist (desktop W-01). Default unset = all engines
 * remain registered (zero behavior change for container/personal).
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/engineEnabled.test.ts
 */
import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ENGINE_NOT_ENABLED,
  EngineNotEnabledError,
  createEngine,
  isEngineEnabled,
  parseEnabledEngines,
  type EngineCreateOpts,
} from '../engine/registry.js'
import '../engine/ccbAdapter.js'
import '../engine/cursorAdapter.js'
import type { OpenClaudeConfig } from '@openclaude/storage'

const ORIGINAL = process.env.OPENCLAUDE_ENGINES

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.OPENCLAUDE_ENGINES
  else process.env.OPENCLAUDE_ENGINES = ORIGINAL
})

function minimalCreateOpts(): EngineCreateOpts {
  return {
    sessionKey: 'agent:main:webchat:dm:engines',
    agentId: 'main',
    agentBaseDir: '/tmp',
    config: {
      version: 1,
      gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
      auth: { mode: 'subscription', claudeCodePath: '' },
      sessions: { dbPath: '' },
      defaults: { model: 'glm-5.2' },
    } as unknown as OpenClaudeConfig,
  } as EngineCreateOpts
}

describe('OPENCLAUDE_ENGINES', () => {
  test('unset → all engines enabled (current behavior)', () => {
    delete process.env.OPENCLAUDE_ENGINES
    assert.equal(parseEnabledEngines(undefined), null)
    assert.equal(isEngineEnabled('ccb'), true)
    assert.equal(isEngineEnabled('cursor'), true)
    assert.equal(isEngineEnabled('codex'), true)
  })

  test('OPENCLAUDE_ENGINES=ccb enables only ccb', () => {
    process.env.OPENCLAUDE_ENGINES = 'ccb'
    assert.equal(isEngineEnabled('ccb'), true)
    assert.equal(isEngineEnabled('cursor'), false)
    assert.equal(isEngineEnabled('codex'), false)
    assert.equal(isEngineEnabled('grok'), false)
  })

  test('createEngine(cursor) under desktop env throws ENGINE_NOT_ENABLED', () => {
    process.env.OPENCLAUDE_ENGINES = 'ccb'
    assert.throws(
      () => createEngine('cursor', minimalCreateOpts()),
      (err: unknown) =>
        err instanceof EngineNotEnabledError
        && err.code === ENGINE_NOT_ENABLED
        && /cursor/.test(err.message),
    )
  })

  test('createEngine(ccb) still works under desktop env', () => {
    process.env.OPENCLAUDE_ENGINES = 'ccb'
    const adapter = createEngine('ccb', minimalCreateOpts())
    assert.equal(adapter.engineId, 'ccb')
  })
})
