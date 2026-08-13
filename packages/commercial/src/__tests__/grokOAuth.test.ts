/**
 * Grok OAuth refresh transaction and xAI endpoint contract.
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/grokOAuth.test.ts
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  GROK_OAUTH_CLIENT_ID,
  GROK_OAUTH_TOKEN_ENDPOINT,
  GrokOAuthRefreshError,
  getFreshGrokAccessToken,
} from '../account-pool/grokOAuth.js'

describe('getFreshGrokAccessToken', () => {
  test('serializes refresh, uses the account dispatcher and persists a rotated refresh token', async () => {
    const sql: string[] = []
    let released = false
    const client = {
      async query(statement: string) { sql.push(statement); return { rows: [], rowCount: 0 } },
      release() { released = true },
    }
    const oldToken = Buffer.from('expired-access', 'utf8')
    const oldRefresh = Buffer.from('old-refresh', 'utf8')
    const dispatcher = { name: 'bound-grok-proxy' } as never
    let requestUrl = ''
    let requestBody = ''
    let requestDispatcher: unknown
    const updatedPatches: Array<Record<string, unknown>> = []
    const result = await getFreshGrokAccessToken(53n, {
      now: () => Date.parse('2026-08-12T00:00:00.000Z'),
      pool: { connect: async () => client } as never,
      getSnapshot: async () => ({
        id: 53n,
        token: oldToken,
        refresh: oldRefresh,
        expires_at: new Date('2026-08-11T00:00:00.000Z'),
        principal_type: 'Team',
        principal_id: 'team-123',
      }),
      resolveDispatcher: async (id) => {
        assert.equal(id, 53n)
        return { dispatcher }
      },
      requestFn: (async (
        url: Parameters<typeof import('undici').request>[0],
        init: Parameters<typeof import('undici').request>[1],
      ) => {
        assert.ok(init)
        requestUrl = String(url)
        requestBody = String(init.body)
        requestDispatcher = init.dispatcher
        return {
          statusCode: 200,
          body: { text: async () => JSON.stringify({
            access_token: 'fresh-access',
            refresh_token: 'rotated-refresh',
            expires_in: 7200,
          }) },
        }
      }) as never,
      updateSnapshot: async (_db, id, patch) => {
        assert.equal(id, 53n)
        updatedPatches.push(patch as unknown as Record<string, unknown>)
        return true
      },
    })

    assert.equal(result.toString('utf8'), 'fresh-access')
    assert.equal(requestUrl, 'https://auth.x.ai/oauth2/token')
    assert.equal(GROK_OAUTH_TOKEN_ENDPOINT, requestUrl)
    assert.strictEqual(requestDispatcher, dispatcher)
    const form = new URLSearchParams(requestBody)
    assert.equal(form.get('grant_type'), 'refresh_token')
    assert.equal(form.get('refresh_token'), 'old-refresh')
    assert.equal(form.get('client_id'), GROK_OAUTH_CLIENT_ID)
    assert.equal(form.get('principal_type'), 'Team')
    assert.equal(form.get('principal_id'), 'team-123')
    const updated = updatedPatches[0]
    assert.ok(updated)
    assert.equal(updated.token, 'fresh-access')
    assert.equal(updated.refresh, 'rotated-refresh')
    assert.equal((updated.expires_at as Date).toISOString(), '2026-08-12T02:00:00.000Z')
    assert.ok(sql[0]?.includes('BEGIN'))
    assert.ok(sql[1]?.includes('pg_advisory_xact_lock'))
    assert.ok(sql.at(-1)?.includes('COMMIT'))
    assert.equal(released, true)
    assert.ok(oldToken.every((byte) => byte === 0))
    assert.ok(oldRefresh.every((byte) => byte === 0))
  })

  test('disables a terminal invalid_grant account after rollback so the pool can fail over', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = []
    const client = {
      async query(sql: string, params?: unknown[]) {
        calls.push({ sql, ...(params ? { params } : {}) })
        return { rows: [], rowCount: 1 }
      },
      release() {},
    }
    await assert.rejects(
      getFreshGrokAccessToken(53n, {
        pool: { connect: async () => client } as never,
        getSnapshot: async () => ({
          id: 53n,
          token: Buffer.from('expired-access'),
          refresh: Buffer.from('revoked-refresh'),
          expires_at: new Date(0),
          principal_type: null,
          principal_id: null,
        }),
        resolveDispatcher: async () => ({ dispatcher: {} as never }),
        requestFn: (async () => ({
          statusCode: 400,
          body: { text: async () => '{"error":"invalid_grant"}' },
        })) as never,
      }),
      (err: unknown) => err instanceof GrokOAuthRefreshError && err.terminal,
    )
    const rollback = calls.findIndex(({ sql }) => sql === 'ROLLBACK')
    const disable = calls.findIndex(({ sql }) => sql.includes("SET status = 'disabled'"))
    assert.ok(rollback >= 0)
    assert.ok(disable > rollback)
    assert.deepEqual(calls[disable]?.params, ['53', 'GROK_OAUTH_REFRESH_FAILED:400:invalid_grant'])
  })
})
