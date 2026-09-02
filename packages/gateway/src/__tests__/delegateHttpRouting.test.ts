/**
 * Real HTTP listener proof for /api/agents/:id/delegate (server.ts routing).
 * Uses Gateway.handleHttp + listen + fetch — not a direct handleDelegateTask call.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/delegateHttpRouting.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

const PRODUCT_ENV = ['OC_MODEL_AUTHORITY', 'OC_SELFHOST_ENGINE_LOCAL_TURNS', 'OC_AGENT_ID'] as const
const saved: Record<string, string | undefined> = {}
before(() => {
  for (const key of PRODUCT_ENV) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
})
after(() => {
  for (const key of PRODUCT_ENV) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

const home = mkdtempSync(join(tmpdir(), 'oc-gw-dlg-http-'))
process.env.OPENCLAUDE_HOME = home

const { Gateway } = await import('../server.js')
const { signJwt } = await import('../auth.js')
const { DELEGATE_CONTEXT_HEADER, issueDelegateContextToken } = await import('../delegateContext.js')

const TOKEN = 'test-gateway-token-delegate-http'
const jwt = signJwt({ userId: 'default', exp: Math.floor(Date.now() / 1000) + 3600 }, TOKEN)

describe('Gateway HTTP /api/agents/:id/delegate routing', () => {
  async function withServer(
    fn: (base: string, headers: Record<string, string>) => Promise<void>,
  ): Promise<void> {
    const gw = new Gateway({
      config: {
        version: 1,
        gateway: { bind: '127.0.0.1', port: 0, accessToken: TOKEN },
        auth: { mode: 'subscription', claudeCodePath: '' },
        sessions: { dbPath: join(home, 'sessions.db') },
        defaults: { model: 'glm-5.2', permissionMode: 'default' },
        channels: { webchat: { enabled: true } },
      } as never,
      agentsConfig: {
        agents: [
          { id: 'main', model: 'glm-5.2' },
          { id: 'coding-assistant', model: 'glm-5.2' },
        ],
        routes: [],
        default: 'main',
      },
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
      await fn(base, headers)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
    }
  }

  it('POST unknown explicit slug returns 400 DELEGATE_MODEL_UNKNOWN without a job', async () => {
    await withServer(async (base, headers) => {
      const res = await fetch(`${base}/api/agents/coding-assistant/delegate`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          goal: 'listener unknown slug',
          model: 'definitely-not-a-model',
          sourceAgent: 'main',
        }),
      })
      const body = (await res.json()) as { code?: string; error?: string; jobId?: string }
      assert.equal(res.status, 400)
      assert.equal(body.code, 'DELEGATE_MODEL_UNKNOWN')
      assert.match(String(body.error), /unknown explicit delegate model|DELEGATE_MODEL_UNKNOWN/)
      assert.equal(body.jobId, undefined)
    })
  })

  it('async POST without delegate context is 401; signed context is not that 401', async () => {
    await withServer(async (base, headers) => {
      const missing = await fetch(`${base}/api/agents/coding-assistant/delegate`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ goal: 'async needs context', async: true, sourceAgent: 'main' }),
      })
      const missingBody = (await missing.json()) as { error?: string; jobId?: string }
      assert.equal(missing.status, 401)
      assert.match(String(missingBody.error), /async delegate requires delegate context/)
      assert.equal(missingBody.jobId, undefined)

      const token = issueDelegateContextToken({
        agentId: 'main',
        sessionKey: 'agent:main:webchat:dm:listener',
        depth: 0,
      })
      const authed = await fetch(`${base}/api/agents/coding-assistant/delegate`, {
        method: 'POST',
        headers: { ...headers, [DELEGATE_CONTEXT_HEADER]: token },
        body: JSON.stringify({ goal: 'async with context', async: true, sourceAgent: 'main' }),
      })
      const authedBody = (await authed.json()) as { error?: string; jobId?: string; status?: string }
      assert.notEqual(authed.status, 401)
      assert.notEqual(authedBody.error, 'async delegate requires delegate context')
      assert.equal(typeof authedBody.jobId, 'string')
    })
  })
})
