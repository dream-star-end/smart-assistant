import assert from 'node:assert/strict'
import test from 'node:test'

import { PINNED_APP_ORIGIN } from '../src/security-policy.mjs'
import {
  findOpenClaudeUrlInArgv,
  parseOpenClaudeDeepLink,
} from '../src/desktop-protocol.mjs'

const ENROLL_ID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
const ENROLL_CODE = 'ab'.repeat(32)
const VALID_ENROLL = `openclaude://enroll/callback?enrollment_id=${ENROLL_ID}&code=${ENROLL_CODE}`

test('findOpenClaudeUrlInArgv returns the first protocol argument and ignores others', () => {
  assert.equal(
    findOpenClaudeUrlInArgv(['Clarvy.exe', 'openclaude://open?path=/settings']),
    'openclaude://open?path=/settings',
  )
  assert.equal(findOpenClaudeUrlInArgv(['Clarvy.exe', '--home']), null)
  assert.equal(findOpenClaudeUrlInArgv(['https://claudeai.chat/settings']), null)
  assert.equal(findOpenClaudeUrlInArgv('not-an-array'), null)
})

test('parseOpenClaudeDeepLink allows only pinned-origin openclaude://open?path=/... targets', () => {
  assert.deepEqual(parseOpenClaudeDeepLink('openclaude://open?path=/settings'), {
    action: 'open',
    targetUrl: `${PINNED_APP_ORIGIN}/settings`,
  })
  assert.deepEqual(parseOpenClaudeDeepLink('openclaude://open?path=/chat/123?x=1'), {
    action: 'open',
    targetUrl: `${PINNED_APP_ORIGIN}/chat/123?x=1`,
  })
  assert.deepEqual(parseOpenClaudeDeepLink('openclaude://open/?path=/'), {
    action: 'open',
    targetUrl: `${PINNED_APP_ORIGIN}/`,
  })
})

test('parseOpenClaudeDeepLink ignores malformed, unpinned, and non-open hosts', () => {
  const ignored = [
    '',
    ' https://claudeai.chat/',
    'https://claudeai.chat/settings',
    'openclaude://navigate?path=/settings',
    'openclaude://open/extra?path=/settings',
    'openclaude://user:pass@open?path=/settings',
    'openclaude://open',
    'openclaude://open?path=settings',
    'openclaude://open?path=https://claudeai.chat/settings',
    'openclaude://open?path=//evil.example',
    'openclaude://open?path=%2F%2Fevil.example',
    'openclaude://open?path=/\\windows',
    'openclaude://open?path=/one&path=/two',
    `openclaude://open?path=/${'a'.repeat(9000)}`,
  ]
  for (const raw of ignored) {
    const parsed = parseOpenClaudeDeepLink(raw)
    assert.equal(parsed.action, 'ignore', raw)
    assert.equal('targetUrl' in parsed, false, raw)
  }
})

test('parseOpenClaudeDeepLink accepts a well-formed enroll callback and does not navigate', () => {
  assert.deepEqual(parseOpenClaudeDeepLink(VALID_ENROLL), {
    action: 'enroll-callback',
    enrollmentId: ENROLL_ID,
    code: ENROLL_CODE,
  })
  assert.deepEqual(
    parseOpenClaudeDeepLink(
      `openclaude://enroll/callback/?enrollment_id=${ENROLL_ID.toUpperCase()}&code=${ENROLL_CODE.toUpperCase()}`,
    ),
    {
      action: 'enroll-callback',
      enrollmentId: ENROLL_ID,
      code: ENROLL_CODE,
    },
  )
  const parsed = parseOpenClaudeDeepLink(VALID_ENROLL)
  assert.equal('targetUrl' in parsed, false)
})

test('parseOpenClaudeDeepLink rejects enroll callbacks with extra query, hash, port, or bad ids', () => {
  const ignored = [
    [`${VALID_ENROLL}&foo=1`, 'invalid-query'],
    [`${VALID_ENROLL}#fragment`, 'hash'],
    [
      `openclaude://enroll:443/callback?enrollment_id=${ENROLL_ID}&code=${ENROLL_CODE}`,
      'port',
    ],
    [`openclaude://enroll/callback?enrollment_id=not-a-uuid&code=${ENROLL_CODE}`, 'invalid-enrollment-id'],
    [`openclaude://enroll/callback?enrollment_id=${ENROLL_ID}&code=abcd`, 'invalid-code'],
    [`openclaude://enroll/callback?enrollment_id=${ENROLL_ID}&code=${'g'.repeat(64)}`, 'invalid-code'],
    [`openclaude://enroll/callback?enrollment_id=${ENROLL_ID}&code=${'a'.repeat(63)}`, 'invalid-code'],
    [
      `openclaude://user:pass@enroll/callback?enrollment_id=${ENROLL_ID}&code=${ENROLL_CODE}`,
      'credentials',
    ],
    [
      `openclaude://enroll//callback?enrollment_id=${ENROLL_ID}&code=${ENROLL_CODE}`,
      'unsupported-host',
    ],
    [
      `openclaude://enroll/callback/extra?enrollment_id=${ENROLL_ID}&code=${ENROLL_CODE}`,
      'unsupported-host',
    ],
    [`openclaude://enroll/callback?enrollment_id=${ENROLL_ID}&enrollment_id=${ENROLL_ID}&code=${ENROLL_CODE}`, 'invalid-query'],
    [`openclaude://enroll/callback?enrollment_id=${ENROLL_ID}&code=${ENROLL_CODE}&code=${ENROLL_CODE}`, 'invalid-query'],
    [`openclaude://enroll/callback?enrollment_id=${ENROLL_ID}`, 'invalid-query'],
    [`openclaude://${'a'.repeat(8200)}`, 'invalid-url'],
  ]
  for (const [raw, reason] of ignored) {
    const parsed = parseOpenClaudeDeepLink(raw)
    assert.equal(parsed.action, 'ignore', raw)
    assert.equal(parsed.reason, reason, raw)
    assert.equal('enrollmentId' in parsed, false, raw)
    assert.equal('code' in parsed, false, raw)
  }
})
