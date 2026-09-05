import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  ChatGptProxyCredentialStore,
  hashChatGptProxySecret,
  verifyChatGptProxySecretHash,
} from '../credentials.js'
import {
  getChatGptProxyFlagSnapshot,
  isChatGptProxyEntitled,
  readChatGptProxyEnv,
  resetChatGptProxyFlagCache,
  setChatGptProxySettingsLoader,
} from '../flags.js'

const GOOD_ENV = {
  OC_CHATGPT_PROXY_ENABLED: '1',
  OC_CHATGPT_PROXY_PUBLIC_HOST: 'proxy.example.test',
  OC_CHATGPT_PROXY_PORT: '8443',
  OC_CHATGPT_PROXY_TLS_CERT: '/tmp/c.pem',
  OC_CHATGPT_PROXY_TLS_KEY: '/tmp/k.pem',
} as NodeJS.ProcessEnv

describe('chatgpt proxy flags', () => {
  test('env parsing and validation', () => {
    const ok = readChatGptProxyEnv(GOOD_ENV)
    assert.equal(ok.enabled, true)
    assert.equal(ok.configError, null)
    assert.equal(ok.port, 8443)
    assert.equal(ok.upstream?.href, 'http://127.0.0.1:18991/')

    const off = readChatGptProxyEnv({})
    assert.equal(off.enabled, false)
    assert.equal(off.configError, null)

    const missingHost = readChatGptProxyEnv({ ...GOOD_ENV, OC_CHATGPT_PROXY_PUBLIC_HOST: '' })
    assert.match(missingHost.configError ?? '', /PUBLIC_HOST/)

    const badUpstream = readChatGptProxyEnv({
      ...GOOD_ENV,
      OC_CHATGPT_PROXY_UPSTREAM: 'socks5://x',
    })
    assert.match(badUpstream.configError ?? '', /UPSTREAM/)
  })

  test('env off → settings cannot enable', async () => {
    resetChatGptProxyFlagCache()
    setChatGptProxySettingsLoader(async () => ({ settingsOn: true, allowlist: [3] }))
    const snap = await getChatGptProxyFlagSnapshot(Date.now(), {})
    assert.equal(snap.assembled, false)
    assert.deepEqual(snap.allowlist, [])
    setChatGptProxySettingsLoader(null)
    resetChatGptProxyFlagCache()
  })

  test('env on + settings on → assembled with allowlist', async () => {
    resetChatGptProxyFlagCache()
    setChatGptProxySettingsLoader(async () => ({ settingsOn: true, allowlist: [3, 7] }))
    const snap = await getChatGptProxyFlagSnapshot(Date.now(), GOOD_ENV)
    assert.equal(snap.assembled, true)
    assert.deepEqual(snap.allowlist, [3, 7])
    setChatGptProxySettingsLoader(null)
    resetChatGptProxyFlagCache()
  })

  test('entitlement', () => {
    assert.equal(isChatGptProxyEntitled(9, 'admin', []), true)
    assert.equal(isChatGptProxyEntitled(9, 'user', []), false)
    assert.equal(isChatGptProxyEntitled(9, 'user', [9]), true)
  })
})

describe('chatgpt proxy credentials', () => {
  test('hash round-trip', async () => {
    const h = await hashChatGptProxySecret('s3cret')
    assert.match(h, /^scrypt\$/)
    assert.equal(await verifyChatGptProxySecretHash('s3cret', h), true)
    assert.equal(await verifyChatGptProxySecretHash('other', h), false)
    assert.equal(await verifyChatGptProxySecretHash('s3cret', 'garbage'), false)
  })

  test('store: issue → verify (cached) → revoke', async () => {
    const rows = new Map<number, { secret_hash: string; revoked: boolean }>()
    let selects = 0
    const pool = {
      async query(sql: string, params: unknown[]) {
        const uid = Number(params[0])
        if (sql.includes('INSERT INTO chatgpt_proxy_credentials')) {
          rows.set(uid, { secret_hash: String(params[1]), revoked: false })
          return { rowCount: 1, rows: [{ rotated_at: new Date() }] }
        }
        if (sql.includes('SET revoked_at')) {
          const r = rows.get(uid)
          if (r) r.revoked = true
          return { rowCount: r ? 1 : 0, rows: [] }
        }
        if (sql.includes('SET last_used_at')) return { rowCount: 1, rows: [] }
        if (sql.includes('SELECT secret_hash')) {
          selects += 1
          const r = rows.get(uid)
          return r && !r.revoked
            ? { rowCount: 1, rows: [{ secret_hash: r.secret_hash }] }
            : { rowCount: 0, rows: [] }
        }
        if (sql.includes('SELECT created_at')) {
          const r = rows.get(uid)
          return r && !r.revoked
            ? {
                rowCount: 1,
                rows: [{ created_at: new Date(0), rotated_at: new Date(0), last_used_at: null }],
              }
            : { rowCount: 0, rows: [] }
        }
        throw new Error(`unexpected sql: ${sql}`)
      },
    }
    let t = 1_000_000
    const store = new ChatGptProxyCredentialStore(pool as never, () => t)
    assert.equal((await store.info(5)).hasCredential, false)
    const issued = await store.issue(5)
    assert.ok(issued.secret.length >= 40)
    assert.equal((await store.info(5)).hasCredential, true)

    assert.equal(await store.verify(5, issued.secret), true)
    assert.equal(selects, 1)
    assert.equal(await store.verify(5, issued.secret), true)
    assert.equal(selects, 1, 'positive cache hit avoids DB')
    assert.equal(await store.verify(5, 'wrong-secret-wrong-secret'), false)
    assert.equal(await store.verify(6, issued.secret), false)

    const rotated = await store.issue(5)
    assert.notEqual(rotated.secret, issued.secret)
    assert.equal(await store.verify(5, issued.secret), false, 'old secret dead after rotation')
    assert.equal(await store.verify(5, rotated.secret), true)

    await store.revoke(5)
    assert.equal(await store.verify(5, rotated.secret), false)
    assert.equal((await store.info(5)).hasCredential, false)
    t += 1
  })
})
