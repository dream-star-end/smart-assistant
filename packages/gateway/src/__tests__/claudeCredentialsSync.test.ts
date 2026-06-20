import * as assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
/**
 * Tests for claudeCredentialsSync — the pure decision logic that keeps
 * `~/.claude/.credentials.json` as the single authority source for the Claude
 * subscription OAuth token, plus the synchronous status reader.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/claudeCredentialsSync.test.ts
 */
import { describe, it } from 'node:test'
import { decideClaudeCredsWrite, readClaudeCredentialsSync } from '../claudeCredentialsSync.js'

const oauth = {
  accessToken: 'sk-ant-oat-new',
  refreshToken: 'sk-ant-ort-new',
  expiresAt: 2_000,
  scope: 'user:inference user:profile',
}

const prevFile = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: 'sk-ant-oat-old',
      refreshToken: 'sk-ant-ort-old',
      expiresAt: 1_000,
      scopes: ['user:inference'],
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
      ...over,
    },
  })

describe('decideClaudeCredsWrite — callback path (force-write)', () => {
  it('writes a fresh file with token triplet + scopes parsed from scope string', () => {
    const d = decideClaudeCredsWrite({ oauth, previousFileText: null })
    assert.equal(d.action, 'write')
    if (d.action !== 'write') return
    const p = JSON.parse(d.content)
    assert.equal(p.claudeAiOauth.accessToken, 'sk-ant-oat-new')
    assert.equal(p.claudeAiOauth.refreshToken, 'sk-ant-ort-new')
    assert.equal(p.claudeAiOauth.expiresAt, 2_000)
    assert.deepEqual(p.claudeAiOauth.scopes, ['user:inference', 'user:profile'])
  })

  it('preserves subscriptionType / rateLimitTier / unknown sub-fields on update', () => {
    const prev = prevFile({ betaFlag: 'keepme' })
    const d = decideClaudeCredsWrite({ oauth, previousFileText: prev })
    assert.equal(d.action, 'write')
    if (d.action !== 'write') return
    const p = JSON.parse(d.content)
    assert.equal(p.claudeAiOauth.subscriptionType, 'max')
    assert.equal(p.claudeAiOauth.rateLimitTier, 'default_claude_max_20x')
    assert.equal(p.claudeAiOauth.betaFlag, 'keepme')
    // token triplet overwritten with the new values
    assert.equal(p.claudeAiOauth.accessToken, 'sk-ant-oat-new')
    assert.equal(p.claudeAiOauth.expiresAt, 2_000)
  })

  it('preserves unknown TOP-LEVEL keys in the existing file', () => {
    const prev = JSON.stringify({
      claudeAiOauth: { accessToken: 'x', refreshToken: 'y', expiresAt: 1 },
      someOtherTool: { hello: 'world' },
    })
    const d = decideClaudeCredsWrite({ oauth, previousFileText: prev })
    assert.equal(d.action, 'write')
    if (d.action !== 'write') return
    const p = JSON.parse(d.content)
    assert.deepEqual(p.someOtherTool, { hello: 'world' })
  })

  it('falls back to prior scopes when no fresh scope string is given', () => {
    const prev = prevFile()
    const d = decideClaudeCredsWrite({
      oauth: { ...oauth, scope: undefined },
      previousFileText: prev,
    })
    assert.equal(d.action, 'write')
    if (d.action !== 'write') return
    const p = JSON.parse(d.content)
    assert.deepEqual(p.claudeAiOauth.scopes, ['user:inference'])
  })

  it('treats an unparseable previous file as no previous file (still writes)', () => {
    const d = decideClaudeCredsWrite({ oauth, previousFileText: 'not json' })
    assert.equal(d.action, 'write')
    if (d.action !== 'write') return
    const p = JSON.parse(d.content)
    assert.equal(p.claudeAiOauth.accessToken, 'sk-ant-oat-new')
  })
})

describe('decideClaudeCredsWrite — boot-seed path (onlyIfMissing)', () => {
  it('skips when a file already exists (even a fresher one) — never touches it', () => {
    const prev = prevFile({ expiresAt: 5_000 })
    const d = decideClaudeCredsWrite({ oauth, previousFileText: prev, onlyIfMissing: true })
    assert.equal(d.action, 'skip')
    if (d.action !== 'skip') return
    assert.match(d.reason, /already exists/)
  })

  it('skips when a file exists even if it is older than ours', () => {
    const prev = prevFile({ expiresAt: 1_000 })
    const d = decideClaudeCredsWrite({ oauth, previousFileText: prev, onlyIfMissing: true })
    assert.equal(d.action, 'skip')
  })

  it('skips when an existing file is unparseable (still a file — leave it alone)', () => {
    const d = decideClaudeCredsWrite({ oauth, previousFileText: 'not json', onlyIfMissing: true })
    assert.equal(d.action, 'skip')
  })

  it('writes (recovery) only when the file is missing entirely', () => {
    const d = decideClaudeCredsWrite({ oauth, previousFileText: null, onlyIfMissing: true })
    assert.equal(d.action, 'write')
  })
})

describe('decideClaudeCredsWrite — refresh path (ownership check, parity with codex)', () => {
  it('writes when the existing refreshToken matches the consumed one', () => {
    const prev = prevFile({ refreshToken: 'sk-ant-ort-old' })
    const d = decideClaudeCredsWrite({
      oauth,
      previousFileText: prev,
      expectedPreviousRefreshToken: 'sk-ant-ort-old',
    })
    assert.equal(d.action, 'write')
  })

  it('skips when the existing refreshToken differs (re-logged via claude CLI)', () => {
    const prev = prevFile({ refreshToken: 'sk-ant-ort-user-override' })
    const d = decideClaudeCredsWrite({
      oauth,
      previousFileText: prev,
      expectedPreviousRefreshToken: 'sk-ant-ort-old',
    })
    assert.equal(d.action, 'skip')
    if (d.action !== 'skip') return
    assert.match(d.reason, /differs/)
  })

  it('skips when the existing file has no refreshToken (unknown format)', () => {
    const prev = JSON.stringify({ claudeAiOauth: { accessToken: 'x' } })
    const d = decideClaudeCredsWrite({
      oauth,
      previousFileText: prev,
      expectedPreviousRefreshToken: 'sk-ant-ort-old',
    })
    assert.equal(d.action, 'skip')
    if (d.action !== 'skip') return
    assert.match(d.reason, /no refreshToken|unknown format/)
  })

  it('writes (recovery) when no previous file exists', () => {
    const d = decideClaudeCredsWrite({
      oauth,
      previousFileText: null,
      expectedPreviousRefreshToken: 'sk-ant-ort-old',
    })
    assert.equal(d.action, 'write')
  })
})

describe('readClaudeCredentialsSync', () => {
  it('parses the official credentials.json shape', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-claude-creds-'))
    try {
      const fp = join(dir, '.credentials.json')
      writeFileSync(fp, prevFile())
      const got = readClaudeCredentialsSync(fp)
      assert.ok(got)
      assert.equal(got?.accessToken, 'sk-ant-oat-old')
      assert.equal(got?.expiresAt, 1_000)
      assert.deepEqual(got?.scopes, ['user:inference'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns null when the file is missing', () => {
    assert.equal(readClaudeCredentialsSync('/no/such/path/.credentials.json'), null)
  })

  it('returns null when the file is not valid JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-claude-creds-'))
    try {
      const fp = join(dir, '.credentials.json')
      writeFileSync(fp, 'garbage')
      assert.equal(readClaudeCredentialsSync(fp), null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
