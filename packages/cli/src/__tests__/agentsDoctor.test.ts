/**
 * msc-config 阶段 B(CFG-13 / CFG-14):CLI `agents add` 的 id 校验与 doctor 的配置诊断纯函数。
 * 运行:npx tsx --test packages/cli/src/__tests__/agentsDoctor.test.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import type { AgentsConfig, OpenClaudeConfig } from '@openclaude/storage'

const home = mkdtempSync(join(tmpdir(), 'msc-config-cli-agents-'))
process.env.OPENCLAUDE_HOME = home
const storage = await import('@openclaude/storage')
const { agentsAdd, validateAgentsAddInput } = await import('../commands/agents.js')
const { doctorConfigFindings, maskAccessToken } = await import('../commands/doctor.js')
after(() => rm(home, { recursive: true, force: true }))

describe('agents add (CFG-14)', () => {
  test('rejects ids that are not [a-zA-Z0-9_-] (path traversal, spaces, hidden ids)', () => {
    for (const bad of ['../x', 'a/b', 'a b', '', 'ok..', 'x\\y']) {
      const r = validateAgentsAddInput(bad, {})
      assert.equal(r.ok, false, `${JSON.stringify(bad)} must be rejected`)
    }
    assert.equal(
      validateAgentsAddInput('coder', { model: '' }).ok,
      false,
      'empty model must be rejected',
    )
    assert.ok(validateAgentsAddInput('coder-2', { model: 'glm-5.3-zai' }).ok)
  })

  test('agentsAdd writes the agent with an absolute persona path under HOME', async () => {
    await storage.writeAgentsConfig({ agents: [{ id: 'main' }], routes: [], default: 'main' })
    const origLog = console.log
    console.log = () => {}
    try {
      await agentsAdd('coder', { model: 'glm-5.3-zai' })
    } finally {
      console.log = origLog
    }
    const cfg = await storage.readAgentsConfig()
    const coder = cfg.agents.find((a) => a.id === 'coder')
    assert.ok(coder)
    assert.equal(coder.persona, storage.paths.agentClaudeMd('coder'))
    assert.equal(coder.model, 'glm-5.3-zai')
  })
})

describe('doctorConfigFindings (CFG-13 + CFG-08 ruling)', () => {
  const base = (): OpenClaudeConfig => ({
    version: 1,
    gateway: { bind: '127.0.0.1', port: 18789, accessToken: 'tok' },
    auth: { mode: 'subscription', claudeCodePath: '/ccb' },
    defaults: { model: 'glm-5.3-zai', permissionMode: 'default' },
    channels: { webchat: { enabled: true } },
  })
  const agents = (): AgentsConfig => ({
    agents: [{ id: 'main' }],
    routes: [],
    default: 'main',
  })

  test('clean config yields a single ok line', () => {
    const findings = doctorConfigFindings({
      config: base(),
      configWarnings: [],
      agents: agents(),
      agentsWarnings: [],
      personaExists: () => true,
    })
    assert.deepEqual(
      findings.map((f) => f.level),
      ['ok'],
    )
  })

  test('normalization warnings are surfaced as warn lines with their file prefix', () => {
    const findings = doctorConfigFindings({
      config: base(),
      configWarnings: ['defaults.permissionMode "yolo" not in … → default'],
      agents: agents(),
      agentsWarnings: ['default "ghost" is not a configured agent → main'],
      personaExists: () => true,
    })
    assert.ok(
      findings.some(
        (f) => f.level === 'warn' && f.line.startsWith('openclaude.json: defaults.permissionMode'),
      ),
    )
    assert.ok(findings.some((f) => f.level === 'warn' && f.line.startsWith('agents.yaml: default')))
  })

  test('empty accessToken and a default agent missing from the list are failures', () => {
    const cfg = base()
    cfg.gateway.accessToken = ''
    const ag = agents()
    ag.default = 'ghost'
    const findings = doctorConfigFindings({
      config: cfg,
      configWarnings: [],
      agents: ag,
      agentsWarnings: [],
      personaExists: () => true,
    })
    assert.equal(findings.filter((f) => f.level === 'fail').length, 2)
  })

  test('gateway.users present → legacy multi-user warning (accessToken still passes auth)', () => {
    const cfg = base()
    cfg.gateway.users = [{ id: 'boss', name: 'Boss', passwordHash: 'x:y' }]
    const findings = doctorConfigFindings({
      config: cfg,
      configWarnings: [],
      agents: agents(),
      agentsWarnings: [],
      personaExists: () => true,
    })
    assert.ok(
      findings.some(
        (f) => f.level === 'warn' && /遗留能力/.test(f.line) && /accessToken/.test(f.line),
      ),
    )
  })

  test('missing persona file is a warning naming the agent and the resolved path', () => {
    const findings = doctorConfigFindings({
      config: base(),
      configWarnings: [],
      agents: {
        agents: [{ id: 'main', persona: 'agents/main/CLAUDE.md' }],
        routes: [],
        default: 'main',
      },
      agentsWarnings: [],
      personaExists: () => false,
    })
    assert.ok(
      findings.some((f) => f.level === 'warn' && /agent main: persona 文件不存在/.test(f.line)),
    )
  })

  test('maskAccessToken keeps head/tail only', () => {
    assert.equal(maskAccessToken('abcdefghijklmnop'), 'abcd…mnop')
    assert.equal(maskAccessToken('short'), 'sh…')
    assert.equal(maskAccessToken(''), '(未设置)')
  })
})
