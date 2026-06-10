import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CHATGPT_PROXY_CORS_HEADERS,
  buildChatGptProxyUpstreamHeaders,
  canonicalizeChatGptProxyHost,
  chatGptProxySessionEntryPath,
  extractChatGptProxySessionToken,
  filterChatGptProxyCookieHeader,
  isRewriteableChatGptProxyContentType,
  proxyPathForAllowedChatGptUrl,
  resolveChatGptProxyTarget,
  rewriteChatGptProxyLocation,
  rewriteChatGptProxySetCookie,
  rewriteChatGptProxyText,
} from '../chatgptWebProxy.js'

function target(path: string) {
  const resolved = resolveChatGptProxyTarget(new URL(path, 'https://oc.local'))
  assert.ok(resolved, `expected target for ${path}`)
  return resolved
}

describe('ChatGPT web proxy target resolution', () => {
  it('resolves default and encoded https host targets with canonical lowercase host', () => {
    const root = target('/api/chatgpt-web')
    assert.equal(root.host, 'chatgpt.com')
    assert.equal(root.url.href, 'https://chatgpt.com/')

    const mixed = target('/api/chatgpt-web/https/ChatGPT.com/backend-api/models?x=1')
    assert.equal(mixed.host, 'chatgpt.com')
    assert.equal(mixed.routeBase, '/api/chatgpt-web/https/chatgpt.com')
    assert.equal(mixed.url.href, 'https://chatgpt.com/backend-api/models?x=1')
  })

  it('resolves scoped session proxy paths and keeps that scope when rewriting URLs', () => {
    const entry = chatGptProxySessionEntryPath('tok_1234567890123456')
    assert.equal(entry, '/api/chatgpt-web/_session/tok_1234567890123456/https/chatgpt.com/')
    assert.equal(
      extractChatGptProxySessionToken(new URL(entry, 'https://oc.local')),
      'tok_1234567890123456',
    )
    const scoped = target(`${entry}backend-api/models`)
    assert.equal(
      scoped.routeBase,
      '/api/chatgpt-web/_session/tok_1234567890123456/https/chatgpt.com',
    )
    assert.equal(
      proxyPathForAllowedChatGptUrl('https://auth.openai.com/login', scoped),
      '/api/chatgpt-web/_session/tok_1234567890123456/https/auth.openai.com/login',
    )
  })

  it('rejects userinfo, ports, encoded separators, IPs, and non-allowlisted hosts', () => {
    assert.equal(canonicalizeChatGptProxyHost('user@chatgpt.com'), null)
    assert.equal(canonicalizeChatGptProxyHost('chatgpt.com:443'), null)
    assert.equal(canonicalizeChatGptProxyHost('chatgpt.com%2fevil.com'), null)
    assert.equal(canonicalizeChatGptProxyHost('[::1]'), null)
    assert.equal(canonicalizeChatGptProxyHost('127.0.0.1'), null)
    assert.equal(canonicalizeChatGptProxyHost('chatgpt.com.evil.example'), null)
  })
})

describe('ChatGPT web proxy URL and redirect rewriting', () => {
  const base = target('/api/chatgpt-web/https/chatgpt.com/')

  it('rewrites allowed absolute, protocol-relative, and same-origin relative URLs', () => {
    assert.equal(
      proxyPathForAllowedChatGptUrl('https://auth.openai.com/authorize?x=1', base),
      '/api/chatgpt-web/https/auth.openai.com/authorize?x=1',
    )
    assert.equal(
      rewriteChatGptProxyLocation('//cdn.oaistatic.com/assets/app.js', base),
      '/api/chatgpt-web/https/cdn.oaistatic.com/assets/app.js',
    )
    assert.equal(
      rewriteChatGptProxyLocation('/backend-api/accounts/check', base),
      '/api/chatgpt-web/https/chatgpt.com/backend-api/accounts/check',
    )
  })

  it('blocks disallowed redirect targets', () => {
    assert.equal(rewriteChatGptProxyLocation('http://chatgpt.com/insecure', base), null)
    assert.equal(rewriteChatGptProxyLocation('https://evil.example/path', base), null)
    assert.equal(rewriteChatGptProxyLocation('https://chatgpt.com:8443/path', base), null)
  })
})

describe('ChatGPT web proxy cookies', () => {
  it('renames response cookies and scopes them to canonical host route', () => {
    const rewritten = rewriteChatGptProxySetCookie(
      'session=abc; Domain=.chatgpt.com; Path=/; Secure; HttpOnly; SameSite=None',
      'chatgpt.com',
    )
    assert.equal(
      rewritten,
      'oc_cgpt_chatgpt_com__session=abc; Path=/api/chatgpt-web/; Secure; HttpOnly; SameSite=None',
    )
  })

  it('forwards only current-host prefixed cookies and drops oc_session / unrelated cookies', () => {
    const forwarded = filterChatGptProxyCookieHeader(
      [
        'oc_session=platform-jwt',
        'theme=dark',
        'oc_cgpt_chatgpt_com__session=abc',
        'oc_cgpt_auth_openai_com__session=wrong-host',
      ].join('; '),
      'chatgpt.com',
    )
    assert.equal(forwarded, 'session=abc')
  })
})

describe('ChatGPT web proxy request headers', () => {
  it('strips platform Authorization by default but can forward ChatGPT upstream bearer on scoped routes', () => {
    const base = target('/api/chatgpt-web/_session/tok_1234567890123456/https/chatgpt.com/')
    const requestHeaders = {
      authorization: 'Bearer openai-access-token',
      cookie: [
        'oc_session=platform-jwt',
        'oc_cgpt_chatgpt_com__session=chatgpt-cookie',
        'theme=dark',
      ].join('; '),
      host: 'oc.local',
      origin: 'null',
      referer: 'https://oc.local/',
    }

    const stripped = buildChatGptProxyUpstreamHeaders(requestHeaders, base)
    assert.equal(stripped.authorization, undefined)
    assert.equal(stripped.cookie, 'session=chatgpt-cookie')
    assert.equal(stripped.host, 'chatgpt.com')

    const forwarded = buildChatGptProxyUpstreamHeaders(requestHeaders, base, {
      forwardAuthorization: true,
    })
    assert.equal(forwarded.authorization, 'Bearer openai-access-token')
  })
})

describe('ChatGPT web proxy text rewriting', () => {
  it('rewrites root-relative and allowed absolute URLs, then injects bootstrap into HTML', () => {
    const base = target('/api/chatgpt-web/https/chatgpt.com/')
    const rewritten = rewriteChatGptProxyText(
      '<html><head><script src="/_next/static/app.js" integrity="sha256-x"></script></head><body><a href="https://auth.openai.com/login">login</a><script>fetch("/backend-api/conversation")</script></body></html>',
      base,
    )
    assert.match(rewritten, /src="\/api\/chatgpt-web\/https\/chatgpt\.com\/_next\/static\/app\.js"/)
    assert.match(rewritten, /href="\/api\/chatgpt-web\/https\/auth\.openai\.com\/login"/)
    assert.match(
      rewritten,
      /fetch\("\/api\/chatgpt-web\/https\/chatgpt\.com\/backend-api\/conversation"\)/,
    )
    assert.equal(rewritten.includes('integrity='), false)
    assert.match(rewritten, /data-openclaude-chatgpt-proxy/)
    assert.match(rewritten, /mappedToProxy = isProxyUrl\(mapped\);/)
  })

  it('preserves React streaming marker strings while rewriting real root-relative paths', () => {
    const base = target('/api/chatgpt-web/https/chatgpt.com/')
    const rewritten = rewriteChatGptProxyText(
      '<script>if("/$"===d||"/&"===d){}; fetch("/backend-api/conversation")</script>',
      base,
    )

    assert.match(rewritten, /"\/\$"===d/)
    assert.match(rewritten, /"\/&"===d/)
    assert.doesNotMatch(rewritten, /https\/chatgpt\.com\/[$&]/)
    assert.match(
      rewritten,
      /fetch\("\/api\/chatgpt-web\/https\/chatgpt\.com\/backend-api\/conversation"\)/,
    )

    const restored = rewriteChatGptProxyText(
      '<script>if("/api/chatgpt-web/https/chatgpt.com/$"===d||"/api/chatgpt-web/https/chatgpt.com/&"===d){};</script>',
      base,
    )
    assert.match(restored, /"\/\$"===d/)
    assert.match(restored, /"\/&"===d/)
  })
})

describe('ChatGPT web proxy opaque iframe CORS', () => {
  it('allows only opaque sandbox Origin:null credentialed fetches for the proxy route', () => {
    assert.equal(CHATGPT_PROXY_CORS_HEADERS['Access-Control-Allow-Origin'], 'null')
    assert.equal(CHATGPT_PROXY_CORS_HEADERS['Access-Control-Allow-Credentials'], 'true')
    assert.match(CHATGPT_PROXY_CORS_HEADERS['Access-Control-Allow-Methods'], /OPTIONS/)
  })
})

describe('ChatGPT web proxy streaming responses', () => {
  it('does not buffer or rewrite server-sent events', () => {
    assert.equal(isRewriteableChatGptProxyContentType('text/html; charset=utf-8'), true)
    assert.equal(isRewriteableChatGptProxyContentType('application/javascript'), true)
    assert.equal(isRewriteableChatGptProxyContentType('text/event-stream'), false)
    assert.equal(isRewriteableChatGptProxyContentType('text/event-stream; charset=utf-8'), false)
    assert.equal(isRewriteableChatGptProxyContentType('application/json; charset=utf-8'), false)
    assert.equal(isRewriteableChatGptProxyContentType('text/plain'), false)
  })
})
