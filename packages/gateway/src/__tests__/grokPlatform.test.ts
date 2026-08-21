/**
 * Official Grok platform projection: config.toml MCP + token file isolation.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/grokPlatform.test.ts
 */
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'

import { GROK_PREAMBLE, projectGrokPlatform } from '../engine/grokPlatform.js'

function restore(name: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, name)
  else process.env[name] = value
}

describe('grok platform projection', () => {
  test('writes openclaude-memory into GROK_HOME without putting the bearer in config.toml', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'oc-grok-platform-home-'))
    const oldHome = process.env.OPENCLAUDE_HOME
    process.env.OPENCLAUDE_HOME = home
    try {
      const projected = projectGrokPlatform({
        agentId: 'main',
        sessionKey: 'agent:main:webchat:dm:grok-platform-test',
        gatewayPort: 18790,
        gatewayToken: 'bearer-must-not-enter-config',
        delegationDepth: 0,
      })
      assert.equal(projected.grokHome, path.join(home, 'grok-build'))
      assert.ok(projected.advertisedMcpTools.includes('skill_search'))
      assert.ok(projected.delegateContextFile)
      const raw = readFileSync(path.join(projected.grokHome, 'config.toml'), 'utf8')
      assert.match(raw, /\[shell_environment_policy\]/)
      assert.match(raw, /\[mcp_servers\."openclaude-memory"\]/)
      assert.equal(raw.includes('bearer-must-not-enter-config'), false)
      const tokenFile = path.join(projected.grokHome, 'gateway-token')
      assert.equal(readFileSync(tokenFile, 'utf8'), 'bearer-must-not-enter-config')
      assert.equal(lstatSync(tokenFile).mode & 0o777, 0o600)
      assert.match(raw, /OPENCLAUDE_ENGINE = "grok"/)
      assert.match(raw, /tool_timeout_sec = 600/)
      assert.ok(GROK_PREAMBLE.includes('Grok adapter'))
      assert.ok(GROK_PREAMBLE.includes('options'))
    } finally {
      rmSync(home, { recursive: true, force: true })
      restore('OPENCLAUDE_HOME', oldHome)
    }
  })

  test('skips MCP when the gateway token is missing', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'oc-grok-platform-notoken-'))
    const oldHome = process.env.OPENCLAUDE_HOME
    process.env.OPENCLAUDE_HOME = home
    try {
      const projected = projectGrokPlatform({
        agentId: 'main',
        sessionKey: 'agent:main:webchat:dm:grok-platform-empty',
        gatewayPort: 18790,
        gatewayToken: '',
        delegationDepth: 0,
      })
      const raw = readFileSync(path.join(projected.grokHome, 'config.toml'), 'utf8')
      assert.equal(projected.advertisedMcpTools.length, 0)
      assert.equal(projected.delegateContextFile, null)
      assert.equal(raw.includes('mcp_servers'), false)
      assert.equal(existsSync(path.join(projected.grokHome, 'gateway-token')), false)
    } finally {
      rmSync(home, { recursive: true, force: true })
      restore('OPENCLAUDE_HOME', oldHome)
    }
  })
})
