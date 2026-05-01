import * as assert from 'node:assert/strict'
/**
 * Tests for codexAuthSync — pure decision logic for keeping
 * `~/.codex/auth.json` in sync with OpenClaude's stored Codex OAuth state.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/codexAuthSync.test.ts
 */
import { describe, it } from 'node:test'
import { decideCodexAuthWrite, extractChatGptAccountId } from '../codexAuthSync.js'

/** Helper: build a fake JWT access_token whose payload contains
 *  an `https://api.openai.com/auth.chatgpt_account_id` claim.
 *  Header & signature are placeholders — extractChatGptAccountId only
 *  decodes the payload segment. */
function fakeAccessToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.sig`
}

const tokenForAccount = (aid: string) =>
  fakeAccessToken({ 'https://api.openai.com/auth': { chatgpt_account_id: aid } })

describe('extractChatGptAccountId', () => {
  it('returns the chatgpt_account_id claim from a well-formed JWT', () => {
    const at = tokenForAccount('account-abc')
    assert.equal(extractChatGptAccountId(at), 'account-abc')
  })

  it('returns null when the token is not a JWT (no dots)', () => {
    assert.equal(extractChatGptAccountId('not-a-jwt'), null)
  })

  it('returns null when the payload segment is not valid base64url JSON', () => {
    assert.equal(extractChatGptAccountId('a.b.c'), null)
  })

  it('returns null when the auth claim is missing', () => {
    const at = fakeAccessToken({ sub: 'foo' })
    assert.equal(extractChatGptAccountId(at), null)
  })

  it('returns null when chatgpt_account_id is empty string', () => {
    const at = fakeAccessToken({ 'https://api.openai.com/auth': { chatgpt_account_id: '' } })
    assert.equal(extractChatGptAccountId(at), null)
  })

  it('returns null when chatgpt_account_id is not a string', () => {
    const at = fakeAccessToken({ 'https://api.openai.com/auth': { chatgpt_account_id: 42 } })
    assert.equal(extractChatGptAccountId(at), null)
  })
})

describe('decideCodexAuthWrite — callback path (force-write)', () => {
  const baseArgs = {
    oauth: { accessToken: tokenForAccount('new-account'), refreshToken: 'rt_new' },
    nowIso: '2026-04-29T08:00:00Z',
  }

  it('writes a fresh file when no previous file exists', () => {
    const decision = decideCodexAuthWrite({ ...baseArgs, previousFileText: null })
    assert.equal(decision.action, 'write')
    if (decision.action !== 'write') return
    const parsed = JSON.parse(decision.content)
    assert.equal(parsed.auth_mode, 'chatgpt')
    assert.equal(parsed.OPENAI_API_KEY, null)
    assert.equal(parsed.tokens.access_token, baseArgs.oauth.accessToken)
    assert.equal(parsed.tokens.refresh_token, 'rt_new')
    assert.equal(parsed.tokens.account_id, 'new-account')
    assert.equal(parsed.tokens.id_token, '', 'no previous file → empty id_token')
    assert.equal(parsed.last_refresh, '2026-04-29T08:00:00Z')
  })

  it('preserves prior id_token when previous file is the same account', () => {
    const prev = JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        id_token: 'old-id-token',
        access_token: 'x',
        refresh_token: 'rt_old',
        account_id: 'new-account',
      },
    })
    const decision = decideCodexAuthWrite({ ...baseArgs, previousFileText: prev })
    assert.equal(decision.action, 'write')
    if (decision.action !== 'write') return
    const parsed = JSON.parse(decision.content)
    assert.equal(parsed.tokens.id_token, 'old-id-token')
  })

  it('drops prior id_token when previous file is a DIFFERENT account', () => {
    const prev = JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { id_token: 'old-id-token', refresh_token: 'rt_old', account_id: 'OTHER-account' },
    })
    const decision = decideCodexAuthWrite({ ...baseArgs, previousFileText: prev })
    assert.equal(decision.action, 'write')
    if (decision.action !== 'write') return
    const parsed = JSON.parse(decision.content)
    assert.equal(parsed.tokens.id_token, '', 'cross-account: must not leak old id_token')
  })

  it('treats unparseable previous file as no previous file', () => {
    const decision = decideCodexAuthWrite({ ...baseArgs, previousFileText: 'not json' })
    assert.equal(decision.action, 'write')
    if (decision.action !== 'write') return
    const parsed = JSON.parse(decision.content)
    assert.equal(parsed.tokens.id_token, '')
  })

  it('writes account_id="" but still writes when JWT is malformed', () => {
    const args = {
      oauth: { accessToken: 'malformed-jwt', refreshToken: 'rt_x' },
      nowIso: '2026-04-29T08:00:00Z',
      previousFileText: null,
    }
    const decision = decideCodexAuthWrite(args)
    assert.equal(decision.action, 'write')
    if (decision.action !== 'write') return
    const parsed = JSON.parse(decision.content)
    assert.equal(parsed.tokens.account_id, '')
    assert.equal(parsed.tokens.access_token, 'malformed-jwt')
  })
})

describe('decideCodexAuthWrite — refresh path (ownership check)', () => {
  const newAt = tokenForAccount('owner-account')
  const baseArgs = {
    oauth: { accessToken: newAt, refreshToken: 'rt_v2' },
    nowIso: '2026-04-29T09:00:00Z',
  }

  it('writes when existing file refresh_token matches the consumed one', () => {
    const prev = JSON.stringify({
      tokens: { id_token: 'kept', refresh_token: 'rt_v1', account_id: 'owner-account' },
    })
    const decision = decideCodexAuthWrite({
      ...baseArgs,
      previousFileText: prev,
      expectedPreviousRefreshToken: 'rt_v1',
    })
    assert.equal(decision.action, 'write')
    if (decision.action !== 'write') return
    const parsed = JSON.parse(decision.content)
    assert.equal(parsed.tokens.refresh_token, 'rt_v2')
    assert.equal(parsed.tokens.id_token, 'kept', 'same account → keep id_token')
  })

  it('skips when existing file refresh_token differs (user ran codex login directly)', () => {
    const prev = JSON.stringify({
      tokens: { refresh_token: 'rt_user_override', account_id: 'other-account' },
    })
    const decision = decideCodexAuthWrite({
      ...baseArgs,
      previousFileText: prev,
      expectedPreviousRefreshToken: 'rt_v1',
    })
    assert.equal(decision.action, 'skip')
    if (decision.action !== 'skip') return
    assert.match(decision.reason, /refresh_token differs/)
  })

  it('skips when existing file has tokens object but refresh_token is missing', () => {
    // E.g. user switched to API-key mode, partial write, or future format.
    // Conservative: refuse to overwrite.
    const prev = JSON.stringify({ OPENAI_API_KEY: 'sk-foo', auth_mode: 'api_key' })
    const decision = decideCodexAuthWrite({
      ...baseArgs,
      previousFileText: prev,
      expectedPreviousRefreshToken: 'rt_v1',
    })
    assert.equal(decision.action, 'skip')
    if (decision.action !== 'skip') return
    assert.match(decision.reason, /no refresh_token|API-key|unknown format/)
  })

  it('skips when existing file has tokens.refresh_token = "" (e.g. unknown shape)', () => {
    const prev = JSON.stringify({ tokens: { refresh_token: '' } })
    const decision = decideCodexAuthWrite({
      ...baseArgs,
      previousFileText: prev,
      expectedPreviousRefreshToken: 'rt_v1',
    })
    assert.equal(decision.action, 'skip')
  })

  it('writes when no previous file exists (recovery — callback already wrote it once)', () => {
    const decision = decideCodexAuthWrite({
      ...baseArgs,
      previousFileText: null,
      expectedPreviousRefreshToken: 'rt_v1',
    })
    assert.equal(decision.action, 'write')
  })
})

describe('decideCodexAuthWrite — id_token from oauth input (callback path)', () => {
  const baseArgs = {
    oauth: {
      accessToken: tokenForAccount('new-account'),
      refreshToken: 'rt_new',
      idToken: 'fresh-id-token-from-oidc',
    },
    nowIso: '2026-04-29T08:00:00Z',
  }

  it('writes input idToken verbatim (cross-account, no previous to preserve)', () => {
    const decision = decideCodexAuthWrite({ ...baseArgs, previousFileText: null })
    assert.equal(decision.action, 'write')
    if (decision.action !== 'write') return
    const parsed = JSON.parse(decision.content)
    assert.equal(parsed.tokens.id_token, 'fresh-id-token-from-oidc')
  })

  it('input idToken takes precedence over prev id_token even on same account', () => {
    const prev = JSON.stringify({
      tokens: {
        id_token: 'stale-prev-id-token',
        refresh_token: 'rt_old',
        account_id: 'new-account',
      },
    })
    const decision = decideCodexAuthWrite({ ...baseArgs, previousFileText: prev })
    assert.equal(decision.action, 'write')
    if (decision.action !== 'write') return
    const parsed = JSON.parse(decision.content)
    assert.equal(parsed.tokens.id_token, 'fresh-id-token-from-oidc')
  })

  it('falsy input idToken (undefined) falls back to prev preserve on same account', () => {
    const prev = JSON.stringify({
      tokens: {
        id_token: 'old-id-token',
        refresh_token: 'rt_old',
        account_id: 'new-account',
      },
    })
    const decision = decideCodexAuthWrite({
      ...baseArgs,
      oauth: { accessToken: tokenForAccount('new-account'), refreshToken: 'rt_new' },
      previousFileText: prev,
    })
    assert.equal(decision.action, 'write')
    if (decision.action !== 'write') return
    const parsed = JSON.parse(decision.content)
    assert.equal(parsed.tokens.id_token, 'old-id-token')
  })

  it('empty string input idToken (treated as falsy) → cross-account → empty', () => {
    const prev = JSON.stringify({
      tokens: {
        id_token: 'old-id-token',
        refresh_token: 'rt_old',
        account_id: 'OTHER-account',
      },
    })
    const decision = decideCodexAuthWrite({
      ...baseArgs,
      oauth: { accessToken: tokenForAccount('new-account'), refreshToken: 'rt_new', idToken: '' },
      previousFileText: prev,
    })
    assert.equal(decision.action, 'write')
    if (decision.action !== 'write') return
    const parsed = JSON.parse(decision.content)
    assert.equal(parsed.tokens.id_token, '')
  })
})
