import * as assert from 'node:assert/strict'
import { type Server, createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import {
  CHATGPT_PROXY_CORS_HEADERS,
  buildChatGptProxyUpstreamHeaders,
  buildChatGptSidecarUpstreamHeaders,
  canonicalizeChatGptProxyHost,
  chatGptProxySessionEntryPath,
  extractChatGptProxySessionToken,
  filterChatGptProxyCookieHeader,
  handleChatGptWebProxy,
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
      'oc_cgpt_v2_chatgpt_com__session=abc; Path=/api/chatgpt-web/; Secure; HttpOnly; SameSite=None',
    )
  })

  it('forwards only current-host v2 prefixed cookies and drops oc_session / unrelated / v1 cookies', () => {
    const forwarded = filterChatGptProxyCookieHeader(
      [
        'oc_session=platform-jwt',
        'theme=dark',
        'oc_cgpt_chatgpt_com__session=old-blocked-cookie',
        'oc_cgpt_v2_chatgpt_com__session=abc',
        'oc_cgpt_v2_auth_openai_com__session=wrong-host',
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
        'oc_cgpt_v2_chatgpt_com__session=chatgpt-cookie',
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

describe('ChatGPT web proxy sidecar upstream headers', () => {
  it('drops fingerprint headers so curl_cffi owns the Chrome JA3 identity', () => {
    const base = target('/api/chatgpt-web/https/chatgpt.com/backend-api/conversation')
    const headers = buildChatGptSidecarUpstreamHeaders(
      {
        'user-agent': 'Mozilla/5.0 (iPhone) Safari/604.1',
        'sec-ch-ua': '"Chromium";v="120"',
        'sec-ch-ua-platform': '"iOS"',
        'sec-fetch-mode': 'cors',
        'accept-language': 'zh-CN',
        'accept-encoding': 'gzip, br',
        accept: 'application/json',
        'content-type': 'application/json',
        'oai-language': 'en-US',
        host: 'oc.local',
        origin: 'https://oc.local',
        referer: 'https://oc.local/app',
        cookie: 'oc_cgpt_v2_chatgpt_com__session_token=abc; unrelated=zzz',
      },
      base,
    )
    // fingerprint headers must not leak to the upstream
    for (const dropped of [
      'user-agent',
      'sec-ch-ua',
      'sec-ch-ua-platform',
      'sec-fetch-mode',
      'accept-language',
      'accept-encoding',
    ]) {
      assert.equal(headers[dropped], undefined)
    }
    // semantic + app headers are preserved
    assert.equal(headers.accept, 'application/json')
    assert.equal(headers['content-type'], 'application/json')
    assert.equal(headers['oai-language'], 'en-US')
    // origin/referer rewritten to the upstream, cookie un-prefixed and filtered
    assert.equal(headers.origin, 'https://chatgpt.com')
    assert.equal(headers.referer, base.url.href)
    assert.equal(headers.cookie, 'session_token=abc')
  })

  it('only forwards authorization when explicitly allowed', () => {
    const base = target('/api/chatgpt-web/https/chatgpt.com/')
    const withAuth = { authorization: 'Bearer up' }
    assert.equal(buildChatGptSidecarUpstreamHeaders(withAuth, base).authorization, undefined)
    assert.equal(
      buildChatGptSidecarUpstreamHeaders(withAuth, base, { forwardAuthorization: true })
        .authorization,
      'Bearer up',
    )
  })
})

describe('ChatGPT web proxy sidecar request body', () => {
  function listen(server: Server): Promise<number> {
    return new Promise((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
    )
  }

  // Regression guard: the gateway→sidecar hop MUST send an explicit
  // Content-Length and the full body. The Python sidecar reads the body strictly
  // by Content-Length (no chunked reader), so a chunked/no-length request would
  // silently submit an empty body upstream — breaking login and every POST.
  it('delivers the full POST body with an accurate Content-Length', async () => {
    // mock sidecar: reads body by Content-Length exactly like the Python handler
    const sidecar = createServer((req, res) => {
      const len = Number(req.headers['content-length'] || '0')
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c as Buffer))
      req.on('end', () => {
        const readByLen = Buffer.concat(chunks).subarray(0, len)
        res.writeHead(200, {
          'content-type': 'text/plain',
          'x-read-by-len': String(readByLen.length),
        })
        res.end('ok')
      })
    })
    const sport = await listen(sidecar)

    const gw = createServer((req, res) => {
      const url = new URL(req.url || '/', 'https://oc.local')
      handleChatGptWebProxy(req, res, url, {
        sidecar: { host: '127.0.0.1', port: sport, token: 'tk' },
      }).catch(() => {
        if (!res.headersSent) res.writeHead(502)
        res.end('err')
      })
    })
    const gport = await listen(gw)

    const body = JSON.stringify({ action: 'next', text: 'x'.repeat(4096) })
    try {
      const headers = await new Promise<Record<string, string | string[] | undefined>>(
        (resolve, reject) => {
          const r = httpRequest(
            {
              host: '127.0.0.1',
              port: gport,
              method: 'POST',
              path: '/api/chatgpt-web/https/chatgpt.com/backend-api/conversation',
              headers: { 'content-type': 'application/json' },
            },
            (resp) => {
              resp.resume()
              resp.on('end', () => resolve(resp.headers))
            },
          )
          r.on('error', reject)
          r.end(body)
        },
      )
      assert.equal(headers['x-read-by-len'], String(Buffer.byteLength(body)))
    } finally {
      sidecar.close()
      gw.close()
    }
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
