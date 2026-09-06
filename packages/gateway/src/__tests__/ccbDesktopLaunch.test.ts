/**
 * Desktop CCB launch knobs. Default (env unset) preserves current config-file
 * behavior. OPENCLAUDE_CLAUDE_CODE_* overlays path/entry/runtime. oc-lah.*
 * in process env is sticky so oauth-direct cannot wipe the 18791 proxy.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/ccbDesktopLaunch.test.ts
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'

import {
  finalizeCcbSpawnEnv,
  resolveClaudeCodeLaunch,
} from '../subprocessRunner.js'
import type { OpenClaudeConfig } from '@openclaude/storage'

function cfg(overrides: Partial<OpenClaudeConfig['auth']> = {}): OpenClaudeConfig {
  return {
    version: 1,
    gateway: { bind: '127.0.0.1', port: 18789, accessToken: '' },
    auth: {
      mode: 'subscription',
      claudeCodePath: '/opt/ccb',
      claudeCodeEntry: 'src/entrypoints/cli.tsx',
      claudeCodeRuntime: 'bun',
      ...overrides,
    },
    sessions: { dbPath: '' },
    defaults: { model: 'glm-5.2' },
  } as unknown as OpenClaudeConfig
}

describe('resolveClaudeCodeLaunch', () => {
  test('default env uses config.auth values', () => {
    const launch = resolveClaudeCodeLaunch(cfg(), {})
    assert.equal(launch.binaryDir, resolve('/opt/ccb'))
    assert.equal(launch.runtime, 'bun')
    assert.equal(launch.entry, resolve('/opt/ccb', 'src/entrypoints/cli.tsx'))
  })

  test('OPENCLAUDE_CLAUDE_CODE_* overlays config', () => {
    const launch = resolveClaudeCodeLaunch(cfg(), {
      OPENCLAUDE_CLAUDE_CODE_PATH: '/tmp/fake-ccb-root',
      OPENCLAUDE_CLAUDE_CODE_ENTRY: '/tmp/fake-ccb.mjs',
      OPENCLAUDE_CLAUDE_CODE_RUNTIME: 'node',
    })
    assert.equal(launch.binaryDir, resolve('/tmp/fake-ccb-root'))
    assert.equal(launch.entry, '/tmp/fake-ccb.mjs')
    assert.equal(launch.runtime, 'node')
  })
})

describe('finalizeCcbSpawnEnv desktop lah pin', () => {
  test('oc-lah token + base url survive oauth-direct overlay', () => {
    const env = finalizeCcbSpawnEnv({
      source: {
        PATH: '/usr/bin',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:18791',
        ANTHROPIC_AUTH_TOKEN: `oc-lah.${'ab'.repeat(32)}`,
      },
      providerEnv: {
        ANTHROPIC_BASE_URL: '',
        ANTHROPIC_AUTH_TOKEN: '',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-should-not-win',
      },
      routing: 'oauth-direct',
    })
    assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:18791')
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, `oc-lah.${'ab'.repeat(32)}`)
    assert.equal(env.ANTHROPIC_API_KEY, undefined)
  })

  test('without oc-lah, oauth-direct still clears inherited proxy env', () => {
    const env = finalizeCcbSpawnEnv({
      source: {
        ANTHROPIC_BASE_URL: 'http://172.31.0.1:18892',
        ANTHROPIC_AUTH_TOKEN: 'oc-v3.not.for.ccb',
      },
      providerEnv: {
        ANTHROPIC_BASE_URL: '',
        ANTHROPIC_AUTH_TOKEN: '',
      },
      routing: 'oauth-direct',
    })
    assert.equal(env.ANTHROPIC_BASE_URL, '')
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, '')
  })
})
