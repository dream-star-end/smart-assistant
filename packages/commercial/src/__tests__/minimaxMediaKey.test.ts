// OCV5-589 / D12: media key resolution (cases from the commercial minimaxMediaClient.test.ts).

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { resolveMiniMaxMediaKey } from '../minimax/mediaKey.js'

describe('resolveMiniMaxMediaKey (OCV5-589 / D12)', () => {
  const env = (v: Record<string, string>) => v as NodeJS.ProcessEnv

  test('no file configured keeps MINIMAX_TOKEN_PLAN_KEY exactly as before', () => {
    assert.deepEqual(resolveMiniMaxMediaKey(env({ MINIMAX_TOKEN_PLAN_KEY: ' tp-key ' })), {
      key: 'tp-key',
      source: 'token_plan',
    })
    assert.deepEqual(resolveMiniMaxMediaKey(env({})), { source: 'none' })
  })

  test('a configured file is the only source and is trimmed', () => {
    const r = resolveMiniMaxMediaKey(
      env({ MINIMAX_MEDIA_KEY_FILE: '/etc/x/media.key', MINIMAX_TOKEN_PLAN_KEY: 'tp-key' }),
      (p) => {
        assert.equal(p, '/etc/x/media.key')
        return 'media-key-123\n'
      },
    )
    assert.deepEqual(r, { key: 'media-key-123', source: 'file' })
  })

  test('an unreadable or malformed file never falls back to the search key', () => {
    const unreadable = resolveMiniMaxMediaKey(
      env({ MINIMAX_MEDIA_KEY_FILE: '/nope', MINIMAX_TOKEN_PLAN_KEY: 'tp' }),
      () => {
        throw new Error('ENOENT secret-ish detail')
      },
    )
    assert.equal(unreadable.key, undefined)
    assert.equal(unreadable.source, 'none')
    assert.ok(
      unreadable.error && !unreadable.error.includes('secret-ish'),
      'error never echoes the underlying failure',
    )
    for (const bad of ['', 'two words', 'a\nb', 'x'.repeat(513)]) {
      const r = resolveMiniMaxMediaKey(
        env({ MINIMAX_MEDIA_KEY_FILE: '/k', MINIMAX_TOKEN_PLAN_KEY: 'tp' }),
        () => bad,
      )
      assert.equal(r.key, undefined, `malformed ${JSON.stringify(bad.slice(0, 10))} is refused`)
      assert.ok(
        r.error && !r.error.includes(bad.slice(0, 5) || '\u0000'),
        'error never includes file contents',
      )
    }
  })
})

