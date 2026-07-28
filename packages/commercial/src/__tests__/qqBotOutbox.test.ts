import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Pool } from 'pg'

import { QqOutboundMediaTooLargeError } from '../qqbot/outboundMedia.js'
import { drainOneQqOutbox } from '../qqbot/outbox.js'

const OPENID = 'qq-openid-1'
const BINDING_VERSION = 'b'.repeat(32)

interface FakeState {
  status: 'queued' | 'sending' | 'sent' | 'cancelled'
  nextChunk: number
  attempts: number
  lastError?: string
}

function makeOutboxPool(
  payload: unknown,
  options: {
    bindingVersion?: string
    targetOpenid?: string
    activeBindingVersion?: string
    activeOpenid?: string
  } = {},
): { pool: Pool; state: FakeState } {
  const state: FakeState = { status: 'queued', nextChunk: 0, attempts: 0 }
  const bindingVersion = options.bindingVersion ?? BINDING_VERSION
  const targetOpenid = options.targetOpenid ?? OPENID
  const activeBindingVersion = options.activeBindingVersion ?? BINDING_VERSION
  const activeOpenid = options.activeOpenid ?? OPENID
  const query = async (
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> => {
    const normalized = sql.trim()
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(normalized)) return { rows: [], rowCount: 0 }
    if (/SELECT id, user_id[\s\S]+FROM qq_outbox/.test(sql)) {
      return state.status === 'queued'
        ? { rows: [{ id: '7', user_id: '42' }], rowCount: 1 }
        : { rows: [], rowCount: 0 }
    }
    if (/SELECT bot_openid, binding_version[\s\S]+FROM qq_bot_bindings/.test(sql)) {
      return {
        rows: [{ bot_openid: activeOpenid, binding_version: activeBindingVersion }],
        rowCount: 1,
      }
    }
    if (/SELECT id, binding_version, target_openid, payload/.test(sql)) {
      return state.status === 'queued'
        ? {
            rows: [{
              id: '7',
              binding_version: bindingVersion,
              target_openid: targetOpenid,
              payload,
              next_chunk: state.nextChunk,
              attempts: state.attempts,
            }],
            rowCount: 1,
          }
        : { rows: [], rowCount: 0 }
    }
    if (/SET status = 'sending'/.test(sql)) {
      state.status = 'sending'
      return { rows: [], rowCount: 1 }
    }
    if (/SET status = 'sent'/.test(sql)) {
      state.status = 'sent'
      state.nextChunk = Number(params[1])
      return { rows: [], rowCount: 1 }
    }
    if (/SET status = 'queued'/.test(sql)) {
      state.status = 'queued'
      state.attempts = Number(params[1])
      state.lastError = String(params[2])
      return { rows: [], rowCount: 1 }
    }
    if (/SET status = 'cancelled'/.test(sql)) {
      state.status = 'cancelled'
      return { rows: [], rowCount: 1 }
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
    state,
  }
}

describe('QQ outbox Stage A media consumer', () => {
  test('keeps the legacy text payload behavior unchanged', async () => {
    const { pool, state } = makeOutboxPool({ chunks: ['原有文字'] })
    const sent: string[] = []
    assert.equal(
      await drainOneQqOutbox(
        {
          pool,
          sendText: async (openid, text) => {
            assert.equal(openid, OPENID)
            sent.push(text)
          },
        },
        () => 1_000,
      ),
      true,
    )
    assert.deepEqual(sent, ['原有文字'])
    assert.equal(state.status, 'sent')
  })

  test('consumes a media-root tombstone without sending a QQ message', async () => {
    const { pool, state } = makeOutboxPool({ mediaRoot: true })
    let sends = 0
    await drainOneQqOutbox(
      {
        pool,
        sendText: async () => {
          sends += 1
        },
        sendMedia: async () => {
          sends += 1
        },
      },
      () => 1_000,
    )
    assert.equal(sends, 0)
    assert.equal(state.status, 'sent')
  })

  test('resolves and sends a media row for the fenced binding user', async () => {
    const payload = {
      media: {
        type: 'video',
        containerPath: '/home/agent/.openclaude/generated/demo.mp4',
        filename: 'demo.mp4',
        mimeType: 'video/mp4',
      },
    }
    const { pool, state } = makeOutboxPool(payload)
    let sent = 0
    await drainOneQqOutbox(
      {
        pool,
        sendText: async () => {
          throw new Error('text must not be sent')
        },
        resolveMediaPart: async ({ bindingUserId, part }) => {
          assert.equal(bindingUserId, '42')
          assert.equal(part.filename, 'demo.mp4')
          return {
            kind: 'video',
            filename: 'demo.mp4',
            mimeType: 'video/mp4',
            content: Buffer.from('video'),
          }
        },
        sendMedia: async (openid, media) => {
          assert.equal(openid, OPENID)
          assert.equal(media.kind, 'video')
          sent += 1
        },
      },
      () => 1_000,
    )
    assert.equal(sent, 1)
    assert.equal(state.status, 'sent')
  })

  test('binding-version mismatch cancels before resolving or sending media', async () => {
    const { pool, state } = makeOutboxPool(
      {
        media: {
          type: 'file',
          containerPath: '/home/agent/.openclaude/generated/report.pdf',
          filename: 'report.pdf',
        },
      },
      { activeBindingVersion: 'c'.repeat(32) },
    )
    let touched = false
    await drainOneQqOutbox(
      {
        pool,
        sendText: async () => {
          touched = true
        },
        resolveMediaPart: async () => {
          touched = true
          throw new Error('must not resolve')
        },
        sendMedia: async () => {
          touched = true
        },
      },
      () => 1_000,
    )
    assert.equal(touched, false)
    assert.equal(state.status, 'cancelled')
  })

  test('transient media failure stays queued with uncapped retry semantics', async () => {
    const { pool, state } = makeOutboxPool({
      media: {
        type: 'image',
        containerPath: '/home/agent/.openclaude/generated/result.png',
        filename: 'result.png',
      },
    })
    await drainOneQqOutbox(
      {
        pool,
        sendText: async () => {},
        resolveMediaPart: async () => ({
          kind: 'image',
          filename: 'result.png',
          content: Buffer.from('png'),
        }),
        sendMedia: async () => {
          throw new Error('QQ upload unavailable')
        },
      },
      () => 1_000,
    )
    assert.equal(state.status, 'queued')
    assert.equal(state.attempts, 1)
    assert.equal(state.lastError, 'QQ upload unavailable')
  })

  test('oversize is terminal only after its explicit QQ notice succeeds', async () => {
    const payload = {
      media: {
        type: 'voice',
        containerPath: '/home/agent/.openclaude/generated/large.wav',
        filename: 'large.wav',
      },
    }
    const first = makeOutboxPool(payload)
    const notices: string[] = []
    await drainOneQqOutbox(
      {
        pool: first.pool,
        sendText: async (_openid, text) => {
          notices.push(text)
        },
        resolveMediaPart: async () => {
          throw new QqOutboundMediaTooLargeError('超过 QQ 语音 20 MB 上限')
        },
        sendMedia: async () => {
          throw new Error('must not upload')
        },
      },
      () => 1_000,
    )
    assert.deepEqual(notices, ['超过 QQ 语音 20 MB 上限'])
    assert.equal(first.state.status, 'sent')

    const second = makeOutboxPool(payload)
    await drainOneQqOutbox(
      {
        pool: second.pool,
        sendText: async () => {
          throw new Error('QQ notice unavailable')
        },
        resolveMediaPart: async () => {
          throw new QqOutboundMediaTooLargeError('超过 QQ 语音 20 MB 上限')
        },
        sendMedia: async () => {
          throw new Error('must not upload')
        },
      },
      () => 1_000,
    )
    assert.equal(second.state.status, 'queued')
    assert.equal(second.state.attempts, 1)
    assert.equal(second.state.lastError, 'QQ notice unavailable')
  })
})
