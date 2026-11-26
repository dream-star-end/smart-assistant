import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import {
  ARTIFACT_BLOB_INTERNAL_PREFIX,
  AUTHORITY_STATE_INTERNAL_PREFIX,
} from '@openclaude/protocol'
import {
  AuthorityStateBridge,
  PlacementEpochConflictError,
  RemoteArtifactBlobStore,
  RemoteSessionAuthorityStore,
  isAuthorityEndpointUnsupportedError,
  type LocalResumeStateEntry,
} from '../index.js'

function sha256(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex')
}

describe('OCV5-907 Wave 2: RemoteSessionAuthorityStore & RemoteArtifactBlobStore (R1 hardened)', () => {
  it('fails closed on HTTP 409 placement epoch conflict, fails open on 503, and identifies legacy Master 404 (W6)', async () => {
    const localMap = new Map<string, LocalResumeStateEntry>()
    let mode: 'ok' | 'conflict' | 'down' | 'legacy404' = 'ok'

    const remote = new RemoteSessionAuthorityStore({
      masterBaseUrl: 'http://127.0.0.1:18894',
      containerToken: 'oc-v3.1.secret',
      fetchImpl: async (url, init) => {
        assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer oc-v3.1.secret')
        assert.ok(url.includes(AUTHORITY_STATE_INTERNAL_PREFIX))
        if (mode === 'legacy404') {
          return new Response(JSON.stringify({ error: { code: 'NOT_FOUND' } }), { status: 404 })
        }
        if (mode === 'conflict') {
          return new Response(
            JSON.stringify({
              error: { code: 'SESSION_PLACEMENT_EPOCH_MISMATCH', message: 'conflict' },
            }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          )
        }
        if (mode === 'down') {
          return new Response(JSON.stringify({ error: { code: 'UNAVAILABLE' } }), { status: 503 })
        }
        const parsed = init?.body ? JSON.parse(String(init.body)) : {}
        // B2: Verify narrow PUT /pointer NEVER sends poolKind or promptCacheMeta
        assert.equal('poolKind' in parsed, false)
        assert.equal('promptCacheMeta' in parsed, false)
        return new Response(
          JSON.stringify({
            ok: true,
            pointer: {
              sessionKey: parsed.sessionKey,
              placementEpoch: 2,
              poolKind: 'remote_pool',
              engine: parsed.engine,
              nativeSessionId: parsed.nativeSessionId,
              history: parsed.history ?? [],
              rejectedIds: parsed.rejectedIds ?? [],
              promptCacheMeta: { pendingInstallMigration: { migrationId: 'mig-1' } },
              usageBaseline: null,
              historyContextVersion: null,
              promotedFromHistory: false,
              migrationState: 'active',
              activeMigrationId: null,
              updatedAt: new Date().toISOString(),
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      },
    })

    const bridge = new AuthorityStateBridge({
      tenantId: 'c:3',
      authorityStore: remote,
      localResumeStore: {
        get: (k) => localMap.get(k) ?? null,
        set: (k, e) => {
          localMap.set(k, e)
        },
      },
    })

    const okRes = await bridge.writePointer({
      sessionKey: 's1',
      placementEpoch: 2,
      expectedPlacementEpoch: 2,
      engine: 'codex',
      nativeSessionId: 'thr-1',
    })
    assert.equal(okRes.authorityDegraded, false)
    assert.equal(okRes.pointer.poolKind, 'remote_pool')

    mode = 'conflict'
    await assert.rejects(
      () =>
        bridge.writePointer({
          sessionKey: 's1',
          placementEpoch: 1,
          expectedPlacementEpoch: 1,
          engine: 'codex',
          nativeSessionId: 'thr-stale',
        }),
      (err: unknown) => err instanceof PlacementEpochConflictError,
    )
    assert.equal(localMap.get('s1')?.nativeSessionId, 'thr-1')

    mode = 'down'
    const degraded = await bridge.writePointer({
      sessionKey: 's1',
      placementEpoch: 2,
      expectedPlacementEpoch: 2,
      engine: 'codex',
      nativeSessionId: 'thr-local-fallback',
    })
    assert.equal(degraded.authorityDegraded, true)

    mode = 'legacy404'
    await assert.rejects(
      () => remote.getPointer('c:3', 's1'),
      (err: unknown) => isAuthorityEndpointUnsupportedError(err),
    )
  })

  it('W2 enforces deadline across slow response body reads and verifies x-blob-sha256 integrity', async () => {
    const clean = new Uint8Array(Buffer.from('authentic-capsule-bytes', 'utf8'))
    const tampered = new Uint8Array(Buffer.from('tampered!-capsule-bytes', 'utf8'))
    let mode: 'clean' | 'tampered' | 'slow-body' = 'clean'

    const client = new RemoteArtifactBlobStore({
      masterBaseUrl: 'http://127.0.0.1:18894',
      containerToken: 'oc-v3.1.secret',
      timeoutMs: 120,
      fetchImpl: async (url, init) => {
        assert.ok(url.includes(ARTIFACT_BLOB_INTERNAL_PREFIX))
        if (init?.method === 'GET' && url.endsWith('/blob-12345678')) {
          if (mode === 'slow-body') {
            // Headers arrive immediately, body stalls beyond timeoutMs (120ms)
            const stream = new ReadableStream<Uint8Array>({
              start(controller) {
                setTimeout(() => {
                  try {
                    controller.enqueue(new Uint8Array([1]))
                    controller.close()
                  } catch {
                    /* already cancelled */
                  }
                }, 400)
              },
            })
            return new Response(stream, { status: 200 })
          }
          return new Response(mode === 'tampered' ? tampered : clean, {
            status: 200,
            headers: { 'x-blob-sha256': sha256(clean) },
          })
        }
        return new Response(null, { status: 404 })
      },
    })

    assert.deepEqual(await client.getBytes('c:3', 'blob-12345678'), clean)

    mode = 'tampered'
    await assert.rejects(
      () => client.getBytes('c:3', 'blob-12345678'),
      /BLOB_CONTENT_INTEGRITY_MISMATCH/,
    )

    mode = 'slow-body'
    const t0 = Date.now()
    await assert.rejects(() => client.getBytes('c:3', 'blob-12345678'), /ARTIFACT_BLOB_TIMEOUT/)
    assert.ok(Date.now() - t0 < 350, 'timeout must abort slow body before 400ms stream completes')
  })
})
