import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { hashSecret, type ContainerIdentityRepo } from '../auth/containerIdentity.js'
import { makeDelegateTraceHandler } from '../http/internalDelegateTrace.js'
import { createLogger } from '../logging/logger.js'

const fixtureSecret = 'ab'.repeat(32)
const parent = 'a'.repeat(32)
const body = {
  sessionKey: 'agent:coding-assistant:delegate:main:proof',
  agentId: 'coding-assistant',
  delegateRunId: 'dlg-proof',
  parentTraceId: parent,
}

async function call(
  options: {
    auth?: boolean
    owned?: boolean
    raw?: string
    method?: string
    insert?: () => Promise<void>
  } = {},
) {
  const sql: Array<{ text: string; values: unknown[] }> = []
  const logs: Array<Record<string, unknown>> = []
  const pool = {
    async query(config: { text: string; values: unknown[] }) {
      sql.push(config)
      if (config.text.startsWith('SELECT'))
        return { rows: options.owned === false ? [] : [{ trace_id: parent }] }
      assert.match(config.text, /^INSERT INTO turn_traces/)
      await options.insert?.()
      return { rows: [], rowCount: 1 }
    },
  } as unknown as Pool
  const identityRepo: ContainerIdentityRepo = {
    async findActiveByHostAndBoundIp() {
      return {
        id: 7,
        user_id: 765,
        bound_ip: '172.30.0.7',
        host_uuid: 'proof-host',
        secret_hash: hashSecret(fixtureSecret),
      }
    },
  }
  const req = Readable.from([
    options.raw ?? JSON.stringify({ ...body, userId: 247, traceId: 'f'.repeat(32) }),
  ]) as unknown as IncomingMessage
  Object.assign(req, {
    method: options.method ?? 'POST',
    headers: {
      ...(options.auth === false ? {} : { authorization: `Bearer oc-v3.7.${fixtureSecret}` }),
    },
  })
  let status = 0
  let response = ''
  const res = {
    set statusCode(v: number) {
      status = v
    },
    setHeader() {},
    end(v: string) {
      response = v
    },
  } as unknown as ServerResponse
  const handler = makeDelegateTraceHandler({
    pool,
    identityRepo,
    log: createLogger({ level: 'debug', out: (line) => logs.push(JSON.parse(line)) }),
  })
  await handler(req, res, { hostUuid: 'proof-host', boundIp: '172.30.0.7' })
  return { status, json: JSON.parse(response), sql, logs }
}

test('master mints a canonical child after durable ACK and only uses verified uid', async () => {
  let release!: () => void
  let inserted!: () => void
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    inserted = resolve
  })
  let completed = false
  const pending = call({
    insert: async () => {
      inserted()
      await barrier
    },
  }).then((value) => {
    completed = true
    return value
  })
  await started
  assert.equal(completed, false)
  release()
  const result = await pending
  assert.equal(result.status, 200)
  assert.match(result.json.traceId, /^[0-9a-f]{32}$/)
  assert.notEqual(result.json.traceId, 'f'.repeat(32))
  assert.equal(result.json.parentTraceId, parent)
  assert.deepEqual(result.sql[0]!.values, [parent, 765])
  assert.equal(result.sql[1]!.values[1], '765')
  assert.equal(result.logs[0]!.traceId, result.json.traceId)
  assert.equal(result.logs[0]!.parentTraceId, parent)
})

test('cross-user or missing parent never writes a child', async () => {
  const result = await call({ owned: false })
  assert.equal(result.status, 403)
  assert.equal(result.sql.length, 1)
})

test('legacy parent absence is explicit; insert failures never ACK a canonical', async () => {
  const legacy = await call({ raw: JSON.stringify({ ...body, parentTraceId: undefined }) })
  assert.equal(legacy.status, 200)
  assert.equal(legacy.sql.length, 1)
  assert.equal(legacy.logs[0]!.parentTraceIdMissing, 'legacy-parent-context')
  const failed = await call({
    insert: async () => {
      throw new Error('private db detail')
    },
  })
  assert.equal(failed.status, 503)
  assert.equal(failed.json.traceId, undefined)
  assert.equal(JSON.stringify(failed).includes('private db detail'), false)
})

test('auth, method and bounded body validation stop before trace SQL', async () => {
  for (const [options, status] of [
    [{ auth: false }, 401],
    [{ method: 'GET' }, 405],
    [{ raw: '[]' }, 400],
    [{ raw: 'x'.repeat(8193) }, 400],
    [{ raw: JSON.stringify({ ...body, parentTraceId: 'wrong' }) }, 400],
  ] as const) {
    const result = await call(options)
    assert.equal(result.status, status)
    assert.equal(result.sql.length, 0)
  }
})
