/**
 * Unit tests for /internal/v3/agent-audit/tool-failure.
 * Run: npx tsx --test packages/commercial/src/__tests__/internalToolFailureAudit.test.ts
 */

import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, test } from 'node:test'

import { hashSecret, type ContainerIdentityRepo } from '../auth/containerIdentity.js'
import {
  TOOL_FAILURE_AUDIT_PATH,
  insertToolFailureAudit,
  makeToolFailureAuditHandler,
  type QueryRunner,
  type ToolFailureAuditBody,
} from '../http/internalToolFailureAudit.js'

const SECRET = 'a'.repeat(64)
const TOKEN = `oc-v3.7.${SECRET}`
const CTX = { hostUuid: 'host-1', boundIp: '172.31.0.7' }

function repoFor(userId = 42): ContainerIdentityRepo {
  return {
    async findActiveByHostAndBoundIp(hostUuid, boundIp) {
      if (hostUuid !== CTX.hostUuid || boundIp !== CTX.boundIp) return null
      return {
        id: 7,
        user_id: userId,
        bound_ip: boundIp,
        host_uuid: hostUuid,
        secret_hash: hashSecret(SECRET),
      }
    },
  }
}

function body(overrides: Partial<ToolFailureAuditBody> = {}): ToolFailureAuditBody {
  return {
    schemaVersion: 1,
    eventId: 'evt-1',
    sessionKey: 'agent:codex:webchat:dm:sess1',
    agentId: 'codex',
    turnIndex: 3,
    toolName: 'Bash',
    durationMs: 12,
    inputPreview: '{"cmd":"bad"}',
    outputPreview: 'failed',
    timestamp: 123,
    ...overrides,
  }
}

function makeReq(opts: { method?: string; auth?: string; body?: unknown }): IncomingMessage {
  const raw = opts.body === undefined ? '' : JSON.stringify(opts.body)
  const req = Readable.from(raw ? [Buffer.from(raw)] : []) as unknown as IncomingMessage
  req.method = opts.method ?? 'POST'
  req.url = TOOL_FAILURE_AUDIT_PATH
  req.headers = {}
  if (opts.auth) req.headers.authorization = opts.auth
  return req
}

function makeRes(): ServerResponse & { body: any } {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string | number>,
    setHeader(k: string, v: string | number) { this.headers[k.toLowerCase()] = v },
    end(s?: string) { ;(this as any).body = s ? JSON.parse(s) : {} },
  }
  return res as unknown as ServerResponse & { body: any }
}

function fakeResult(rows: any[] = []) {
  return { rows, rowCount: rows.length }
}

describe('insertToolFailureAudit', () => {
  test('inserts failed audit row and best-effort dedupes by event id', async () => {
    const calls: Array<{ sql: string; params?: readonly unknown[] }> = []
    const runner: QueryRunner = {
      async query(sql, params) {
        calls.push({ sql, params })
        return calls.length === 1 ? fakeResult([]) : fakeResult([])
      },
    }
    assert.deepEqual(await insertToolFailureAudit(runner, 42, body()), { duplicate: false })
    assert.equal(calls.length, 2)
    assert.match(calls[1].sql, /INSERT INTO agent_audit/)
    assert.equal(calls[1].params?.[0], 42)
    assert.equal(calls[1].params?.[1], body().sessionKey)
    assert.equal(calls[1].params?.[2], 'Bash')
    assert.equal(calls[1].params?.[6], 12)
    assert.equal(calls[1].params?.[7], 'failed')

    const dupRunner: QueryRunner = { async query() { return fakeResult([{ id: '99' }]) } }
    assert.deepEqual(await insertToolFailureAudit(dupRunner, 42, body()), { duplicate: true })
  })
})

describe('tool failure audit handler', () => {
  test('rejects missing bearer and non-POST', async () => {
    const h = makeToolFailureAuditHandler({ identityRepo: repoFor(), queryRunner: { async query() { return fakeResult([]) } } })
    let res = makeRes()
    await h(makeReq({ auth: `Bearer ${TOKEN}`, method: 'GET', body: body() }), res, CTX)
    assert.equal(res.statusCode, 405)

    res = makeRes()
    await h(makeReq({ body: body() }), res, CTX)
    assert.equal(res.statusCode, 401)
  })

  test('valid report inserts and duplicate returns ok', async () => {
    let selectRows: any[] = []
    const runner: QueryRunner = {
      async query(sql) {
        return /SELECT/.test(sql) ? fakeResult(selectRows) : fakeResult([])
      },
    }
    const h = makeToolFailureAuditHandler({ identityRepo: repoFor(99), queryRunner: runner })
    let res = makeRes()
    await h(makeReq({ auth: `Bearer ${TOKEN}`, body: body() }), res, CTX)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.ok, true)
    assert.equal(res.body.duplicate, false)

    selectRows = [{ id: '1' }]
    res = makeRes()
    await h(makeReq({ auth: `Bearer ${TOKEN}`, body: body() }), res, CTX)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.duplicate, true)
  })

  test('invalid body returns 400', async () => {
    const h = makeToolFailureAuditHandler({ identityRepo: repoFor(), queryRunner: { async query() { return fakeResult([]) } } })
    const res = makeRes()
    await h(makeReq({ auth: `Bearer ${TOKEN}`, body: { schemaVersion: 1, eventId: '' } }), res, CTX)
    assert.equal(res.statusCode, 400)
  })
})
