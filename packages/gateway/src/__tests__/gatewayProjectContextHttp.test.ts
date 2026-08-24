/**
 * B1: context/memories/runs must enter handleTaskboardApi through Gateway.handleHttp.
 * Run: npx tsx --test packages/gateway/src/__tests__/gatewayProjectContextHttp.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'oc-gw-pctx-'))
process.env.OPENCLAUDE_HOME = home
process.env.OC_PROJECT_CONTEXT = '1'

const { Gateway } = await import('../server.js')
const { signJwt } = await import('../auth.js')
const { getTaskboardDb } = await import('../taskboard/db/index.js')
const { createProject } = await import('../taskboard/db/projects.js')
const { createTicket } = await import('../taskboard/db/tickets.js')
const { insertRun } = await import('../taskboard/db/runs.js')

const TOKEN = 'test-gateway-token-b1'
const jwt = signJwt({ userId: 'default', exp: Math.floor(Date.now() / 1000) + 3600 }, TOKEN)

describe('Gateway HTTP entry for project context routes', () => {
  it('routes context / preview / memories / run context through handleTaskboardApi', async () => {
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
    const db = getTaskboardDb()
    const project = createProject(db, { key: 'B1', name: 'b1' })
    const ticket = createTicket(db, {
      projectId: project.id,
      type: 'chore',
      title: 't',
      reporter: 'user:default',
    })
    const run = insertRun(db, {
      ticketId: ticket.id,
      stageId: ticket.stageId ?? 'none',
      trigger: 'patrol',
      agentId: 'stage-implement',
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
      const ctx = await fetch(`${base}/api/board/projects/${project.id}/context`, { headers })
      assert.equal(ctx.status, 200)
      const ctxBody = (await ctx.json()) as { version?: number }
      assert.equal(typeof ctxBody.version, 'number')
      assert.notEqual(ctx.headers.get('content-type')?.includes('text/html'), true)

      const preview = await fetch(`${base}/api/board/projects/${project.id}/context/preview`, {
        headers,
      })
      assert.equal(preview.status, 200)

      const mem = await fetch(`${base}/api/board/projects/${project.id}/memories`, { headers })
      assert.equal(mem.status, 200)

      const created = await fetch(`${base}/api/board/projects/${project.id}/memories`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          slug: 'notes.md',
          content: '---\nname: n\ndescription: d\ntype: project\n---\nhello\n',
        }),
      })
      assert.equal(created.status, 201)
      const createdBody = (await created.json()) as { candidate?: { id: string } }
      assert.ok(createdBody.candidate?.id)

      const runCtx = await fetch(`${base}/api/board/runs/${run.id}/context`, { headers })
      assert.equal(runCtx.status, 200)
      const runBody = (await runCtx.json()) as { runId?: string }
      assert.equal(runBody.runId, run.id)

      const agents = await fetch(`${base}/api/agents`, { headers })
      assert.equal(agents.status, 200)
      assert.notEqual(agents.headers.get('content-type')?.includes('text/html'), true)
      const agentsBody = (await agents.json()) as { agents?: unknown[] }
      assert.ok(Array.isArray(agentsBody.agents))

      const skills = await fetch(`${base}/api/skills`, { headers })
      assert.equal(skills.status, 200)
      const skillsBody = (await skills.json()) as { skills?: unknown }
      assert.ok(skillsBody.skills !== undefined)

      const agentSkills = await fetch(`${base}/api/agents/main/skills`, { headers })
      assert.equal(agentSkills.status, 200)

      const previewAgent = await fetch(
        `${base}/api/board/projects/${project.id}/context/preview?agentId=main`,
        { headers },
      )
      assert.equal(previewAgent.status, 200)
      const previewBody = (await previewAgent.json()) as { enabled?: boolean }
      assert.equal(typeof previewBody.enabled, 'boolean')

      const overlay = await fetch(`${base}/api/board/projects/${project.id}/context`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ expectedVersion: ctxBody.version ?? 0, skillNames: [] }),
      })
      assert.ok(overlay.status === 200 || overlay.status === 409)
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      )
    }
  })
})
