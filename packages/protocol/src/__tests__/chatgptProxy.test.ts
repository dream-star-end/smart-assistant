import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  CHATGPT_PROXY_DOMAIN_ROOTS,
  buildChatGptPac,
  canonicalizeChatGptProxyHost,
  chatGptProxyUsername,
  isChatGptProxyAllowedHost,
  parseChatGptProxyConnectTarget,
  parseChatGptProxyUsername,
} from '../chatgptProxy.js'

describe('chatgpt proxy host allowlist', () => {
  it('accepts roots and subdomains, case-insensitive, trailing dot tolerant', () => {
    assert.equal(isChatGptProxyAllowedHost('chatgpt.com'), true)
    assert.equal(isChatGptProxyAllowedHost('CHATGPT.com.'), true)
    assert.equal(isChatGptProxyAllowedHost('ab.chatgpt.com'), true)
    assert.equal(isChatGptProxyAllowedHost('cdn.oaistatic.com'), true)
    assert.equal(isChatGptProxyAllowedHost('accounts.google.com'), true)
  })

  it('rejects lookalikes, unrelated hosts and IPs', () => {
    assert.equal(isChatGptProxyAllowedHost('notchatgpt.com'), false)
    assert.equal(isChatGptProxyAllowedHost('chatgpt.com.evil.net'), false)
    assert.equal(isChatGptProxyAllowedHost('google.com'), false)
    assert.equal(isChatGptProxyAllowedHost('mail.google.com'), false)
    assert.equal(isChatGptProxyAllowedHost('127.0.0.1'), false)
    assert.equal(isChatGptProxyAllowedHost('[::1]'), false)
    assert.equal(isChatGptProxyAllowedHost(''), false)
    assert.equal(isChatGptProxyAllowedHost('chatgpt.com/evil'), false)
  })

  it('canonicalizes', () => {
    assert.equal(canonicalizeChatGptProxyHost(' ChatGPT.COM. '), 'chatgpt.com')
    assert.equal(canonicalizeChatGptProxyHost('a b'), null)
    assert.equal(canonicalizeChatGptProxyHost('-bad.com'), null)
  })
})

describe('chatgpt proxy CONNECT target', () => {
  it('parses host:port', () => {
    assert.deepEqual(parseChatGptProxyConnectTarget('chatgpt.com:443'), {
      host: 'chatgpt.com',
      port: 443,
    })
  })
  it('rejects malformed authorities', () => {
    assert.equal(parseChatGptProxyConnectTarget('chatgpt.com'), null)
    assert.equal(parseChatGptProxyConnectTarget(':443'), null)
    assert.equal(parseChatGptProxyConnectTarget('chatgpt.com:99999'), null)
    assert.equal(parseChatGptProxyConnectTarget('chatgpt.com:abc'), null)
  })
})

describe('chatgpt proxy username', () => {
  it('round-trips', () => {
    assert.equal(chatGptProxyUsername(3), 'u3')
    assert.equal(chatGptProxyUsername(42n), 'u42')
    assert.equal(parseChatGptProxyUsername('u3'), 3)
    assert.equal(parseChatGptProxyUsername('u1234567890'), 1234567890)
  })
  it('rejects bad shapes', () => {
    assert.equal(parseChatGptProxyUsername('3'), null)
    assert.equal(parseChatGptProxyUsername('u0'), null)
    assert.equal(parseChatGptProxyUsername('u-1'), null)
    assert.equal(parseChatGptProxyUsername('u'), null)
    assert.equal(parseChatGptProxyUsername('u3x'), null)
    assert.equal(parseChatGptProxyUsername('admin'), null)
  })
})

describe('chatgpt PAC', () => {
  it('routes only allowlisted roots through HTTPS proxy', () => {
    const pac = buildChatGptPac('38-55-252-217.sslip.io', 8443)
    assert.match(pac, /function FindProxyForURL\(url, host\)/)
    assert.match(pac, /return "HTTPS 38-55-252-217\.sslip\.io:8443";/)
    assert.match(pac, /return "DIRECT";/)
    for (const root of CHATGPT_PROXY_DOMAIN_ROOTS) {
      assert.ok(pac.includes(`dnsDomainIs(h, ".${root}")`), root)
      assert.ok(pac.includes(`h === "${root}"`), root)
    }
    // Evaluate the PAC with a minimal dnsDomainIs shim to prove routing.
    const dnsDomainIs = (host: string, domain: string) => host.endsWith(domain)
    const fn = new Function('dnsDomainIs', `${pac}; return FindProxyForURL;`)(dnsDomainIs) as (
      url: string,
      host: string,
    ) => string
    assert.equal(fn('https://chatgpt.com/', 'chatgpt.com'), 'HTTPS 38-55-252-217.sslip.io:8443')
    assert.equal(
      fn('https://x.oaistatic.com/', 'x.oaistatic.com'),
      'HTTPS 38-55-252-217.sslip.io:8443',
    )
    assert.equal(fn('https://example.com/', 'example.com'), 'DIRECT')
    assert.equal(fn('https://notchatgpt.com/', 'notchatgpt.com'), 'DIRECT')
  })
  it('rejects bad proxy host/port', () => {
    assert.throws(() => buildChatGptPac('bad host', 8443))
    assert.throws(() => buildChatGptPac('ok.example', 0))
  })
})
