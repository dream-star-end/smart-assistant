import * as assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
/**
 * Tests for `buildCodexEnv` — env builder for codex CLI subprocesses.
 *
 * Load-bearing invariants:
 *   1. process.env keys flow through, except scrubbed Anthropic/CCB/gateway
 *      auth tokens (verified by spot-check on ANTHROPIC_API_KEY).
 *   2. proxyUrl injection is **explicit-only** — when AgentDef.proxyUrl is
 *      undefined, the returned env has NO HTTPS_PROXY/HTTP_PROXY keys at all
 *      (not undefined values), even if process.env.HTTPS_PROXY happens to be
 *      set. This is the "explicit per-agent" decision documented in
 *      AgentDef.proxyUrl — system-level proxy must not silently change codex
 *      behavior.
 *   3. proxyUrl='' (empty string) is treated as "not set" (same as undefined).
 *   4. Non-empty proxyUrl sets all four variants (HTTPS_PROXY / HTTP_PROXY +
 *      lowercase) for cross-runtime compatibility (Rust reqwest, Node fetch
 *      undici, plugin shells honor different conventions).
 */
import { buildCodexEnv } from '../codexRunner.js'

describe('buildCodexEnv', () => {
  // Snapshot keys we touch so each test starts clean. We only manage keys
  // we own; the test runner / Bun set hundreds of unrelated ones we leave alone.
  const MANAGED_KEYS = [
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'https_proxy',
    'http_proxy',
    'ALL_PROXY',
    'all_proxy',
    'NO_PROXY',
    'no_proxy',
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'OPENCLAUDE_GATEWAY_TOKEN',
  ]
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const k of MANAGED_KEYS) saved[k] = process.env[k]
    for (const k of MANAGED_KEYS) delete process.env[k]
  })
  afterEach(() => {
    for (const k of MANAGED_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('without opts: no PROXY keys present (not even undefined values)', () => {
    const env = buildCodexEnv()
    assert.equal(Object.hasOwn(env, 'HTTPS_PROXY'), false)
    assert.equal(Object.hasOwn(env, 'HTTP_PROXY'), false)
    assert.equal(Object.hasOwn(env, 'https_proxy'), false)
    assert.equal(Object.hasOwn(env, 'http_proxy'), false)
  })

  it('opts.proxyUrl undefined: no PROXY keys present', () => {
    const env = buildCodexEnv({ proxyUrl: undefined })
    assert.equal(Object.hasOwn(env, 'HTTPS_PROXY'), false)
    assert.equal(Object.hasOwn(env, 'HTTP_PROXY'), false)
    assert.equal(Object.hasOwn(env, 'https_proxy'), false)
    assert.equal(Object.hasOwn(env, 'http_proxy'), false)
  })

  it('opts.proxyUrl empty string: no PROXY keys present (treated as unset)', () => {
    const env = buildCodexEnv({ proxyUrl: '' })
    assert.equal(Object.hasOwn(env, 'HTTPS_PROXY'), false)
    assert.equal(Object.hasOwn(env, 'HTTP_PROXY'), false)
    assert.equal(Object.hasOwn(env, 'https_proxy'), false)
    assert.equal(Object.hasOwn(env, 'http_proxy'), false)
  })

  it('opts.proxyUrl non-empty: all four PROXY variants set to that URL', () => {
    const env = buildCodexEnv({
      proxyUrl: 'http://user:pass@proxy.example.com:8080',
    })
    assert.equal(env.HTTPS_PROXY, 'http://user:pass@proxy.example.com:8080')
    assert.equal(env.HTTP_PROXY, 'http://user:pass@proxy.example.com:8080')
    assert.equal(env.https_proxy, 'http://user:pass@proxy.example.com:8080')
    assert.equal(env.http_proxy, 'http://user:pass@proxy.example.com:8080')
  })

  it('explicit-only: process.env.HTTPS_PROXY does NOT leak when proxyUrl is unset', () => {
    process.env.HTTPS_PROXY = 'http://systemd-injected.example:1234'
    const env = buildCodexEnv()
    // Decision: codex egress is explicit per-agent. A future systemd-level
    // HTTPS_PROXY must not silently appear in codex's env.
    assert.equal(Object.hasOwn(env, 'HTTPS_PROXY'), false)
  })

  it('explicit override: agent proxyUrl wins over inherited process.env.HTTPS_PROXY', () => {
    process.env.HTTPS_PROXY = 'http://systemd-injected.example:1234'
    const env = buildCodexEnv({ proxyUrl: 'http://agent.example:9999' })
    assert.equal(env.HTTPS_PROXY, 'http://agent.example:9999')
    assert.equal(env.HTTP_PROXY, 'http://agent.example:9999')
    assert.equal(env.https_proxy, 'http://agent.example:9999')
    assert.equal(env.http_proxy, 'http://agent.example:9999')
  })

  it('scrub: ANTHROPIC_API_KEY in process.env is removed', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-secret'
    const env = buildCodexEnv()
    assert.equal(Object.hasOwn(env, 'ANTHROPIC_API_KEY'), false)
  })

  it('scrub by prefix: CLAUDE_CODE_OAUTH_TOKEN, OPENCLAUDE_* removed', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-x'
    process.env.OPENCLAUDE_GATEWAY_TOKEN = 'gw-x'
    const env = buildCodexEnv()
    assert.equal(Object.hasOwn(env, 'CLAUDE_CODE_OAUTH_TOKEN'), false)
    assert.equal(Object.hasOwn(env, 'OPENCLAUDE_GATEWAY_TOKEN'), false)
  })

  // codex CLI is Rust (reqwest) + Node — reqwest honors ALL_PROXY / NO_PROXY
  // in addition to HTTPS_PROXY/HTTP_PROXY. Inheriting either would break the
  // explicit-only invariant: ALL_PROXY would silently route egress, and a
  // stale NO_PROXY could carve out hosts from a per-agent proxyUrl.
  it('explicit-only: process.env.ALL_PROXY does NOT leak when proxyUrl is unset', () => {
    process.env.ALL_PROXY = 'socks5://systemd-injected.example:1080'
    const env = buildCodexEnv()
    assert.equal(Object.hasOwn(env, 'ALL_PROXY'), false)
  })

  it('explicit-only: process.env.NO_PROXY does NOT leak even when proxyUrl is set', () => {
    process.env.NO_PROXY = 'api.openai.com,localhost'
    const env = buildCodexEnv({ proxyUrl: 'http://agent.example:9999' })
    // NO_PROXY would otherwise carve out the OpenAI host from the agent's
    // proxy, defeating the per-agent egress decision.
    assert.equal(Object.hasOwn(env, 'NO_PROXY'), false)
    assert.equal(Object.hasOwn(env, 'no_proxy'), false)
    // Sanity: HTTPS_PROXY still set.
    assert.equal(env.HTTPS_PROXY, 'http://agent.example:9999')
  })

  it('explicit-only: lowercase all_proxy / no_proxy variants also scrubbed', () => {
    process.env.all_proxy = 'http://systemd.example:1234'
    process.env.no_proxy = 'localhost'
    const env = buildCodexEnv()
    assert.equal(Object.hasOwn(env, 'all_proxy'), false)
    assert.equal(Object.hasOwn(env, 'no_proxy'), false)
  })
})
