/**
 * OCV5-589 MiniMax media client on real Postgres (0322 minimax_voices).
 *
 *   1. speech: a system voice and the caller's own voice pass; another user's voice is 403 and
 *      never reaches upstream; with no system list the check fails closed to the default voice.
 *   2. speech is billed pro-rata per character (one line = 1 cent, not a 200-cent block), and
 *      `extra.voice_setting.voice_id` cannot swap the validated voice.
 *   3. voice design: charged 990 + preview once; the voice is registered active for the caller;
 *      a retry with the same requestId returns the same voice without a second upstream call or
 *      charge; the same requestId with different params is 409.
 *   4. voice clone: no consent → 400 before upstream; moderation rejection → no charge, no voice;
 *      success → 990 charged and the consent statement stored.
 *   5. the 5-hour window cap answers 429 once full.
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, beforeEach, describe, test } from 'node:test'

import { closePool, createPool, getPool, resetPool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { query } from '../db/queries.js'
import { HttpError } from '../http/util.js'
import {
  type MiniMaxClientDeps,
  cloneVoice,
  designVoice,
  synthesizeSpeech,
} from '../minimax/mediaClient.js'
import { SystemVoiceCache } from '../minimax/voices.js'
import { resetTestSchemaForTest } from './helpers/db.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'

let pgAvailable = false

async function probe(): Promise<boolean> {
  const p = createPool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 })
  try {
    await p.query('SELECT 1')
    await p.end()
    return true
  } catch {
    try {
      await p.end()
    } catch {
      /* ignore */
    }
    return false
  }
}

before(async () => {
  pgAvailable = await probe()
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error('Postgres test fixture required')
    return
  }
  await resetPool()
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 10 }))
  await resetTestSchemaForTest()
  await runMigrations()
})

after(async () => {
  if (pgAvailable) {
    try {
      await resetTestSchemaForTest()
    } catch {
      /* ignore */
    }
    await closePool()
  }
})

beforeEach(async () => {
  if (!pgAvailable) return
  await query(
    'TRUNCATE TABLE minimax_voices, minimax_media_usage_records, credit_ledger, user_subscriptions, users RESTART IDENTITY CASCADE',
  )
})

const skip = (t: { skip: (m: string) => void }) => {
  if (!pgAvailable) {
    t.skip('no Postgres test fixture')
    return true
  }
  return false
}

async function user(credits: bigint): Promise<bigint> {
  const r = await query<{ id: string }>(
    `INSERT INTO users(email, password_hash, email_verified, credits)
     VALUES ($1, 'x', TRUE, $2) RETURNING id::text AS id`,
    [`v${randomUUID().slice(0, 8)}@t.local`, credits.toString()],
  )
  return BigInt(r.rows[0]!.id)
}

async function credits(userId: bigint): Promise<bigint> {
  return BigInt(
    (
      await query<{ c: string }>('SELECT credits::text AS c FROM users WHERE id=$1', [
        userId.toString(),
      ])
    ).rows[0]!.c,
  )
}

type Call = { path: string; body: unknown }

function fakeUpstream(handlers: Record<string, (body: unknown) => unknown>) {
  const calls: Call[] = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname
    let body: unknown = null
    if (typeof init?.body === 'string') body = JSON.parse(init.body)
    else if (init?.body instanceof FormData) body = { multipart: true }
    calls.push({ path, body })
    const h = handlers[path]
    if (!h)
      return new Response(
        JSON.stringify({ base_resp: { status_code: 2013, status_msg: 'no handler' } }),
        { status: 200 },
      )
    return new Response(JSON.stringify(h(body)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

const AUDIO_HEX = Buffer.from('ID3fakeaudio').toString('hex')
const okSpeech = () => ({
  data: { audio: AUDIO_HEX },
  extra_info: { usage_characters: 26 },
  base_resp: { status_code: 0 },
})

function deps(
  fetchImpl: typeof fetch,
  system: string[] | null,
  windowCap?: number,
): MiniMaxClientDeps {
  return {
    pool: getPool(),
    key: 'test-key',
    fetchImpl,
    windowCap,
    voices: new SystemVoiceCache(async () => {
      if (system === null) throw new Error('down')
      return system.map((voiceId) => ({ voiceId, voiceName: voiceId, description: [] }))
    }),
  }
}

describe('MiniMax media client (OCV5-589)', () => {
  test('speech costCap: an upstream count above the reservation is charged at the cap (OCV5-591 A2-0)', async (t) => {
    if (skip(t)) return
    const alice = await user(10_000n)
    const up = fakeUpstream({
      '/v1/t2a_v2': () => ({
        data: { audio: AUDIO_HEX },
        extra_info: { usage_characters: 151 },
        base_resp: { status_code: 0 },
      }),
    })
    const d = deps(up.fetchImpl, ['male-qn-qingse'])
    const out = await synthesizeSpeech(d, {
      userId: alice,
      containerId: null,
      requestId: 'cap-1',
      model: 'speech-2.8-turbo',
      text: 'a'.repeat(50),
      voiceId: 'male-qn-qingse',
      format: 'mp3',
      costCap: 3n,
    })
    // 151 chars would be 4 cents; the reservation caps it at 3.
    assert.equal(out.settled.costCredits, 3n)
    assert.equal(await credits(alice), 9_997n)
    const row = (
      await query<{ cost: string; notes: string | null }>(
        `SELECT cost_credits::text AS cost, price_snapshot->>'notes' AS notes
           FROM minimax_media_usage_records WHERE user_id=$1 AND request_id='cap-1'`,
        [alice.toString()],
      )
    ).rows[0]!
    assert.equal(row.cost, '3')
    assert.match(row.notes ?? '', /capped from 4/)
    // Without a cap the same count is charged in full.
    const uncapped = await synthesizeSpeech(d, {
      userId: alice,
      containerId: null,
      requestId: 'cap-2',
      model: 'speech-2.8-turbo',
      text: 'a'.repeat(50),
      voiceId: 'male-qn-qingse',
      format: 'mp3',
    })
    assert.equal(uncapped.settled.costCredits, 4n)
  })

  test('speech voice access: system and own voices pass, others are 403 before upstream', async (t) => {
    if (skip(t)) return
    const alice = await user(10_000n)
    const bob = await user(10_000n)
    const up = fakeUpstream({
      '/v1/t2a_v2': okSpeech,
      '/v1/voice_design': (b) => ({
        voice_id: (b as { voice_id: string }).voice_id,
        trial_audio: AUDIO_HEX,
        base_resp: { status_code: 0 },
      }),
    })
    const d = deps(up.fetchImpl, ['male-qn-qingse', 'presenter_male'])
    const designed = await designVoice(d, {
      userId: bob,
      requestId: 'bob-design-1',
      prompt: '少年感、轻快',
      previewText: '你好',
    })

    const sys = await synthesizeSpeech(d, {
      userId: alice,
      containerId: null,
      requestId: 'a-1',
      model: 'speech-2.8-turbo',
      text: '清晨，北方的雪松林慢慢醒来。',
      voiceId: 'presenter_male',
      format: 'mp3',
    })
    assert.equal(
      sys.settled.costCredits,
      1n,
      'one line costs 1 cent (pro-rata), not a 200-cent block',
    )
    const before = up.calls.length
    await assert.rejects(
      synthesizeSpeech(d, {
        userId: alice,
        containerId: null,
        requestId: 'a-2',
        model: 'speech-2.8-turbo',
        text: '偷用别人的音色',
        voiceId: designed.voiceId,
        format: 'mp3',
      }),
      (e: unknown) => e instanceof HttpError && e.code === 'MINIMAX_VOICE_FORBIDDEN',
    )
    assert.equal(up.calls.length, before, "another user's voice never reaches upstream")
    const own = await synthesizeSpeech(d, {
      userId: bob,
      containerId: null,
      requestId: 'b-1',
      model: 'speech-2.8-turbo',
      text: '我自己的音色',
      voiceId: designed.voiceId,
      format: 'mp3',
      extra: { voice_setting: { voice_id: 'presenter_male', speed: 0.9 } },
    })
    assert.ok(own.settled.costCredits >= 1n)
    const sent = up.calls.at(-1)!.body as { voice_setting: { voice_id: string; speed: number } }
    assert.equal(
      sent.voice_setting.voice_id,
      designed.voiceId,
      'extra.voice_setting cannot swap the validated voice',
    )
    assert.equal(sent.voice_setting.speed, 0.9)
    await assert.rejects(
      synthesizeSpeech(d, {
        userId: bob,
        containerId: null,
        requestId: 'b-2',
        model: 'speech-2.8-turbo',
        text: 'mix',
        voiceId: designed.voiceId,
        format: 'mp3',
        extra: { timber_weights: [{ voice_id: 'x', weight: 1 }] },
      }),
      (e: unknown) => e instanceof HttpError && e.status === 400,
    )
  })

  test('system list unavailable: only the default voice and own voices pass (fail closed)', async (t) => {
    if (skip(t)) return
    const u = await user(10_000n)
    const up = fakeUpstream({ '/v1/t2a_v2': okSpeech })
    const d = deps(up.fetchImpl, null)
    await synthesizeSpeech(d, {
      userId: u,
      containerId: null,
      requestId: 'r1',
      model: 'speech-2.8-turbo',
      text: 'hi',
      voiceId: 'male-qn-qingse',
      format: 'mp3',
    })
    await assert.rejects(
      synthesizeSpeech(d, {
        userId: u,
        containerId: null,
        requestId: 'r2',
        model: 'speech-2.8-turbo',
        text: 'hi',
        voiceId: 'presenter_male',
        format: 'mp3',
      }),
      (e: unknown) => e instanceof HttpError && e.code === 'MINIMAX_VOICE_FORBIDDEN',
    )
  })

  test('voice design is charged once, registered active, idempotent by requestId', async (t) => {
    if (skip(t)) return
    const u = await user(5_000n)
    const up = fakeUpstream({
      '/v1/voice_design': (b) => ({
        voice_id: (b as { voice_id: string }).voice_id,
        trial_audio: AUDIO_HEX,
        base_resp: { status_code: 0 },
      }),
    })
    const d = deps(up.fetchImpl, ['male-qn-qingse'])
    const first = await designVoice(d, {
      userId: u,
      requestId: 'take-1',
      prompt: '沉稳男声',
      previewText: '清晨',
    })
    assert.match(first.voiceId, new RegExp(`^oc${u}x[a-z2-7]{12}$`))
    assert.equal(first.settled.costCredits, 991n, '990 for the voice + 1 cent preview')
    assert.equal(await credits(u), 5_000n - 991n)
    const again = await designVoice(d, {
      userId: u,
      requestId: 'take-1',
      prompt: '沉稳男声',
      previewText: '清晨',
    })
    assert.equal(again.voiceId, first.voiceId)
    assert.equal(again.settled.replayed, true)
    assert.equal(
      up.calls.filter((c) => c.path === '/v1/voice_design').length,
      1,
      'no second upstream voice',
    )
    assert.equal(await credits(u), 5_000n - 991n, 'no second charge')
    await assert.rejects(
      designVoice(d, { userId: u, requestId: 'take-1', prompt: '换了描述', previewText: '清晨' }),
      (e: unknown) => e instanceof HttpError && e.code === 'REQUEST_ID_REUSED',
    )
    const rows = (
      await query<{ status: string; kind: string }>(
        'SELECT status, kind FROM minimax_voices WHERE user_id=$1',
        [u.toString()],
      )
    ).rows
    assert.deepEqual(rows, [{ status: 'active', kind: 'design' }])
  })

  test('crash after settlement but before activation: a stale retry restores the paid voice (plan r2 P1)', async (t) => {
    if (skip(t)) return
    const u = await user(5_000n)
    const up = fakeUpstream({
      '/v1/voice_design': (b) => ({
        voice_id: (b as { voice_id: string }).voice_id,
        trial_audio: AUDIO_HEX,
        base_resp: { status_code: 0 },
      }),
    })
    const d = deps(up.fetchImpl, ['male-qn-qingse'])
    const paid = await designVoice(d, {
      userId: u,
      requestId: 'take-crash',
      prompt: '旁白',
      previewText: '你好',
    })
    // Simulate the crash window: settled (usage row + ledger exist) but the voice row still pending and stale.
    await query(
      `UPDATE minimax_voices SET status='pending', usage_id=NULL, updated_at=NOW() - INTERVAL '20 minutes'
        WHERE user_id=$1 AND request_id='take-crash'`,
      [u.toString()],
    )
    const balance = await credits(u)
    const retry = await designVoice(d, {
      userId: u,
      requestId: 'take-crash',
      prompt: '旁白',
      previewText: '你好',
    })
    assert.equal(retry.voiceId, paid.voiceId, 'the paid voice is restored, not replaced')
    assert.equal(
      up.calls.filter((c) => c.path === '/v1/voice_design').length,
      1,
      'no second upstream voice',
    )
    assert.equal(await credits(u), balance, 'no second charge')
    const row = (
      await query<{ status: string; usage_id: string | null }>(
        "SELECT status, usage_id::text AS usage_id FROM minimax_voices WHERE request_id='take-crash'",
      )
    ).rows[0]!
    assert.equal(row.status, 'active')
    assert.equal(row.usage_id, paid.settled.usageId.toString())
  })

  test('a failed design leaves the voice unusable and a retry gets a fresh voice id', async (t) => {
    if (skip(t)) return
    const u = await user(5_000n)
    let fail = true
    const up = fakeUpstream({
      '/v1/voice_design': (b) =>
        fail
          ? { base_resp: { status_code: 2013, status_msg: 'bad prompt' } }
          : {
              voice_id: (b as { voice_id: string }).voice_id,
              trial_audio: AUDIO_HEX,
              base_resp: { status_code: 0 },
            },
    })
    const d = deps(up.fetchImpl, ['male-qn-qingse'])
    await assert.rejects(
      designVoice(d, { userId: u, requestId: 'take-9', prompt: 'p', previewText: 'x' }),
      HttpError,
    )
    assert.equal(await credits(u), 5_000n, 'failed design is not charged')
    const failedId = (up.calls[0]!.body as { voice_id: string }).voice_id
    await assert.rejects(
      synthesizeSpeech(d, {
        userId: u,
        containerId: null,
        requestId: 's',
        model: 'speech-2.8-turbo',
        text: 'x',
        voiceId: failedId,
        format: 'mp3',
      }),
      (e: unknown) => e instanceof HttpError && e.code === 'MINIMAX_VOICE_FORBIDDEN',
    )
    fail = false
    const ok = await designVoice(d, {
      userId: u,
      requestId: 'take-9',
      prompt: 'p',
      previewText: 'x',
    })
    assert.notEqual(ok.voiceId, failedId)
  })

  test('an unrelated charge with the same request id never counts as the voice settlement (code r1 P1)', async (t) => {
    if (skip(t)) return
    const u = await user(5_000n)
    let fail = true
    const up = fakeUpstream({
      '/v1/t2a_v2': okSpeech,
      '/v1/voice_design': (b) =>
        fail
          ? { base_resp: { status_code: 2013, status_msg: 'bad prompt' } }
          : {
              voice_id: (b as { voice_id: string }).voice_id,
              trial_audio: AUDIO_HEX,
              base_resp: { status_code: 0 },
            },
    })
    const d = deps(up.fetchImpl, ['male-qn-qingse'])
    await assert.rejects(
      designVoice(d, { userId: u, requestId: 'R', prompt: 'p', previewText: 'x' }),
      HttpError,
    )
    // Same user, same request id, a different (paid) media call.
    await synthesizeSpeech(d, {
      userId: u,
      containerId: null,
      requestId: 'R',
      model: 'speech-2.8-turbo',
      text: 'hi',
      voiceId: 'male-qn-qingse',
      format: 'mp3',
    })
    await query(
      `UPDATE minimax_voices SET updated_at=NOW() - INTERVAL '20 minutes' WHERE request_id='R'`,
    )
    fail = false
    const before = await credits(u)
    const created = await designVoice(d, {
      userId: u,
      requestId: 'R',
      prompt: 'p',
      previewText: 'x',
    })
    assert.equal(
      up.calls.filter((c) => c.path === '/v1/voice_design').length,
      2,
      'the voice is really created upstream',
    )
    assert.equal(created.settled.replayed, false)
    assert.equal(await credits(u), before - 991n, 'the creation is charged on its own')
  })

  test('voice clone needs consent, refuses moderated samples unbilled, stores consent on success', async (t) => {
    if (skip(t)) return
    const u = await user(5_000n)
    let sensitive = true
    const up = fakeUpstream({
      '/v1/files/upload': () => ({ file: { file_id: 123456 }, base_resp: { status_code: 0 } }),
      '/v1/voice_clone': () =>
        sensitive
          ? { input_sensitive: true, input_sensitive_type: 2, base_resp: { status_code: 0 } }
          : {
              input_sensitive: false,
              input_sensitive_type: 0,
              demo_audio: '',
              base_resp: { status_code: 0 },
            },
    })
    const d = deps(up.fetchImpl, ['male-qn-qingse'])
    const sample = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64)])
    await assert.rejects(
      cloneVoice(d, { userId: u, requestId: 'c-0', sample, consent: undefined, label: '我' }),
      (e: unknown) => e instanceof HttpError && e.code === 'CLONE_CONSENT_REQUIRED',
    )
    assert.equal(up.calls.length, 0, 'no consent → nothing uploaded')
    const consent = { statement: 'self_or_authorized', acceptedAt: '2026-10-23T02:00:00Z' }
    await assert.rejects(
      cloneVoice(d, { userId: u, requestId: 'c-1', sample, consent, label: '我' }),
      (e: unknown) => e instanceof HttpError && e.code === 'MINIMAX_CLONE_REJECTED',
    )
    assert.equal(await credits(u), 5_000n, 'moderated sample is not charged')
    sensitive = false
    const ok = await cloneVoice(d, { userId: u, requestId: 'c-2', sample, consent, label: '我' })
    assert.equal(ok.settled.costCredits, 990n)
    const row = (
      await query<{ consent: { statement: string } | null; status: string }>(
        'SELECT consent, status FROM minimax_voices WHERE voice_id=$1',
        [ok.voiceId],
      )
    ).rows[0]!
    assert.equal(row.status, 'active')
    assert.equal(row.consent?.statement, 'self_or_authorized')
  })

  test('5-hour window cap answers 429 once full', async (t) => {
    if (skip(t)) return
    const u = await user(10_000n)
    const up = fakeUpstream({ '/v1/t2a_v2': okSpeech })
    const d = deps(up.fetchImpl, ['male-qn-qingse'], 2)
    await synthesizeSpeech(d, {
      userId: u,
      containerId: null,
      requestId: 'w1',
      model: 'speech-2.8-turbo',
      text: 'a',
      voiceId: 'male-qn-qingse',
      format: 'mp3',
    })
    await synthesizeSpeech(d, {
      userId: u,
      containerId: null,
      requestId: 'w2',
      model: 'speech-2.8-turbo',
      text: 'b',
      voiceId: 'male-qn-qingse',
      format: 'mp3',
    })
    await assert.rejects(
      synthesizeSpeech(d, {
        userId: u,
        containerId: null,
        requestId: 'w3',
        model: 'speech-2.8-turbo',
        text: 'c',
        voiceId: 'male-qn-qingse',
        format: 'mp3',
      }),
      (e: unknown) =>
        e instanceof HttpError && e.status === 429 && e.code === 'MINIMAX_QUOTA_WINDOW',
    )
  })
})
