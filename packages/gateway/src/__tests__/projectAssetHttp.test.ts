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

after(() => {
  /* tmp home is process-scoped */
})
