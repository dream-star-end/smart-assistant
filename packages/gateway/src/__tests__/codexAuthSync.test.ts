import * as assert from 'node:assert/strict'
/**
 * Tests for codexAuthSync (v3 commercial) — pure decision logic for keeping
 * master + container auth files in sync with OpenClaude's stored Codex
 * OAuth state.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/codexAuthSync.test.ts
 */
import { describe, it } from 'node:test'
import {
  buildContainerVariantContent,
  decideCodexAuthWrite,
  extractChatGptAccountId,
} from '../codexAuthSync.js'

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

describe('decideCodexAuthWrite — callback path (force-write, master file)', () => {
  const baseArgs = {
    oauth: { accessToken: tokenForAccount('new-account'), refreshToken: 'rt_new' },
    nowIso: '2026-04-29T08:00:00Z',
  }

  it('writes a fresh file when no previous file exists (fresh-write fallback uses access_token as id_token)', () => {
    const decision = decideCodexAuthWrite({ ...baseArgs, previousFileText: null })
    assert.equal(decision.action, 'write')
    if (decision.action !== 'write') return
    const parsed = JSON.parse(decision.content)
    assert.equal(parsed.auth_mode, 'chatgpt')
    assert.equal(parsed.OPENAI_API_KEY, null)
    assert.equal(parsed.tokens.access_token, baseArgs.oauth.accessToken)
    assert.equal(parsed.tokens.refresh_token, 'rt_new')
    assert.equal(parsed.tokens.account_id, 'new-account')
    // fresh-write: id_token MUST be JWT-shaped (codex 0.125 strict
    // deserialize); we reuse access_token, never empty string.
    assert.equal(parsed.tokens.id_token, baseArgs.oauth.accessToken)
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

  it('drops prior id_token when previous file is a DIFFERENT account (fallback to access_token)', () => {
    const prev = JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { id_token: 'old-id-token', refresh_token: 'rt_old', account_id: 'OTHER-account' },
    })
    const decision = decideCodexAuthWrite({ ...baseArgs, previousFileText: prev })
    assert.equal(decision.action, 'write')
    if (decision.action !== 'write') return
    const parsed = JSON.parse(decision.content)
    // Different account → don't preserve old id_token (could mismatch);
    // fall back to access_token (JWT-shaped, codex 0.125 deserialize-safe).
    assert.equal(parsed.tokens.id_token, baseArgs.oauth.accessToken)
  })

  it('treats unparseable previous file as no previous file (fallback to access_token)', () => {
    const decision = decideCodexAuthWrite({ ...baseArgs, previousFileText: 'not json' })
    assert.equal(decision.action, 'write')
    if (decision.action !== 'write') return
    const parsed = JSON.parse(decision.content)
    assert.equal(parsed.tokens.id_token, baseArgs.oauth.accessToken)
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

describe('decideCodexAuthWrite — refresh path (ownership check, master file)', () => {
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
    assert.equal(parsed.tokens.id_token, 'kept')
  })

  it('skips when existing file refresh_token differs (foreign writer)', () => {
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
    const prev = JSON.stringify({ OPENAI_API_KEY: 'sk-foo', auth_mode: 'api_key' })
    const decision = decideCodexAuthWrite({
      ...baseArgs,
      previousFileText: prev,
      expectedPreviousRefreshToken: 'rt_v1',
    })
    assert.equal(decision.action, 'skip')
    if (decision.action !== 'skip') return
    assert.match(decision.reason, /no refresh_token|unknown format/)
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

  it('writes when no previous file exists (recovery)', () => {
    const decision = decideCodexAuthWrite({
      ...baseArgs,
      previousFileText: null,
      expectedPreviousRefreshToken: 'rt_v1',
    })
    assert.equal(decision.action, 'write')
  })
})

describe('buildContainerVariantContent — external-token variant for container mount', () => {
  const oauth = { accessToken: tokenForAccount('container-account'), refreshToken: 'rt_secret' }
  const nowIso = '2026-04-30T10:00:00Z'

  it('serialized output matches codex 0.125 external-token schema', () => {
    const content = buildContainerVariantContent({ oauth, nowIso })
    const parsed = JSON.parse(content)
    assert.equal(parsed.auth_mode, 'chatgptAuthTokens')
    assert.equal(parsed.OPENAI_API_KEY, null)
    assert.equal(parsed.tokens.access_token, oauth.accessToken)
    assert.equal(parsed.tokens.account_id, 'container-account')
    assert.equal(parsed.last_refresh, nowIso)
  })

  it('id_token reuses access_token (JWT-shaped; codex 0.125 strict deserialize)', () => {
    const content = buildContainerVariantContent({ oauth, nowIso })
    const parsed = JSON.parse(content)
    assert.equal(parsed.tokens.id_token, oauth.accessToken)
    // JWT shape: 3 non-empty dot-separated parts.
    const parts = String(parsed.tokens.id_token).split('.')
    assert.equal(parts.length, 3)
    for (const p of parts) assert.notEqual(p, '')
  })

  it('refresh_token is present as empty string (required field, no real refresh writer in container)', () => {
    const content = buildContainerVariantContent({ oauth, nowIso })
    const parsed = JSON.parse(content)
    assert.equal('refresh_token' in parsed.tokens, true)
    assert.equal(parsed.tokens.refresh_token, '')
  })

  it('STRONG: serialized string MUST NOT contain the real refresh_token VALUE (leak defense)', () => {
    const content = buildContainerVariantContent({ oauth, nowIso })
    assert.equal(content.includes('rt_secret'), false)
  })

  it('malformed JWT: still produces a structurally complete file (does not leak refresh_token); codex 0.125 will reject deserialization on the JWT shape, so functional GPT in container is not guaranteed in this branch — this test only enforces shape integrity', () => {
    const content = buildContainerVariantContent({
      oauth: { accessToken: 'malformed', refreshToken: 'rt' },
      nowIso,
    })
    const parsed = JSON.parse(content)
    assert.equal(parsed.tokens.account_id, '')
    assert.equal(parsed.tokens.access_token, 'malformed')
    assert.equal(parsed.tokens.id_token, 'malformed')
    assert.equal(parsed.tokens.refresh_token, '')
    // and still must not contain the real refresh_token VALUE
    assert.equal(content.includes('"rt"'), false)
  })
})
