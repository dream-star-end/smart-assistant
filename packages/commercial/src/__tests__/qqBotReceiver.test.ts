import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pool } from 'pg'

import type { ContainerIdentityRepo } from '../auth/containerIdentity.js'
import { makeQqOutboundReceiver } from '../qqbot/receiver.js'

const SECRET = 'a'.repeat(64)
const OPENID = 'qq-openid-1'
const BINDING_VERSION = 'b'.repeat(32)

function makeRepo(): ContainerIdentityRepo {
  const secretHash = createHash('sha256').update(Buffer.from(SECRET, 'hex')).digest()
  return {
    async findActiveByHostAndBoundIp() {
      return {
        id: 7,
        user_id: 42,
        bound_ip: '172.31.0.7',
        host_uuid: 'host-1',
        secret_hash: secretHash,
      }
    },
  }
}

function makePool(): { pool: Pool; inserted: string[] } {
  const inserted: string[] = []
  const query = async (sql: string): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> => {
    if (/FROM qq_bot_bindings/.test(sql)) {
      return {
        rows: [{
          user_id: '42',
          bot_openid: OPENID,
          binding_version: BINDING_VERSION,
          bound_at: '1',
          last_interaction_at: '1',
        }],
        rowCount: 1,
      }
    }
    if (/INSERT INTO qq_outbox/.test(sql)) {
      inserted.push(sql)
      return { rows: [], rowCount: 1 }
    }
    if (/SELECT id, status FROM qq_outbox/.test(sql)) {
      return { rows: [{ id: '9', status: 'queued' }], rowCount: 1 }
    }
    if (/DELETE FROM qq_running_sessions/.test(sql)) {
      return { rows: [], rowCount: 1 }
    }
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim())) {
      return { rows: [], rowCount: 0 }
    }
    throw new Error(`unexpected SQL: ${sql}`)
  }
  const client = { query, release() {} }
  return {
    pool: {
      query,
      async connect() {
        return client
      },
    } as unknown as Pool,
    inserted,
  }
}

function makeReq(body: unknown): IncomingMessage {
  const req = Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage
  req.method = 'POST'
  req.headers = { authorization: `Bearer oc-v3.7.${SECRET}` }
  return req
}

function makeRes(): {
  res: ServerResponse
  read: () => { status: number | undefined; body: unknown }
} {
  let body = ''
  const res = {
    statusCode: undefined as number | undefined,
    headersSent: false,
    setHeader() {},
    writeHead(this: { headersSent: boolean }, nextStatus: number) {
      ;(this as { statusCode?: number }).statusCode = nextStatus
      this.headersSent = true
    },
    end(chunk?: string) {
      if (chunk) body += chunk
    },
  } as unknown as ServerResponse
  return {
    res,
    read: () => ({ status: res.statusCode, body: body ? JSON.parse(body) : null }),
  }
}

test('QQ outbound accepts the gateway wire payload including createdAt', async () => {
  const { pool, inserted } = makePool()
  const handler = makeQqOutboundReceiver({ pool, identityRepo: makeRepo() })
  const response = makeRes()

  await handler(
    makeReq({
      sessionId: 'wsess-0123456789abcdef',
      channel: 'qqbot',
      outboundId: '0123456789abcdef.wxlive.1.final',
      peer: { kind: 'dm', meta: { senderId: OPENID } },
      blocks: [{ kind: 'text', text: 'QQ端到端测试通过', messageId: 'msg-1' }],
      createdAt: 1_784_799_592_927,
      isFinal: true,
      traceId: '0123456789abcdef0123456789abcdef',
    }),
    response.res,
    { hostUuid: 'host-1', boundIp: '172.31.0.7' },
  )

  assert.equal(response.read().status, 202)
  assert.deepEqual(response.read().body, { ok: true, outcome: 'queued', outboxId: 9 })
  assert.equal(inserted.length, 1)
})
