/**
 * msc-config 阶段 B(CFG-01 / CFG-12 / CFG-16):onboard 重跑必须是「深合并」而不是整文件覆盖。
 * 运行:npx tsx --test packages/cli/src/__tests__/onboard.test.ts
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import type { OpenClaudeConfig } from '@openclaude/storage'

const home = mkdtempSync(join(tmpdir(), 'msc-config-onboard-'))
process.env.OPENCLAUDE_HOME = home
const fakeCcb = join(home, 'ccb')
mkdirSync(join(fakeCcb, 'src', 'entrypoints'), { recursive: true })
writeFileSync(join(fakeCcb, 'src', 'entrypoints', 'cli.tsx'), '// stub')

const storage = await import('@openclaude/storage')
const { buildOnboardConfig, isAuthMode, onboard, parseOnboardPort } = await import(
  '../commands/onboard.js'
)
after(() => rm(home, { recursive: true, force: true }))

const INPUT = {
  claudeCodePath: fakeCcb,
  authMode: 'subscription' as const,
  port: 18790,
  bind: '0.0.0.0',
  model: 'glm-5.3-zai',
}

function existingConfig(): OpenClaudeConfig {
  return {
    version: 1,
    gateway: {
      bind: '127.0.0.1',
      port: 18789,
      accessToken: 'keep-this-token',
      users: [{ id: 'boss', name: 'Boss', passwordHash: 'salt:hash' }],
      outboundRing: { maxAgeMs: 3_600_000 },
    },
    auth: {
      mode: 'api_key',
      claudeCodePath: fakeCcb,
      claudeOAuth: { accessToken: 'oauth-a', refreshToken: 'oauth-r', expiresAt: 1, scope: 's' },
      codexOAuth: { accessToken: 'codex-a', refreshToken: 'codex-r', expiresAt: 1, scope: 's' },
    },
    defaults: { model: 'old-model', permissionMode: 'default', toolsets: ['coding'] },
    toolsets: { coding: ['openclaude-memory'] },
    provider: 'minimax',
    channels: {
      webchat: { enabled: true },
      telegram: { enabled: true, botToken: 'tg', mentionRequired: false },
    },
    mcpServers: [{ id: 'browser', command: 'npx', args: ['x'], env: { API_KEY: 'secret' } }],
    terminal: { type: 'docker', image: 'oc:latest' },
  }
}

describe('buildOnboardConfig', () => {
  test('first install writes the documented defaults and a fresh 64-hex token', () => {
    const cfg = buildOnboardConfig(null, INPUT)
    assert.equal(cfg.version, 1)
    assert.match(cfg.gateway.accessToken, /^[0-9a-f]{64}$/)
    assert.equal(cfg.gateway.port, 18790)
    assert.equal(cfg.defaults.permissionMode, 'acceptEdits')
    assert.equal(cfg.defaults.model, 'glm-5.3-zai')
    assert.deepEqual(cfg.channels, { webchat: { enabled: true } })
  })

  test('re-run keeps every field that was not asked and only overrides the asked ones', () => {
    const before = existingConfig()
    const cfg = buildOnboardConfig(structuredClone(before), INPUT)
    // overridden
    assert.equal(cfg.gateway.bind, '0.0.0.0')
    assert.equal(cfg.gateway.port, 18790)
    assert.equal(cfg.auth.mode, 'subscription')
    assert.equal(cfg.defaults.model, 'glm-5.3-zai')
    // kept
    assert.equal(cfg.gateway.accessToken, 'keep-this-token')
    assert.deepEqual(cfg.gateway.users, before.gateway.users)
    assert.deepEqual(cfg.gateway.outboundRing, before.gateway.outboundRing)
    assert.deepEqual(cfg.auth.claudeOAuth, before.auth.claudeOAuth)
    assert.deepEqual(cfg.auth.codexOAuth, before.auth.codexOAuth)
    assert.equal(
      cfg.defaults.permissionMode,
      'default',
      'existing permissionMode must not flip to acceptEdits',
    )
    assert.deepEqual(cfg.defaults.toolsets, ['coding'])
    assert.deepEqual(cfg.toolsets, before.toolsets)
    assert.equal(cfg.provider, 'minimax')
    assert.deepEqual(cfg.channels.telegram, before.channels.telegram)
    assert.deepEqual(cfg.mcpServers, before.mcpServers)
    assert.deepEqual(cfg.terminal, before.terminal)
  })

  test('re-run regenerates the token only when the existing one is empty', () => {
    const before = existingConfig()
    before.gateway.accessToken = ''
    assert.match(buildOnboardConfig(before, INPUT).gateway.accessToken, /^[0-9a-f]{64}$/)
  })
})

describe('input parsing (CFG-12)', () => {
  test('port shares the gateway env-override rules: 1..65535 integers only, empty → default', () => {
    assert.equal(parseOnboardPort(undefined), storage.DEFAULT_GATEWAY_PORT)
    assert.equal(parseOnboardPort(''), storage.DEFAULT_GATEWAY_PORT)
    assert.equal(parseOnboardPort(8080), 8080)
    assert.equal(parseOnboardPort('8080'), 8080)
    for (const bad of ['0', '70000', 'abc', Number.NaN, 1.5])
      assert.equal(parseOnboardPort(bad), null, `${String(bad)} must be rejected`)
  })

  test('authMode must be one of the three enum values', () => {
    assert.ok(isAuthMode('custom_platform'))
    assert.equal(isAuthMode('magic'), false)
  })
})

describe('onboard() non-interactive re-run against a real HOME', () => {
  test('keeps credentials/users/mcpServers and never touches an existing agents.yaml', async () => {
    await storage.writeConfig(existingConfig())
    await storage.writeAgentsConfig({
      agents: [
        { id: 'main', model: 'glm-5.3-zai', displayName: '小克', permissionMode: 'default' },
        { id: 'shop-assistant', source: 'marketplace', model: 'deepseek-v4-pro' },
        { id: 'coder', model: 'gpt-6-astra', cwd: '/work' },
      ],
      routes: [{ match: { channel: 'telegram' }, agent: 'coder' }],
      default: 'main',
    })
    const lines: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '))
    }
    try {
      await onboard({
        nonInteractive: true,
        claudeCodePath: fakeCcb,
        port: 18790,
        bind: '0.0.0.0',
        model: 'glm-5.3-zai',
      })
    } finally {
      console.log = origLog
    }
    const after = (await storage.readConfig())!
    assert.equal(after.gateway.accessToken, 'keep-this-token')
    assert.equal(after.gateway.users?.length, 1)
    assert.equal(after.auth.claudeOAuth?.accessToken, 'oauth-a')
    assert.equal(after.auth.codexOAuth?.accessToken, 'codex-a')
    assert.equal(after.mcpServers?.length, 1)
    assert.equal(after.provider, 'minimax')
    assert.equal(after.terminal?.type, 'docker')
    assert.equal(after.defaults.permissionMode, 'default')
    assert.equal(after.gateway.port, 18790)
    const agents = await storage.readAgentsConfig()
    assert.deepEqual(
      agents.agents.map((a) => a.id),
      ['main', 'shop-assistant', 'coder'],
    )
    assert.equal(agents.routes.length, 1)
    // 重跑默认脱敏,不再把完整 token 打进终端
    assert.ok(
      lines.some((l) => /Access token: keep…oken/.test(l)),
      lines.join('\n'),
    )
    assert.ok(
      !lines.some((l) => /keep-this-token/.test(l)),
      'full token must not be printed on re-run',
    )
  })

  test('first install still writes agents.yaml with main and prints the full token once', async () => {
    await rm(storage.paths.config, { force: true })
    await rm(storage.paths.agentsYaml, { force: true })
    const lines: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '))
    }
    try {
      await onboard({
        nonInteractive: true,
        claudeCodePath: fakeCcb,
        port: 18789,
        bind: '127.0.0.1',
      })
    } finally {
      console.log = origLog
    }
    const cfg = (await storage.readConfig())!
    assert.equal(cfg.defaults.model, storage.SELFHOST_FALLBACK_MODEL)
    assert.equal(cfg.defaults.permissionMode, 'acceptEdits')
    assert.ok(
      lines.some((l) => l.includes(cfg.gateway.accessToken)),
      'first install must reveal the token',
    )
    const agents = await storage.readAgentsConfig()
    assert.deepEqual(
      agents.agents.map((a) => a.id),
      ['main'],
    )
    assert.equal(agents.agents[0].persona, storage.paths.agentClaudeMd('main'))
  })
})
