import assert from 'node:assert/strict'
import test from 'node:test'

import { PINNED_APP_ORIGIN } from '../src/security-policy.mjs'
import {
  findOpenClaudeUrlInArgv,
  parseOpenClaudeDeepLink,
} from '../src/desktop-protocol.mjs'

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
