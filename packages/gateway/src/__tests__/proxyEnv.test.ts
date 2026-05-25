import * as assert from 'node:assert/strict'
/**
 * Tests for the proxy env plumbing helpers and DockerBackend argv shape.
 *
 * Load-bearing invariants:
 *  1. normalizeProxyUrl collapses empty / whitespace strings to undefined
 *     so the fallback chain agent.proxyUrl ?? config.proxyUrl works.
 *  2. maskProxyUrl strips user:pass from display values but keeps host/port.
 *  3. looksRedactedProxyUrl flags any star so a round-tripped GET to PUT can
 *     be rejected at the API layer.
 *  4. DockerBackend NEVER puts a proxy credential into the docker run argv:
 *     proxy keys use -e KEY (no value), all other passthrough keys use
 *     -e KEY=value. This protects user:pass from ps and /proc/PID/cmdline.
 */
import { describe, it } from 'node:test'
import {
  PROXY_ENV_KEYS,
  looksRedactedProxyUrl,
  maskProxyUrl,
  normalizeProxyUrl,
} from '../proxyEnv.js'
import { buildDockerArgs } from '../terminalBackend.js'

describe('normalizeProxyUrl', () => {
  it('undefined to undefined', () => {
    assert.equal(normalizeProxyUrl(undefined), undefined)
  })
  it('empty string to undefined', () => {
    assert.equal(normalizeProxyUrl(''), undefined)
  })
  it('whitespace-only to undefined', () => {
    assert.equal(normalizeProxyUrl('   \t  '), undefined)
  })
  it('valid URL passes through trimmed', () => {
    assert.equal(normalizeProxyUrl('  http://proxy.example:8080  '), 'http://proxy.example:8080')
  })
})

describe('maskProxyUrl', () => {
  it('undefined returns undefined (preserved for fall-through)', () => {
    assert.equal(maskProxyUrl(undefined), undefined)
  })
  it('credentialless URL passes through unchanged', () => {
    assert.equal(maskProxyUrl('http://proxy.example:8080'), 'http://proxy.example:8080')
  })
  it('user:pass URL masks both', () => {
    const m = maskProxyUrl('http://user:pass@proxy.example:8080')
    assert.equal(m?.includes('user'), false)
    assert.equal(m?.includes('pass'), false)
    assert.equal(m?.includes('***'), true)
    assert.equal(m?.includes('proxy.example'), true)
    assert.equal(m?.includes('8080'), true)
  })
  it('user-only URL still masks', () => {
    const m = maskProxyUrl('http://user@proxy.example:8080')
    assert.equal(m?.includes('user'), false)
    assert.equal(m?.includes('***'), true)
  })
  it('malformed URL returns generic stars (cannot safely classify)', () => {
    // 'not a url' has whitespace -> new URL() throws -> catch branch.
    assert.equal(maskProxyUrl('not a url'), '***')
  })
})

describe('looksRedactedProxyUrl', () => {
  it('flags masked round-trip', () => {
    assert.equal(looksRedactedProxyUrl('http://***:***@host:8080'), true)
  })
  it('flags any value containing a star (intentional conservative rule)', () => {
    assert.equal(looksRedactedProxyUrl('http://user:p*ss@host:8080'), true)
  })
  it('clean URL passes', () => {
    assert.equal(looksRedactedProxyUrl('http://user:pass@host:8080'), false)
  })
})

describe('PROXY_ENV_KEYS', () => {
  it('covers exactly the 4 conventional spellings (HTTPS/HTTP times upper/lower)', () => {
    assert.deepEqual([...PROXY_ENV_KEYS].sort(), [
      'HTTPS_PROXY',
      'HTTP_PROXY',
      'http_proxy',
      'https_proxy',
    ])
  })
})

describe('buildDockerArgs: proxy credential isolation', () => {
  const BASE_OPTS = {
    command: '/bin/true',
    args: [],
    cwd: '/tmp',
    stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
  }

  it('proxy keys produce -e KEY (no value); credentials never appear in argv', () => {
    const argv = buildDockerArgs(
      { type: 'docker', image: 'alpine' },
      {
        ...BASE_OPTS,
        env: {
          PATH: '/usr/bin',
          HOME: '/root',
          HTTPS_PROXY: 'http://secret-user:secret-pass@proxy:8080',
          HTTP_PROXY: 'http://secret-user:secret-pass@proxy:8080',
          https_proxy: 'http://secret-user:secret-pass@proxy:8080',
          http_proxy: 'http://secret-user:secret-pass@proxy:8080',
          OPENCLAUDE_AGENT_ID: 'main',
        },
      },
    )
    const joined = argv.join(' ')
    assert.equal(
      joined.includes('secret-user'),
      false,
      'proxy username MUST NOT appear in docker run argv',
    )
    assert.equal(
      joined.includes('secret-pass'),
      false,
      'proxy password MUST NOT appear in docker run argv',
    )
    for (const key of PROXY_ENV_KEYS) {
      const idx = argv.indexOf(key)
      assert.ok(idx >= 0, `expected ${key} (bare) in argv`)
      assert.equal(argv[idx - 1], '-e', `${key} must be preceded by -e`)
      // The arg immediately after should NOT be the leaky `KEY=value` form.
      assert.equal(argv[idx].includes('='), false, `${key} must be passed bare, not as KEY=value`)
    }
    // Non-proxy passthrough still uses -e KEY=value
    assert.ok(argv.includes('PATH=/usr/bin'), 'PATH should still be -e PATH=value')
    assert.ok(argv.includes('OPENCLAUDE_AGENT_ID=main'), 'OPENCLAUDE_* should be -e KEY=value')
  })

  it('proxy key in envAllowlist still uses -e KEY (no value leak)', () => {
    // Regression for Codex review finding: if operator adds HTTPS_PROXY to
    // envAllowlist, it must NOT regress to -e KEY=value.
    const argv = buildDockerArgs(
      { type: 'docker', image: 'alpine', envAllowlist: ['HTTPS_PROXY'] },
      {
        ...BASE_OPTS,
        env: {
          PATH: '/usr/bin',
          HTTPS_PROXY: 'http://secret-user:secret-pass@proxy:8080',
        },
      },
    )
    const joined = argv.join(' ')
    assert.equal(
      joined.includes('secret-user'),
      false,
      'allowlisted proxy key must NOT regress to -e KEY=value',
    )
    assert.equal(
      joined.includes('secret-pass'),
      false,
      'allowlisted proxy key must NOT regress to -e KEY=value',
    )
    // Still forwarded, just bare.
    const idx = argv.indexOf('HTTPS_PROXY')
    assert.ok(idx >= 0)
    assert.equal(argv[idx - 1], '-e')
  })

  it('no proxy in env -> no proxy keys in argv at all', () => {
    const argv = buildDockerArgs(
      { type: 'docker', image: 'alpine' },
      { ...BASE_OPTS, env: { PATH: '/usr/bin' } },
    )
    for (const key of PROXY_ENV_KEYS) {
      assert.equal(argv.includes(key), false, `${key} must not appear when env has none`)
    }
  })
})
