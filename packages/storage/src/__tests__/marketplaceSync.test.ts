/**
 * Tests for syncMarketplaceHub — the deterministic pre-prompt reconcile that the
 * gateway runner awaits before building the skills slot (RFC M1, Codex BLOCKER#1).
 *
 * Proves the install→prompt chain end-to-end at the storage layer:
 *   sync writes hub/skills/<slug>/SKILL.md  →  buildAgentSkillStore().list()
 *   surfaces it on the read-only `hub` overlay (i.e. it WILL be in the next
 *   session's static prompt, not merely tool-visible).
 *
 * Run:
 *   npx tsx --test packages/storage/src/__tests__/marketplaceSync.test.ts
 */
import * as assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, describe, it } from 'node:test'

// OPENCLAUDE_HOME must point at a throwaway dir BEFORE importing paths-aware modules.
const testHome = await mkdtemp(join(tmpdir(), 'oc-mktsync-'))
process.env.OPENCLAUDE_HOME = testHome
process.env.OPENCLAUDE_V3_MASTER_BASE_URL = 'http://master.internal'
process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = 'tok-test'

const { _resetMarketplaceSyncStateForTest, syncMarketplaceHub } = await import(
  '../marketplaceSync.js'
)
const { marketplaceArtifactHash } = await import('../skillEmbedding.js')
const { buildAgentSkillStore } = await import('../skillStore.js')
const { readAgentsConfig } = await import('../config.js')
const { paths } = await import('../paths.js')

function agentManifestJson(slug: string, model = 'glm-5.2', toolsets: string[] = ['core']): string {
  return `${JSON.stringify(
    {
      name: slug,
      description: `${slug} agent`,
      version: '1.0.0',
      model,
      toolsets,
      skillDeps: [],
      persona: `你是 ${slug}。`,
    },
    null,
    2,
  )}\n`
}

function agentsPayload(agents: Array<{ slug: string; json: string; hash?: string }>): unknown {
  return {
    skills: [],
    agents: agents.map((a) => ({
      slug: a.slug,
      version: '1.0.0',
      rawManifest: a.json,
      artifactHash: a.hash ?? marketplaceArtifactHash(a.json),
    })),
  }
}

function skillMd(slug: string, description: string, body = 'do the thing'): string {
  return `---\nname: ${slug}\ndescription: ${JSON.stringify(description)}\nversion: 1.0.0\n---\n\n${body}\n`
}

/** Install one approved skill; artifactHash computed with the shared normalization. */
function syncPayload(skills: Array<{ slug: string; md: string; hash?: string; agentIds?: string[] }>): unknown {
  return {
    skills: skills.map((s) => ({
      slug: s.slug,
      version: '1.0.0',
      rawSkillMd: s.md,
      artifactHash: s.hash ?? marketplaceArtifactHash(s.md),
      ...(s.agentIds ? { agentIds: s.agentIds } : {}),
    })),
  }
}

let fetchPayload: unknown = { skills: [] }
let fetchStatus = 200 // 非 200 时模拟 master 侧失败(fetchInstalled → null)
let fetchCalls = 0 // 单飞/TTL 断言用:实际打到 mock 的 sync 请求数
const realFetch = globalThis.fetch
globalThis.fetch = (async (url: string) => {
  if (String(url).includes('/internal/v3/marketplace/sync')) {
    fetchCalls++
    if (fetchStatus !== 200) return new Response('boom', { status: fetchStatus })
    return new Response(JSON.stringify(fetchPayload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return new Response('not found', { status: 404 })
}) as typeof fetch

afterEach(() => {
  fetchPayload = { skills: [] }
  fetchStatus = 200
  fetchCalls = 0
  // 清掉单飞/成功 TTL/告警限频状态 —— 否则上一个用例的成功 sync 会让下一个
  // 用例的调用被 TTL 短路。
  _resetMarketplaceSyncStateForTest()
})

after(() => {
  globalThis.fetch = realFetch
})

describe('syncMarketplaceHub', () => {
  it('writes an installed skill into the hub and it becomes prompt-visible via SkillStore.list', async () => {
    const md = skillMd('academic-translate', 'translate academic text')
    fetchPayload = syncPayload([{ slug: 'academic-translate', md }])

    await syncMarketplaceHub()

    // hub/skills/<slug>/SKILL.md materialized
    const p = paths.hubSkillMd('academic-translate')
    assert.ok(existsSync(p), 'SKILL.md should exist in hub')
    assert.equal(await readFile(p, 'utf8'), md)

    // and it is in the prompt skills slot (hub overlay layer)
    const list = await buildAgentSkillStore('main').list()
    const found = list.find((s) => s.name === 'academic-translate')
    assert.ok(found, 'installed skill should surface in SkillStore.list (static prompt)')
    assert.equal(found?.layer, 'hub')
    assert.equal(found?.writable, false)
    assert.deepEqual(found?.agentIds, ['main'])
  })

  it('writes hub scope sidecar and only exposes a skill to selected agents', async () => {
    const md = skillMd('office-only-hub', 'office scoped')
    fetchPayload = syncPayload([{ slug: 'office-only-hub', md, agentIds: ['office-assistant'] }])

    await syncMarketplaceHub()

    const sidecar = join(paths.hubSkillDir('office-only-hub'), '.openclaude-agent-scope.json')
    assert.ok(existsSync(sidecar), 'scope sidecar should exist in hub')
    assert.deepEqual(JSON.parse(await readFile(sidecar, 'utf8')).agentIds, ['office-assistant'])
    assert.ok((await buildAgentSkillStore('office-assistant').list()).some((s) => s.name === 'office-only-hub'))
    assert.ok(!(await buildAgentSkillStore('main').list()).some((s) => s.name === 'office-only-hub'))
  })

  it('removes a skill that is no longer installed (uninstall / revoke kill-switch)', async () => {
    const md = skillMd('temp-skill', 'temporary')
    fetchPayload = syncPayload([{ slug: 'temp-skill', md }])
    await syncMarketplaceHub()
    assert.ok(existsSync(paths.hubSkillMd('temp-skill')))

    // next sync no longer lists it → reconcile removes it
    // (同一用例内的第二次调用会撞上成功 TTL,先复位)
    _resetMarketplaceSyncStateForTest()
    fetchPayload = { skills: [] }
    await syncMarketplaceHub()
    assert.ok(!existsSync(paths.hubSkillDir('temp-skill')), 'revoked skill should be removed')
    const list = await buildAgentSkillStore('main').list()
    assert.ok(!list.find((s) => s.name === 'temp-skill'))
  })

  it('drops a skill whose content does not match its pinned artifactHash (tamper guard)', async () => {
    const md = skillMd('tampered', 'looks fine')
    // hash of DIFFERENT content → mismatch
    fetchPayload = syncPayload([{ slug: 'tampered', md, hash: marketplaceArtifactHash('other') }])
    await syncMarketplaceHub()
    assert.ok(!existsSync(paths.hubSkillDir('tampered')), 'hash-mismatched skill must not install')
  })

  it('is a no-op outside a commercial container (no master base url / token)', async () => {
    const base = process.env.OPENCLAUDE_V3_MASTER_BASE_URL
    const tok = process.env.OPENCLAUDE_V3_CONTAINER_TOKEN
    delete process.env.OPENCLAUDE_V3_MASTER_BASE_URL
    delete process.env.OPENCLAUDE_V3_CONTAINER_TOKEN
    try {
      fetchPayload = syncPayload([{ slug: 'should-not-write', md: skillMd('should-not-write', 'x') }])
      await syncMarketplaceHub() // must not throw, must not write
      assert.ok(!existsSync(paths.hubSkillDir('should-not-write')))
    } finally {
      process.env.OPENCLAUDE_V3_MASTER_BASE_URL = base
      process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = tok
    }
  })

  it('honors a caller-supplied fetch timeout bound (pre-prompt path)', async () => {
    const md = skillMd('bounded', 'bounded fetch')
    fetchPayload = syncPayload([{ slug: 'bounded', md }])
    await syncMarketplaceHub({ timeoutMs: 1000 }) // must still reconcile within bound
    assert.ok(existsSync(paths.hubSkillMd('bounded')))
  })
})

describe('syncMarketplaceHub — agents (RFC M3)', () => {
  it('reconciles an installed agent into agents.yaml (source=marketplace) + writes its persona', async () => {
    const json = agentManifestJson('writer-bot', 'glm-5.2', ['core', 'research'])
    fetchPayload = agentsPayload([{ slug: 'writer-bot', json }])
    await syncMarketplaceHub()

    const cfg = await readAgentsConfig()
    const agent = cfg.agents.find((a) => a.id === 'writer-bot')
    assert.ok(agent, 'market agent should be in agents.yaml')
    assert.equal(agent?.source, 'marketplace')
    assert.deepEqual(agent?.toolsets, ['core', 'research'])
    assert.equal(agent?.model, 'glm-5.2')
    // platform 'main' is preserved (never touched by the reconcile)
    assert.ok(cfg.agents.find((a) => a.id === 'main'))
    // persona materialized to the agent's CLAUDE.md
    const personaPath = paths.agentClaudeMd('writer-bot')
    assert.ok(existsSync(personaPath))
    assert.equal((await readFile(personaPath, 'utf8')).includes('你是 writer-bot'), true)
  })

  it('removes a market agent that is no longer installed, keeping platform agents', async () => {
    fetchPayload = agentsPayload([{ slug: 'writer-bot', json: agentManifestJson('writer-bot') }])
    await syncMarketplaceHub()
    assert.ok((await readAgentsConfig()).agents.find((a) => a.id === 'writer-bot'))

    // next sync no longer lists it → reconcile removes the market entry
    // (同一用例内的第二次调用会撞上成功 TTL,先复位)
    _resetMarketplaceSyncStateForTest()
    fetchPayload = agentsPayload([])
    await syncMarketplaceHub()
    const cfg = await readAgentsConfig()
    assert.ok(!cfg.agents.find((a) => a.id === 'writer-bot'), 'uninstalled agent removed')
    assert.ok(cfg.agents.find((a) => a.id === 'main'), 'platform main preserved')
  })

  it('drops an agent whose manifest does not match its pinned artifactHash', async () => {
    const json = agentManifestJson('tampered-agent')
    fetchPayload = agentsPayload([
      { slug: 'tampered-agent', json, hash: marketplaceArtifactHash('different') },
    ])
    await syncMarketplaceHub()
    assert.ok(!(await readAgentsConfig()).agents.find((a) => a.id === 'tampered-agent'))
  })

  it('never overwrites a platform/user agent id (collision guard for "main")', async () => {
    // A market agent whose slug collides with the reserved 'main' must be skipped:
    // main's persona/def stays untouched and no duplicate id is written.
    const evil = agentManifestJson('main', 'glm-5.2', ['core', 'browser'])
    fetchPayload = agentsPayload([{ slug: 'main', json: evil }])
    await syncMarketplaceHub()
    const cfg = await readAgentsConfig()
    const mains = cfg.agents.filter((a) => a.id === 'main')
    assert.equal(mains.length, 1, 'exactly one main, no duplicate')
    assert.notEqual(mains[0].source, 'marketplace', 'platform main must NOT be replaced by a market agent')
  })
})

describe('syncMarketplaceHub — 单飞 + 成功 TTL 收口', () => {
  it('coalesces concurrent calls into one in-flight sync (single fetch)', async () => {
    fetchPayload = syncPayload([{ slug: 'sf-skill', md: skillMd('sf-skill', 'singleflight') }])
    // 两个并发调用共享同一个 in-flight promise → mock 只被打一次
    await Promise.all([syncMarketplaceHub(), syncMarketplaceHub()])
    assert.equal(fetchCalls, 1, 'concurrent calls must share one fetch')
    assert.ok(existsSync(paths.hubSkillMd('sf-skill')), 'shared flight still reconciles')
  })

  it('skips the network within the success TTL; force bypasses it', async () => {
    fetchPayload = syncPayload([{ slug: 'ttl-skill', md: skillMd('ttl-skill', 'ttl') }])
    await syncMarketplaceHub()
    assert.equal(fetchCalls, 1)

    // 距上次成功 <5s → 直接返回,不发请求
    await syncMarketplaceHub()
    assert.equal(fetchCalls, 1, 'second call within the TTL must not fetch')

    // force 逃生口:绕过 TTL,真正重新拉取
    await syncMarketplaceHub({ force: true })
    assert.equal(fetchCalls, 2, 'force must bypass the TTL')
  })

  it('a failed sync does not arm the TTL (next call retries)', async () => {
    fetchStatus = 500
    await syncMarketplaceHub() // 失败,fail-soft 不抛
    assert.equal(fetchCalls, 1)
    await syncMarketplaceHub() // 失败不进 TTL → 立刻重试
    assert.equal(fetchCalls, 2, 'failure must not be cached by the TTL')

    // master 恢复后照常同步成功,并重新武装 TTL
    fetchStatus = 200
    fetchPayload = syncPayload([{ slug: 'recover-skill', md: skillMd('recover-skill', 'ok') }])
    await syncMarketplaceHub()
    assert.equal(fetchCalls, 3)
    assert.ok(existsSync(paths.hubSkillMd('recover-skill')))
    await syncMarketplaceHub()
    assert.equal(fetchCalls, 3, 'success re-arms the TTL')
  })

  it('rate-limits fetch-failure warnings to ≤1 per window, with a reason summary', async () => {
    const warns: string[] = []
    const realWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(' '))
    }
    try {
      fetchStatus = 500
      await syncMarketplaceHub()
      await syncMarketplaceHub() // 同一 60s 窗口内的第二次失败 → 不再告警
    } finally {
      console.warn = realWarn
    }
    const fetchWarns = warns.filter((w) => w.includes('sync fetch failed'))
    assert.equal(fetchWarns.length, 1, 'two failures in one window → exactly one warn')
    assert.ok(fetchWarns[0].includes('HTTP 500'), 'warn must carry the failure reason summary')
  })
})
