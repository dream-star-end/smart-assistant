/**
 * Unit tests for async filesystem reads in workspaceApi routes (GET /api/changelog, GET /api/feedback).
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/workspaceApiAsyncRoutes.test.ts
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import type { WorkspaceApiRoutesIo } from '../routes/workspaceApi.js'

const home = await mkdtemp(join(tmpdir(), 'oc-workspace-api-async-'))
process.env.OPENCLAUDE_HOME = home

const { dispatchRoutes } = await import('../routes/routeTable.js')
const { WORKSPACE_API_ROUTES } = await import('../routes/workspaceApi.js')

after(async () => {
  await rm(home, { recursive: true, force: true })
})

function dispatchAndWaitJson(
  method: string,
  pathname: string,
  userId = 'u1',
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const io = {
      getUserId: () => userId,
      sendJson: (_res: ServerResponse, status: number, body: unknown) => {
        resolve({ status, body })
      },
      sendInternalError: (_res: ServerResponse, err: unknown) => {
        reject(err)
      },
    } as unknown as WorkspaceApiRoutesIo

    const matched = dispatchRoutes(
      WORKSPACE_API_ROUTES,
      io,
      { method, headers: {} } as IncomingMessage,
      {} as ServerResponse,
      new URL(pathname, 'http://gateway.test'),
    )
    if (!matched) reject(new Error(`route not matched: ${method} ${pathname}`))
  })
}

describe('workspaceApi async fs routes', () => {
  it('GET /api/changelog falls back cleanly when missing and reads asynchronously when present', async () => {
    const missing = await dispatchAndWaitJson('GET', '/api/changelog')
    assert.equal(missing.status, 200)
    assert.deepEqual(missing.body, { currentVersion: '0.0.0', releases: [] })

    const payload = { currentVersion: '5.1.0', releases: [{ version: '5.1.0', notes: ['async'] }] }
    await writeFile(join(home, 'changelog.json'), JSON.stringify(payload))

    const present = await dispatchAndWaitJson('GET', '/api/changelog')
    assert.equal(present.status, 200)
    assert.deepEqual(present.body, payload)
  })

  it('GET /api/feedback returns empty list when missing, filters by userId, and skips corrupt JSON', async () => {
    const empty = await dispatchAndWaitJson('GET', '/api/feedback', 'u1')
    assert.equal(empty.status, 200)
    assert.deepEqual(empty.body, { feedback: [] })

    const fbDir = join(home, 'feedback')
    await mkdir(fbDir, { recursive: true })
    await writeFile(
      join(fbDir, 'fb-1.json'),
      JSON.stringify({ id: 'fb-1', userId: 'u1', description: 'first' }),
    )
    await writeFile(
      join(fbDir, 'fb-2.json'),
      JSON.stringify({ id: 'fb-2', userId: 'u2', description: 'other user' }),
    )
    await writeFile(join(fbDir, 'fb-3.json'), '{not-valid-json')
    await writeFile(
      join(fbDir, 'fb-4.json'),
      JSON.stringify({ id: 'fb-4', userId: 'u1', description: 'second' }),
    )

    const res = await dispatchAndWaitJson('GET', '/api/feedback', 'u1')
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, {
      feedback: [
        { id: 'fb-4', userId: 'u1', description: 'second' },
        { id: 'fb-1', userId: 'u1', description: 'first' },
      ],
    })
  })
})
