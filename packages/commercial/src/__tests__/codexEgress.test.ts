/**
 * V3 commercial — Codex account egress resolver tests.
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/codexEgress.test.ts
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { encrypt } from '../crypto/aead.js'
import {
  CodexEgressError,
  resolveCodexAccountEgressDispatcher,
  resolveOfficialOAuthAccountEgressDispatcher,
} from '../account-pool/codexEgress.js'

const KEY = Buffer.alloc(32, 7)
const DISPATCHER = { name: 'dispatcher' } as never

function encryptedProxy(url: string): { proxy_url_enc: Buffer; proxy_url_nonce: Buffer } {
  const enc = encrypt(url, Buffer.from(KEY))
  return { proxy_url_enc: enc.ciphertext, proxy_url_nonce: enc.nonce }
}

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '53',
    provider: 'codex',
    status: 'active',
    egress_proxy_id: '4',
    proxy_status: 'active',
    ...encryptedProxy('http://user:pass@proxy.example:8080'),
    ...overrides,
  }
}

async function assertCodexEgressCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(
    promise,
    (err) => err instanceof CodexEgressError && err.code === code,
  )
}

describe('resolveCodexAccountEgressDispatcher', () => {
  test('the shared resolver keeps Grok accounts in their own provider partition', async () => {
    const result = await resolveOfficialOAuthAccountEgressDispatcher(53n, 'grok', {
      keyFn: () => Buffer.from(KEY),
      queryFn: async () => ({ rows: [makeRow({ provider: 'grok' })] }) as never,
      dispatcherFactory: async () => DISPATCHER,
    })
    assert.strictEqual(result.dispatcher, DISPATCHER)
    await assertCodexEgressCode(
      resolveOfficialOAuthAccountEgressDispatcher(53n, 'grok', {
        keyFn: () => Buffer.from(KEY),
        queryFn: async () => ({ rows: [makeRow({ provider: 'codex' })] }) as never,
        dispatcherFactory: async () => DISPATCHER,
      }),
      'provider_mismatch',
    )
  })

  test('decrypts the active account proxy and builds an account-scoped dispatcher', async () => {
    const calls: Array<{ accountId: bigint; proxyUrl: string; target: unknown }> = []
    const result = await resolveCodexAccountEgressDispatcher(53n, {
      keyFn: () => Buffer.from(KEY),
      queryFn: async (_sql, params) => {
        assert.deepEqual(params, ['53'])
        return { rows: [makeRow()] } as never
      },
      dispatcherFactory: async (accountId, proxyUrl, target) => {
        if (typeof proxyUrl !== 'string') throw new TypeError('expected proxy URL')
        calls.push({ accountId: BigInt(accountId), proxyUrl, target })
        return DISPATCHER
      },
    })

    assert.equal(result.accountId, 53n)
    assert.equal(result.proxyId, 4n)
    assert.strictEqual(result.dispatcher, DISPATCHER)
    assert.deepEqual(calls, [{
      accountId: 53n,
      proxyUrl: 'http://user:pass@proxy.example:8080',
      target: null,
    }])
  })

  test('fails closed instead of returning an undefined/direct dispatcher', async () => {
    await assertCodexEgressCode(
      resolveCodexAccountEgressDispatcher(53n, {
        keyFn: () => Buffer.from(KEY),
        queryFn: async () => ({ rows: [makeRow({ egress_proxy_id: null })] }) as never,
        dispatcherFactory: async () => DISPATCHER,
      }),
      'proxy_missing',
    )

    await assertCodexEgressCode(
      resolveCodexAccountEgressDispatcher(53n, {
        keyFn: () => Buffer.from(KEY),
        queryFn: async () => ({ rows: [makeRow({ proxy_status: 'disabled' })] }) as never,
        dispatcherFactory: async () => DISPATCHER,
      }),
      'proxy_inactive',
    )

    await assertCodexEgressCode(
      resolveCodexAccountEgressDispatcher(53n, {
        keyFn: () => Buffer.from(KEY),
        queryFn: async () => ({ rows: [makeRow()] }) as never,
        dispatcherFactory: async () => undefined,
      }),
      'dispatcher_unavailable',
    )
  })
})
