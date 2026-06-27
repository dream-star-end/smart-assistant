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

const { syncMarketplaceHub } = await import('../marketplaceSync.js')
const { marketplaceArtifactHash } = await import('../skillEmbedding.js')
const { buildAgentSkillStore } = await import('../skillStore.js')
const { paths } = await import('../paths.js')

function skillMd(slug: string, description: string, body = 'do the thing'): string {
  return `---\nname: ${slug}\ndescription: ${JSON.stringify(description)}\nversion: 1.0.0\n---\n\n${body}\n`
}

/** Install one approved skill; artifactHash computed with the shared normalization. */
function syncPayload(skills: Array<{ slug: string; md: string; hash?: string }>): unknown {
  return {
    skills: skills.map((s) => ({
      slug: s.slug,
      version: '1.0.0',
      rawSkillMd: s.md,
      artifactHash: s.hash ?? marketplaceArtifactHash(s.md),
    })),
  }
}

let fetchPayload: unknown = { skills: [] }
const realFetch = globalThis.fetch
globalThis.fetch = (async (url: string) => {
  if (String(url).includes('/internal/v3/marketplace/sync')) {
    return new Response(JSON.stringify(fetchPayload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return new Response('not found', { status: 404 })
}) as typeof fetch

afterEach(() => {
  fetchPayload = { skills: [] }
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
  })

  it('removes a skill that is no longer installed (uninstall / revoke kill-switch)', async () => {
    const md = skillMd('temp-skill', 'temporary')
    fetchPayload = syncPayload([{ slug: 'temp-skill', md }])
    await syncMarketplaceHub()
    assert.ok(existsSync(paths.hubSkillMd('temp-skill')))

    // next sync no longer lists it → reconcile removes it
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
