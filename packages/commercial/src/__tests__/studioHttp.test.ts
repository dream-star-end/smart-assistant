/**
 * OCV5-591 A1 media studio browser surface without Postgres: access gate (D13), blob tickets,
 * byte ranges and route dispatch over fake store / blob deps.
 */
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { type Server, createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { signAccess } from '../auth/jwt.js'
import {
  createBlobTicket,
  parseByteRange,
  studioAccess,
  verifyBlobTicket,
} from '../media-studio/access.js'
import type { StudioBlobStore } from '../media-studio/blobs.js'
import { type StudioHttpDeps, dispatchStudioRoute } from '../media-studio/http.js'
import type { OrchestratorApi } from '../media-studio/orchestrator/service.js'
import type { StudioStore } from '../media-studio/store.js'

const SECRET = 'studio-test-secret-that-is-long-enough-123'
const SHA = 'a'.repeat(64)
const PROJECT = '11111111-2222-4333-8444-555555555555'

describe('studioAccess (D13)', () => {
  it('is closed unless enabled, then admits admins and listed uids, never uid 4 via the list', () => {
    assert.equal(studioAccess({}).allows({ id: '1', role: 'admin' }), false)
    const warned: unknown[] = []
    const a = studioAccess(
      { OC_STUDIO_ENABLED: true, OC_STUDIO_ALLOWED_UIDS: ['247', '4'] },
      (_m, meta) => warned.push(meta),
    )
    assert.equal(a.allows({ id: '247', role: 'user' }), true)
    assert.equal(a.allows({ id: '4', role: 'user' }), false)
    assert.equal(a.allows({ id: '3', role: 'user' }), false)
    assert.equal(a.allows({ id: '9', role: 'admin' }), true)
    assert.deepEqual(warned, [{ uid: '4' }])
    const none = studioAccess({ OC_STUDIO_ENABLED: true })
    assert.equal(none.allows({ id: '247', role: 'user' }), false)
    assert.equal(
      studioAccess({ OC_STUDIO_ENABLED: true, OC_STUDIO_ALLOWED_UIDS: ['all'] }).allows({
        id: '5',
      }),
      true,
    )
  })
})

describe('blob tickets', () => {
  it('round-trips, binds the sha, expires and rejects tampering', () => {
    const now = 1_800_000_000
    const t = createBlobTicket(SECRET, '247', SHA, now)
    assert.equal(verifyBlobTicket(SECRET, t, SHA, now + 10), '247')
    assert.throws(() => verifyBlobTicket(SECRET, t, 'b'.repeat(64), now), { status: 401 })
    assert.throws(() => verifyBlobTicket(SECRET, t, SHA, now + 15 * 60), { status: 401 })
    assert.throws(() => verifyBlobTicket('other-secret-other-secret-other', t, SHA, now), {
      status: 401,
    })
    const [payload, sig] = t.split('.')
    const forged = Buffer.from(JSON.stringify({ u: '1', s: SHA, e: now + 999 })).toString(
      'base64url',
    )
    assert.throws(() => verifyBlobTicket(SECRET, `${forged}.${sig}`, SHA, now), { status: 401 })
    assert.throws(() => verifyBlobTicket(SECRET, `${payload}.${sig}.x`, SHA, now), { status: 401 })
  })
})

describe('parseByteRange', () => {
  it('handles open, closed, suffix and clamped ranges; rejects the unsatisfiable', () => {
    assert.equal(parseByteRange(undefined, 10), null)
    assert.deepEqual(parseByteRange('bytes=0-3', 10), { start: 0, end: 3 })
    assert.deepEqual(parseByteRange('bytes=4-', 10), { start: 4, end: 9 })
    assert.deepEqual(parseByteRange('bytes=-3', 10), { start: 7, end: 9 })
    assert.deepEqual(parseByteRange('bytes=5-99', 10), { start: 5, end: 9 })
    for (const bad of [
      'bytes=10-',
      'bytes=5-2',
      'bytes=-0',
      'bytes=-',
      'items=0-1',
      'bytes=0-1,3-4',
    ]) {
      assert.throws(() => parseByteRange(bad, 10), { status: 416 }, bad)
    }
  })
})

describe('dispatchStudioRoute', () => {
  let server: Server
  let base = ''
  let enabled = true
  let orchestrator: OrchestratorApi | undefined
  const calls: string[] = []
  let filePath = ''
  const fileBody = Buffer.from('0123456789')

  const store = {
    listProjects: async (uid: string) => {
      calls.push(`list:${uid}`)
      return { projects: [], next: null }
    },
    createProject: async (uid: string, body: Record<string, unknown>) => {
      calls.push(`create:${uid}:${body.title}`)
      return { id: PROJECT }
    },
    projectView: async (uid: string, id: string) =>
      uid === '247' && id === PROJECT ? { project: { id } } : null,
    projectOwned: async (uid: string) => uid === '247',
    transition: async (uid: string, id: string, action: string) => {
      calls.push(`transition:${uid}:${action}`)
      return { id }
    },
    addUploadAsset: async (
      _uid: string,
      _p: string,
      input: { assetId: string; blobSha: string },
    ) => ({
      id: input.assetId,
      blobSha: input.blobSha,
    }),
  } as unknown as StudioStore
  const blobs = {
    open: async (uid: bigint, sha: string) =>
      uid === 247n && sha === SHA
        ? { path: filePath, bytes: fileBody.length, mime: 'video/mp4', sha }
        : null,
    put: async (args: { mime: string; maxBytes: number }) => {
      calls.push(`put:${args.mime}:${args.maxBytes}`)
      return { sha: SHA, bytes: args.maxBytes, mime: args.mime, newForUser: true }
    },
    dropRefs: async () => 0,
  } as unknown as StudioBlobStore

  before(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-studio-http-'))
    filePath = path.join(dir, 'blob')
    await writeFile(filePath, fileBody)
    server = createServer((req, res) => {
      const deps: StudioHttpDeps = {
        access: studioAccess({ OC_STUDIO_ENABLED: enabled, OC_STUDIO_ALLOWED_UIDS: ['247'] }),
        store,
        blobs,
        ...(orchestrator ? { orchestrator } : {}),
      }
      void dispatchStudioRoute(req, res, {} as never, { jwtSecret: SECRET, studio: deps }).catch(
        (error) => {
          if (res.headersSent) return res.destroy()
          res.statusCode = typeof error?.status === 'number' ? error.status : 500
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ error: error?.code ?? 'INTERNAL' }))
        },
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    base = `http://127.0.0.1:${address.port}/api/studio`
  })
  after(() => new Promise<void>((resolve) => server.close(() => resolve())))

  const bearer = async (sub: string, role: 'user' | 'admin' = 'user') =>
    `Bearer ${(await signAccess({ sub, role }, SECRET)).token}`

  it('hides itself: disabled → 404 even for the allowed user; others → 404, not 403', async () => {
    enabled = false
    assert.equal(
      (await fetch(`${base}/projects`, { headers: { authorization: await bearer('247') } })).status,
      404,
    )
    enabled = true
    assert.equal((await fetch(`${base}/projects`)).status, 401)
    assert.equal(
      (await fetch(`${base}/projects`, { headers: { authorization: await bearer('3') } })).status,
      404,
    )
    const ok = await fetch(`${base}/projects`, { headers: { authorization: await bearer('247') } })
    assert.equal(ok.status, 200)
    assert.equal(
      (await fetch(`${base}/projects`, { headers: { authorization: await bearer('9', 'admin') } }))
        .status,
      200,
    )
  })

  it('GET /providers: same gate; without a registry every kind reads as not configured (A2-0)', async () => {
    enabled = false
    assert.equal(
      (await fetch(`${base}/providers`, { headers: { authorization: await bearer('247') } }))
        .status,
      404,
    )
    enabled = true
    assert.equal((await fetch(`${base}/providers`)).status, 401)
    assert.equal(
      (await fetch(`${base}/providers`, { headers: { authorization: await bearer('3') } })).status,
      404,
    )
    const ok = await fetch(`${base}/providers`, { headers: { authorization: await bearer('247') } })
    assert.equal(ok.status, 200)
    const view = (await ok.json()) as {
      kinds: Array<{ kind: string; state: string; reason?: string }>
    }
    assert.deepEqual(
      view.kinds.map((k) => [k.kind, k.state, k.reason]),
      [
        ['image', 'unconfigured', 'NO_PROVIDER'],
        ['video', 'unconfigured', 'NO_PROVIDER'],
        ['voice', 'unconfigured', 'NO_PROVIDER'],
        ['music', 'unconfigured', 'NO_PROVIDER'],
      ],
    )
  })

  it('creates and reads projects; another user sees 404', async () => {
    const auth = await bearer('247')
    const created = await fetch(`${base}/projects`, {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Lighthouse' }),
    })
    assert.equal(created.status, 201)
    assert.ok(calls.includes('create:247:Lighthouse'))
    assert.equal(
      (await fetch(`${base}/projects/${PROJECT}`, { headers: { authorization: auth } })).status,
      200,
    )
    assert.equal(
      (
        await fetch(`${base}/projects/${PROJECT}`, {
          headers: { authorization: await bearer('9', 'admin') },
        })
      ).status,
      404,
    )
  })

  it('director routes (A2-1a): 503 while the orchestrator is off, then reach it as the caller', async () => {
    const auth = await bearer('247')
    const post = (p: string, body?: unknown, who = auth) =>
      fetch(`${base}${p}`, {
        method: 'POST',
        headers: { authorization: who, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    const TAKE = '22222222-3333-4444-8555-666666666666'
    const ASSET = '33333333-4444-4555-8666-777777777777'
    const routes = [
      `/projects/${PROJECT}/start`,
      `/projects/${PROJECT}/approve`,
      `/projects/${PROJECT}/voices`,
      `/takes/${TAKE}/select`,
      `/assets/${ASSET}/narration`,
    ]
    orchestrator = undefined
    for (const r of routes) {
      const res = await post(r, {})
      assert.equal(res.status, 503, r)
      assert.equal(((await res.json()) as { error: string }).error, 'STUDIO_ORCHESTRATOR_OFF')
    }

    const seen: string[] = []
    orchestrator = {
      start: async (uid, id) => void seen.push(`start:${uid}:${id}`),
      approve: async (uid, id) => void seen.push(`approve:${uid}:${id}`),
      selectTake: async (uid, id) => {
        seen.push(`select:${uid}:${id}`)
        return { projectId: PROJECT }
      },
      createVoice: async (uid, id, body) => {
        seen.push(`voice:${uid}:${id}:${body.mode}:${body.name}`)
        return { assetId: ASSET }
      },
      useVoiceForNarration: async (uid, id) => {
        seen.push(`narration:${uid}:${id}`)
        return { projectId: PROJECT }
      },
      kick: (id) => void seen.push(`kick:${id}`),
    }
    try {
      for (const r of [`/projects/${PROJECT}/start`, `/projects/${PROJECT}/approve`]) {
        const res = await post(r)
        assert.equal(res.status, 200, r)
        assert.deepEqual(await res.json(), { project: { id: PROJECT } })
      }
      const voice = await post(`/projects/${PROJECT}/voices`, { mode: 'design', name: '旁白' })
      assert.equal(voice.status, 201)
      assert.deepEqual(await voice.json(), { assetId: ASSET })
      assert.equal((await post(`/takes/${TAKE}/select`)).status, 200)
      assert.equal((await post(`/assets/${ASSET}/narration`)).status, 200)
      assert.equal((await post(`/projects/${PROJECT}/resume`)).status, 200)
      assert.deepEqual(seen, [
        `start:247:${PROJECT}`,
        `approve:247:${PROJECT}`,
        `voice:247:${PROJECT}:design:旁白`,
        `select:247:${TAKE}`,
        `narration:247:${ASSET}`,
        `kick:${PROJECT}`,
      ])
      // Outside the allow-list the gate answers 404 before the orchestrator is touched.
      assert.equal(
        (await post(`/projects/${PROJECT}/start`, undefined, await bearer('3'))).status,
        404,
      )
      assert.equal(seen.length, 6)
    } finally {
      orchestrator = undefined
    }
  })

  it('issues a ticket only for a blob the user references, then serves byte ranges with it', async () => {
    const auth = await bearer('247')
    assert.equal(
      (
        await fetch(`${base}/blobs/${'b'.repeat(64)}/ticket`, {
          method: 'POST',
          headers: { authorization: auth },
        })
      ).status,
      404,
    )
    const issued = await fetch(`${base}/blobs/${SHA}/ticket`, {
      method: 'POST',
      headers: { authorization: auth },
    })
    assert.equal(issued.status, 200)
    const { url } = (await issued.json()) as { url: string }
    const origin = base.replace('/api/studio', '')
    const whole = await fetch(`${origin}${url}`)
    assert.equal(whole.status, 200)
    assert.equal(await whole.text(), '0123456789')
    const part = await fetch(`${origin}${url}`, { headers: { range: 'bytes=2-4' } })
    assert.equal(part.status, 206)
    assert.equal(part.headers.get('content-range'), 'bytes 2-4/10')
    assert.equal(await part.text(), '234')
    const bad = await fetch(`${origin}${url}`, { headers: { range: 'bytes=20-' } })
    assert.equal(bad.status, 416)
    assert.equal((await fetch(`${base}/blobs/${SHA}`)).status, 401)
  })

  it('accepts only uploads whose bytes match their declared image/audio type', async () => {
    const auth = await bearer('247')
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(16),
    ])
    const up = (type: string, body: Buffer) =>
      fetch(`${base}/projects/${PROJECT}/uploads`, {
        method: 'POST',
        headers: {
          authorization: auth,
          'content-type': type,
          'x-filename': encodeURIComponent('参考图.png'),
        },
        body: new Uint8Array(body),
      })
    const ok = await up('image/png', png)
    assert.equal(ok.status, 201)
    assert.ok(calls.includes(`put:image/png:${png.length}`))
    assert.equal((await up('image/jpeg', png)).status, 415)
    assert.equal((await up('text/html', png)).status, 415)
  })
})
