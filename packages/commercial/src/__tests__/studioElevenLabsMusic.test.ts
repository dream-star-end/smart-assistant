import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  MusicProviderError,
  composeMusic,
  musicCostCredits,
  resolveElevenLabsKey,
} from '../media-studio/providers/elevenlabsMusic.js'

const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(2048, 1)])

function upstream(
  status: number,
  body: BodyInit | null,
  headers: Record<string, string> = { 'content-type': 'audio/mpeg', 'song-id': 's-1' },
) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (url: URL | string, init: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response(body, { status, headers })
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

describe('ElevenLabs music provider (OCV5-590)', () => {
  test('composes instrumental music: key only in the header, mp3 returned', async () => {
    const up = upstream(200, MP3)
    const out = await composeMusic(
      { key: 'sk_test_0123456789', fetchImpl: up.fetchImpl },
      { prompt: 'calm solo piano, snowy forest', durationMs: 37_000, instrumental: true },
    )
    assert.equal(out.mime, 'audio/mpeg')
    assert.equal(out.audio.length, MP3.length)
    assert.equal(out.songId, 's-1')
    const call = up.calls[0]!
    assert.equal(call.url, 'https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128')
    assert.equal((call.init.headers as Record<string, string>)['xi-api-key'], 'sk_test_0123456789')
    const body = JSON.parse(String(call.init.body))
    assert.deepEqual(body, {
      prompt: 'calm solo piano, snowy forest',
      music_length_ms: 37_000,
      model_id: 'music_v1',
      force_instrumental: true,
    })
    assert.ok(!String(call.init.body).includes('sk_test'), 'key never travels in the body')
  })

  test('input is validated before any upstream call', async () => {
    const up = upstream(200, MP3)
    for (const args of [
      { prompt: '', durationMs: 5000 },
      { prompt: 'x', durationMs: 2999 },
      { prompt: 'x', durationMs: 600_001 },
      { prompt: 'x', durationMs: 4500.5 },
    ]) {
      await assert.rejects(
        composeMusic(
          { key: 'sk_test_0123456789', fetchImpl: up.fetchImpl },
          { ...args, instrumental: true },
        ),
        (e: unknown) => e instanceof MusicProviderError && e.code === 'MUSIC_INVALID',
      )
    }
    await assert.rejects(
      composeMusic(
        { fetchImpl: up.fetchImpl },
        { prompt: 'x', durationMs: 5000, instrumental: true },
      ),
      (e: unknown) => e instanceof MusicProviderError && e.code === 'MUSIC_NOT_CONFIGURED',
    )
    assert.equal(up.calls.length, 0)
  })

  test('upstream errors map to stable codes', async () => {
    const cases: Array<[number, string, string]> = [
      [
        422,
        JSON.stringify({ detail: [{ loc: ['body'], msg: 'prompt violates terms', type: 'x' }] }),
        'MUSIC_INVALID',
      ],
      [401, '{}', 'MUSIC_PROVIDER_AUTH'],
      [429, '{}', 'MUSIC_RATE_LIMIT'],
      [500, 'oops', 'MUSIC_UPSTREAM'],
    ]
    for (const [status, body, code] of cases) {
      const up = upstream(status, body, { 'content-type': 'application/json' })
      await assert.rejects(
        composeMusic(
          { key: 'sk_test_0123456789', fetchImpl: up.fetchImpl },
          { prompt: 'x', durationMs: 5000, instrumental: true },
        ),
        (e: unknown) =>
          e instanceof MusicProviderError && e.code === code && !e.message.includes('sk_test'),
      )
    }
  })

  test('code r1: key never leaks via upstream detail; error bodies are bounded; network errors map to MUSIC_UPSTREAM', async () => {
    const key = 'sk_review_fake_0123456789'
    const leak = upstream(
      422,
      JSON.stringify({ detail: [{ msg: `invalid xi-api-key: ${key}` }] }),
      { 'content-type': 'application/json' },
    )
    await assert.rejects(
      composeMusic(
        { key, fetchImpl: leak.fetchImpl },
        { prompt: 'x', durationMs: 5000, instrumental: true },
      ),
      (e: unknown) =>
        e instanceof MusicProviderError &&
        e.code === 'MUSIC_INVALID' &&
        !e.message.includes(key) &&
        e.message.includes('[redacted]'),
    )
    const huge = upstream(500, `${' '.repeat(200 * 1024)}{}`, {
      'content-type': 'application/json',
    })
    await assert.rejects(
      composeMusic(
        { key, fetchImpl: huge.fetchImpl },
        { prompt: 'x', durationMs: 5000, instrumental: true },
      ),
      (e: unknown) => e instanceof MusicProviderError && e.code === 'MUSIC_UPSTREAM',
    )
    for (const thrown of [
      new TypeError('fetch failed'),
      Object.assign(new Error('t'), { name: 'TimeoutError' }),
    ]) {
      const failing = (async () => {
        throw thrown
      }) as unknown as typeof fetch
      await assert.rejects(
        composeMusic(
          { key, fetchImpl: failing },
          { prompt: 'x', durationMs: 5000, instrumental: true },
        ),
        (e: unknown) =>
          e instanceof MusicProviderError && e.code === 'MUSIC_UPSTREAM' && e.status === 502,
      )
    }
    const broken = (async () =>
      new Response(
        new ReadableStream({
          pull(c) {
            c.error(new TypeError('terminated'))
          },
        }),
        { status: 200, headers: { 'content-type': 'audio/mpeg' } },
      )) as unknown as typeof fetch
    await assert.rejects(
      composeMusic(
        { key, fetchImpl: broken },
        { prompt: 'x', durationMs: 5000, instrumental: true },
      ),
      (e: unknown) => e instanceof MusicProviderError && e.code === 'MUSIC_UPSTREAM',
    )
  })

  test('non-audio or corrupt responses are refused', async () => {
    const html = upstream(200, '<html>', { 'content-type': 'text/html' })
    await assert.rejects(
      composeMusic(
        { key: 'sk_test_0123456789', fetchImpl: html.fetchImpl },
        { prompt: 'x', durationMs: 5000, instrumental: true },
      ),
      MusicProviderError,
    )
    const junk = upstream(200, Buffer.from('not an mp3 file at all'))
    await assert.rejects(
      composeMusic(
        { key: 'sk_test_0123456789', fetchImpl: junk.fetchImpl },
        { prompt: 'x', durationMs: 5000, instrumental: true },
      ),
      MusicProviderError,
    )
  })

  test('pricing is per started minute (D6)', () => {
    assert.equal(musicCostCredits(3_000), 150n)
    assert.equal(musicCostCredits(60_000), 150n)
    assert.equal(musicCostCredits(61_000), 300n)
    assert.equal(musicCostCredits(600_000, 200), 2000n)
  })

  test('key file: only source, never echoed', () => {
    assert.deepEqual(resolveElevenLabsKey({} as NodeJS.ProcessEnv), {})
    assert.deepEqual(
      resolveElevenLabsKey(
        { ELEVENLABS_API_KEY_FILE: '/k' } as NodeJS.ProcessEnv,
        () => ' sk_test_0123456789\n',
      ),
      { key: 'sk_test_0123456789' },
    )
    const bad = resolveElevenLabsKey(
      { ELEVENLABS_API_KEY_FILE: '/k' } as NodeJS.ProcessEnv,
      () => 'two words here',
    )
    assert.equal(bad.key, undefined)
    assert.ok(bad.error && !bad.error.includes('words'))
    const missing = resolveElevenLabsKey(
      { ELEVENLABS_API_KEY_FILE: '/k' } as NodeJS.ProcessEnv,
      () => {
        throw new Error('ENOENT /k')
      },
    )
    assert.equal(missing.key, undefined)
  })
})
