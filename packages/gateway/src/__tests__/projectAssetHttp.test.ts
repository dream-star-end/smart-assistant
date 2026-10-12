/**
 * Gateway HTTP entry for /api/project-assets: created vs reused vs digest mismatch.
 * Run: npx tsx --test packages/gateway/src/__tests__/projectAssetHttp.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'oc-gw-asset-'))
process.env.OPENCLAUDE_HOME = home

const { Gateway } = await import('../server.js')
const { signJwt } = await import('../auth.js')

const TOKEN = 'test-gateway-token-assets'
const jwt = signJwt({ userId: 'default', exp: Math.floor(Date.now() / 1000) + 3600 }, TOKEN)
const DIGEST_A = 'aa'.repeat(32)
const DIGEST_B = 'bb'.repeat(32)

describe('Gateway HTTP /api/project-assets created/reused/digest', () => {
  it('POST created then reused; invalid digest is 400', async () => {
    const gw = new Gateway({
      config: {
        version: 1,
        gateway: { bind: '127.0.0.1', port: 0, accessToken: TOKEN },
        auth: { mode: 'subscription', claudeCodePath: '' },
        sessions: { dbPath: join(home, 'sessions.db') },
        defaults: { model: 'glm-5.2' },
      } as never,
      agentsConfig: { agents: [{ id: 'main' }], routes: [], default: 'main' },
    })
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      ;(gw as unknown as { handleHttp: (r: IncomingMessage, s: ServerResponse) => void }).handleHttp(
        req,
        res,
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    const base = `http://127.0.0.1:${port}`
    const headers = { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' }

    try {
      const bad = await fetch(`${base}/api/project-assets`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          source: 'output',
          name: 'shot.png',
          containerPath: '/home/agent/.openclaude/generated/shot.png',
          digest: 'not-a-digest',
        }),
      })
      assert.equal(bad.status, 400)

      const created = await fetch(`${base}/api/project-assets`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          source: 'output',
          name: 'shot.png',
          containerPath: '/home/agent/.openclaude/generated/shot.png',
          digest: DIGEST_A,
        }),
      })
      assert.equal(created.status, 200)
      const createdBody = (await created.json()) as {
        asset?: { id: string }
        created?: boolean
        reused?: boolean
      }
      assert.ok(createdBody.asset?.id)
      assert.equal(createdBody.created, true)
      assert.equal(createdBody.reused, false)

      const reused = await fetch(`${base}/api/project-assets`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          source: 'output',
          name: 'shot-again.png',
          containerPath: '/home/agent/.openclaude/generated/shot.png',
          digest: DIGEST_A,
        }),
      })
      assert.equal(reused.status, 200)
      const reusedBody = (await reused.json()) as {
        asset?: { id: string }
        created?: boolean
        reused?: boolean
      }
      assert.equal(reusedBody.asset?.id, createdBody.asset?.id)
      assert.equal(reusedBody.created, false)
      assert.equal(reusedBody.reused, true)

      const other = await fetch(`${base}/api/project-assets`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          source: 'output',
          name: 'other.png',
          containerPath: '/home/agent/.openclaude/generated/other.png',
          digest: DIGEST_B,
        }),
      })
      assert.equal(other.status, 200)
      const otherBody = (await other.json()) as { asset?: { id: string }; created?: boolean }
      assert.notEqual(otherBody.asset?.id, createdBody.asset?.id)
      assert.equal(otherBody.created, true)
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      )
    }
  })
})

describe('Gateway HTTP /api/project-assets/:id/versions and /restore', () => {
  it('lists versions newest first, restores an old one as the newest, tenant-scoped', async () => {
    const gw = new Gateway({
      config: {
        version: 1,
        gateway: { bind: '127.0.0.1', port: 0, accessToken: TOKEN },
        auth: { mode: 'subscription', claudeCodePath: '' },
        sessions: { dbPath: join(home, 'sessions.db') },
        defaults: { model: 'glm-5.2' },
      } as never,
      agentsConfig: { agents: [{ id: 'main' }], routes: [], default: 'main' },
    })
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      ;(gw as unknown as { handleHttp: (r: IncomingMessage, s: ServerResponse) => void }).handleHttp(
        req,
        res,
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    const base = `http://127.0.0.1:${port}`
    const headers = { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' }
    const path = '/home/agent/.openclaude/generated/versioned.md'
    const register = async (digest: string) => {
      const r = await fetch(`${base}/api/project-assets`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ source: 'output', name: 'versioned.md', containerPath: path, digest, url: `/api/media/${digest}.md` }),
      })
      assert.equal(r.status, 200)
      return ((await r.json()) as { asset: { id: string } }).asset.id
    }
    type Version = { id: string; digest: string; url: string; containerPath: string }

    try {
      const v1 = await register(DIGEST_A)
      const v2 = await register(DIGEST_B)
      assert.notEqual(v1, v2)

      const listed = await fetch(`${base}/api/project-assets`, { headers })
      const listedBody = (await listed.json()) as { assets: Array<{ id: string; versionCount?: number }> }
      const entry = listedBody.assets.find((a) => a.id === v2)
      assert.equal(entry?.versionCount, 2)
      assert.equal(listedBody.assets.some((a) => a.id === v1), false)

      const versions = await fetch(`${base}/api/project-assets/${v1}/versions`, { headers })
      assert.equal(versions.status, 200)
      const vBody = (await versions.json()) as { versions: Version[] }
      assert.deepEqual(vBody.versions.map((v) => v.id), [v2, v1])

      const restored = await fetch(`${base}/api/project-assets/${v1}/restore`, { method: 'POST', headers })
      assert.equal(restored.status, 200)
      const rBody = (await restored.json()) as { asset: Version; created: boolean }
      assert.equal(rBody.created, true)
      assert.equal(rBody.asset.digest, DIGEST_A)
      assert.equal(rBody.asset.url, `/api/media/${DIGEST_A}.md`)
      assert.equal(rBody.asset.containerPath, path)
      assert.notEqual(rBody.asset.id, v1)

      const after = (await (await fetch(`${base}/api/project-assets/${v1}/versions`, { headers })).json()) as { versions: Version[] }
      assert.deepEqual(after.versions.map((v) => v.id), [rBody.asset.id, v2, v1], 'restore never rewinds')

      // Restoring what is already newest is a no-op.
      const again = await fetch(`${base}/api/project-assets/${rBody.asset.id}/restore`, { method: 'POST', headers })
      assert.equal(((await again.json()) as { created: boolean }).created, false)

      // A version without a stored copy cannot be restored.
      const legacy = await fetch(`${base}/api/project-assets`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ source: 'output', name: 'legacy.md', containerPath: '/home/agent/.openclaude/generated/legacy.md' }),
      })
      const legacyId = ((await legacy.json()) as { asset: { id: string } }).asset.id
      assert.equal((await fetch(`${base}/api/project-assets/${legacyId}/restore`, { method: 'POST', headers })).status, 400)

      // Another tenant sees nothing.
      const otherJwt = signJwt({ userId: 'someone-else', exp: Math.floor(Date.now() / 1000) + 3600 }, TOKEN)
      const otherHeaders = { authorization: `Bearer ${otherJwt}` }
      const foreign = await fetch(`${base}/api/project-assets/${v1}/versions`, { headers: otherHeaders })
      assert.ok(foreign.status === 404 || foreign.status === 401 || foreign.status === 403, String(foreign.status))
      const foreignRestore = await fetch(`${base}/api/project-assets/${v1}/restore`, { method: 'POST', headers: otherHeaders })
      assert.ok(foreignRestore.status === 404 || foreignRestore.status === 401 || foreignRestore.status === 403)

      assert.equal((await fetch(`${base}/api/project-assets/${v1}/versions`, { method: 'POST', headers })).status, 405)
      assert.equal((await fetch(`${base}/api/project-assets/${v1}/restore`, { headers })).status, 405)
      assert.equal((await fetch(`${base}/api/project-assets/missing-asset-id/versions`, { headers })).status, 404)
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      )
    }
  })
})

after(() => {
  /* tmp home is process-scoped */
})
