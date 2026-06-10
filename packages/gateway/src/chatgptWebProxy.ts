import {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestOptions,
  type ServerResponse,
  request as httpRequest,
} from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Socket } from 'node:net'
import { type TLSSocket, connect as tlsConnect } from 'node:tls'

const CHATGPT_PROXY_PREFIX = '/api/chatgpt-web'
const CHATGPT_PROXY_SESSION_PREFIX = `${CHATGPT_PROXY_PREFIX}/_session/`
const CHATGPT_PROXY_COOKIE_PATH = `${CHATGPT_PROXY_PREFIX}/`
const ALLOWED_ROOT_DOMAINS = ['chatgpt.com', 'openai.com', 'oaistatic.com', 'oaiusercontent.com']
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])
const STRIPPED_RESPONSE_HEADERS = new Set([
  'access-control-allow-credentials',
  'access-control-allow-headers',
  'access-control-allow-methods',
  'access-control-allow-origin',
  'access-control-expose-headers',
  'content-security-policy',
  'content-security-policy-report-only',
  'cross-origin-embedder-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'origin-agent-cluster',
  'permissions-policy',
  'strict-transport-security',
  'x-frame-options',
])
export const CHATGPT_PROXY_CORS_HEADERS = {
  'Access-Control-Allow-Origin': 'null',
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Allow-Methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, X-Requested-With, OpenAI-Sentinel-Chat-Requirements-Token',
  'Access-Control-Expose-Headers': 'Location',
  Vary: 'Origin, Access-Control-Request-Headers',
} as const

export interface ChatGptProxyTarget {
  host: string
  routePrefix: string
  routeBase: string
  url: URL
}

interface ChatGptWebProxyDeps {
  proxyUrl?: string
  forwardAuthorization?: boolean
  log?: {
    warn?: (msg: string, meta?: Record<string, unknown>, err?: unknown) => void
    debug?: (msg: string, meta?: Record<string, unknown>, err?: unknown) => void
  }
}

function isAllowedChatGptProxyHost(host: string): boolean {
  return ALLOWED_ROOT_DOMAINS.some((root) => host === root || host.endsWith(`.${root}`))
}

export function canonicalizeChatGptProxyHost(rawHost: string): string | null {
  if (!rawHost || rawHost.length > 253) return null
  if (!/^[a-z0-9.-]+$/i.test(rawHost)) return null
  if (rawHost.startsWith('.') || rawHost.endsWith('.') || rawHost.includes('..')) return null

  const host = rawHost.toLowerCase()
  const labels = host.split('.')
  for (const label of labels) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return null
  }
  if (!isAllowedChatGptProxyHost(host)) return null
  return host
}

function routeBaseForHost(host: string, routePrefix = CHATGPT_PROXY_PREFIX): string {
  return `${routePrefix}/https/${host}`
}

export function chatGptProxySessionEntryPath(token: string): string {
  return `${CHATGPT_PROXY_SESSION_PREFIX}${encodeURIComponent(token)}/https/chatgpt.com/`
}

export function extractChatGptProxySessionToken(reqUrl: URL): string | null {
  const pathname = reqUrl.pathname
  if (!pathname.startsWith(CHATGPT_PROXY_SESSION_PREFIX)) return null
  const rest = pathname.slice(CHATGPT_PROXY_SESSION_PREFIX.length)
  const markerIdx = rest.indexOf('/https/')
  if (markerIdx <= 0) return null
  const token = rest.slice(0, markerIdx)
  if (!/^[A-Za-z0-9._~-]{16,2048}$/.test(token)) return null
  return token
}

function routePrefixAndRest(pathname: string): { routePrefix: string; rest: string } | null {
  const normalPrefix = `${CHATGPT_PROXY_PREFIX}/https/`
  if (pathname.startsWith(normalPrefix)) {
    return { routePrefix: CHATGPT_PROXY_PREFIX, rest: pathname.slice(CHATGPT_PROXY_PREFIX.length) }
  }

  if (!pathname.startsWith(CHATGPT_PROXY_SESSION_PREFIX)) return null
  const restWithToken = pathname.slice(CHATGPT_PROXY_SESSION_PREFIX.length)
  const markerIdx = restWithToken.indexOf('/https/')
  if (markerIdx <= 0) return null
  const token = restWithToken.slice(0, markerIdx)
  if (!/^[A-Za-z0-9._~-]{16,2048}$/.test(token)) return null
  return {
    routePrefix: `${CHATGPT_PROXY_SESSION_PREFIX}${token}`,
    rest: restWithToken.slice(markerIdx),
  }
}

export function chatGptProxyHostToken(host: string): string {
  return host.replace(/[^a-z0-9]/g, '_')
}

function cookiePrefixForHost(host: string): string {
  return `oc_cgpt_${chatGptProxyHostToken(host)}__`
}

export function resolveChatGptProxyTarget(reqUrl: URL): ChatGptProxyTarget | null {
  const pathname = reqUrl.pathname
  if (pathname === CHATGPT_PROXY_PREFIX || pathname === `${CHATGPT_PROXY_PREFIX}/`) {
    const host = 'chatgpt.com'
    return {
      host,
      routePrefix: CHATGPT_PROXY_PREFIX,
      routeBase: routeBaseForHost(host),
      url: new URL(`https://${host}/${reqUrl.search}`),
    }
  }

  const routed = routePrefixAndRest(pathname)
  if (!routed) return null

  const rest = routed.rest.slice('/https/'.length)
  const slashIdx = rest.indexOf('/')
  const rawHost = slashIdx === -1 ? rest : rest.slice(0, slashIdx)
  const suffix = slashIdx === -1 ? '/' : rest.slice(slashIdx)
  const host = canonicalizeChatGptProxyHost(rawHost)
  if (!host) return null

  return {
    host,
    routePrefix: routed.routePrefix,
    routeBase: routeBaseForHost(host, routed.routePrefix),
    url: new URL(`https://${host}${suffix}${reqUrl.search}`),
  }
}

export function proxyPathForAllowedChatGptUrl(
  raw: string,
  base?: ChatGptProxyTarget,
): string | null {
  let parsed: URL
  try {
    parsed = base ? new URL(raw, base.url) : new URL(raw)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  if (parsed.port && parsed.port !== '443') return null
  const host = canonicalizeChatGptProxyHost(parsed.hostname)
  if (!host) return null
  return `${routeBaseForHost(host, base?.routePrefix)}${parsed.pathname}${parsed.search}${parsed.hash}`
}

export function rewriteChatGptProxyLocation(
  location: string,
  base: ChatGptProxyTarget,
): string | null {
  return proxyPathForAllowedChatGptUrl(location, base)
}

export function filterChatGptProxyCookieHeader(
  cookieHeader: string | string[] | undefined,
  host: string,
): string | undefined {
  const raw = Array.isArray(cookieHeader) ? cookieHeader.join('; ') : cookieHeader
  if (!raw) return undefined

  const prefix = cookiePrefixForHost(host)
  const forwarded: string[] = []
  for (const part of raw.split(';')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const name = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1)
    if (!name.startsWith(prefix)) continue
    const upstreamName = name.slice(prefix.length)
    if (!upstreamName || upstreamName === 'oc_session') continue
    forwarded.push(`${upstreamName}=${value}`)
  }
  return forwarded.length ? forwarded.join('; ') : undefined
}

export function rewriteChatGptProxySetCookie(rawCookie: string, host: string): string | null {
  const firstSemi = rawCookie.indexOf(';')
  const pair = firstSemi === -1 ? rawCookie : rawCookie.slice(0, firstSemi)
  const eq = pair.indexOf('=')
  if (eq <= 0) return null

  const upstreamName = pair.slice(0, eq).trim()
  const value = pair.slice(eq + 1)
  if (!upstreamName || /[\s;=]/.test(upstreamName)) return null

  const attrs = firstSemi === -1 ? [] : rawCookie.slice(firstSemi + 1).split(';')
  const keptAttrs = attrs
    .map((attr) => attr.trim())
    .filter((attr) => {
      const lower = attr.toLowerCase()
      return attr && !lower.startsWith('domain=') && !lower.startsWith('path=')
    })

  const name = `${cookiePrefixForHost(host)}${upstreamName}`
  const rewritten = [`${name}=${value}`, `Path=${CHATGPT_PROXY_COOKIE_PATH}`, ...keptAttrs]
  return rewritten.join('; ')
}

function rewriteChatGptProxySetCookies(
  rawCookies: string | string[] | undefined,
  host: string,
): string[] | undefined {
  if (!rawCookies) return undefined
  const cookies = Array.isArray(rawCookies) ? rawCookies : [rawCookies]
  const rewritten = cookies
    .map((cookie) => rewriteChatGptProxySetCookie(cookie, host))
    .filter((cookie): cookie is string => !!cookie)
  return rewritten.length ? rewritten : undefined
}

function copyHeaderValue(
  value: string | string[] | number | undefined,
): string | string[] | undefined {
  if (value === undefined) return undefined
  if (Array.isArray(value)) return value.map((v) => String(v))
  return String(value)
}

export function buildChatGptProxyUpstreamHeaders(
  requestHeaders: IncomingHttpHeaders,
  target: ChatGptProxyTarget,
  options: { forwardAuthorization?: boolean } = {},
): Record<string, any> {
  const headers: Record<string, any> = {}
  for (const [name, value] of Object.entries(requestHeaders)) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lower)) continue
    if (lower === 'host') continue
    if (lower === 'authorization' && !options.forwardAuthorization) continue
    if (lower === 'cookie') continue
    if (lower === 'origin') continue
    if (lower === 'referer') continue
    if (lower === 'accept-encoding') continue
    if (lower.startsWith('x-forwarded-')) continue
    const copied = copyHeaderValue(value)
    if (copied !== undefined) headers[name] = copied
  }

  headers.host = target.host
  headers.origin = target.url.origin
  headers.referer = target.url.href
  headers['accept-encoding'] = 'identity'

  const cookie = filterChatGptProxyCookieHeader(requestHeaders.cookie, target.host)
  if (cookie) headers.cookie = cookie

  return headers
}

function buildProxyResponseHeaders(
  upstreamHeaders: IncomingHttpHeaders,
  target: ChatGptProxyTarget,
): { headers: Record<string, string | string[]>; blockedRedirect?: string } {
  const headers: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(upstreamHeaders)) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lower)) continue
    if (STRIPPED_RESPONSE_HEADERS.has(lower)) continue
    if (lower === 'set-cookie') continue
    if (lower === 'content-length') continue
    if (lower === 'location') continue
    const copied = copyHeaderValue(value)
    if (copied !== undefined) headers[name] = copied
  }

  const rewrittenCookies = rewriteChatGptProxySetCookies(upstreamHeaders['set-cookie'], target.host)
  if (rewrittenCookies) headers['set-cookie'] = rewrittenCookies

  const location = upstreamHeaders.location
  if (typeof location === 'string') {
    const rewritten = rewriteChatGptProxyLocation(location, target)
    if (!rewritten) return { headers, blockedRedirect: location }
    headers.location = rewritten
  }

  headers['cache-control'] = 'no-store'
  Object.assign(headers, CHATGPT_PROXY_CORS_HEADERS)
  return { headers }
}

export function isRewriteableChatGptProxyContentType(
  contentType: string | string[] | undefined,
): boolean {
  const raw = Array.isArray(contentType) ? contentType[0] : contentType
  const mime = raw?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (!mime || mime === 'text/event-stream') return false
  return (
    mime === 'text/html' ||
    mime === 'application/xhtml+xml' ||
    mime === 'text/css' ||
    mime === 'text/javascript' ||
    mime === 'application/javascript' ||
    mime === 'application/x-javascript' ||
    mime === 'text/ecmascript' ||
    mime === 'application/ecmascript' ||
    mime === 'text/xml' ||
    mime === 'application/xml' ||
    mime.endsWith('+xml')
  )
}

function proxifyAbsoluteUrls(text: string, base: ChatGptProxyTarget): string {
  return text.replace(
    /https:\/\/[a-z0-9.-]+(?::\d+)?(?:\/[^\s"'`<>)\\]*)?/gi,
    (match) => proxyPathForAllowedChatGptUrl(match, base) ?? match,
  )
}

function proxifyProtocolRelativeUrls(text: string, base: ChatGptProxyTarget): string {
  return text.replace(
    /(^|[\s"'`(=])\/\/([a-z0-9.-]+(?::\d+)?(?:\/[^\s"'`<>)\\]*)?)/gi,
    (match, prefix, rest) => {
      const rewritten = proxyPathForAllowedChatGptUrl(`https://${rest}`, base)
      return rewritten ? `${prefix}${rewritten}` : match
    },
  )
}

function proxifyRootRelativeStrings(text: string, target: ChatGptProxyTarget): string {
  return text
    .replace(
      /\b(url\(\s*["']?)\/(?!\/|api\/chatgpt-web\b|[$&?!~]["']?\s*\))/gi,
      `$1${target.routeBase}/`,
    )
    .replace(/(["'`])\/(?!\/|api\/chatgpt-web\b|[$&?!~]\1)/g, `$1${target.routeBase}/`)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function restoreReactStreamingMarkers(text: string, target: ChatGptProxyTarget): string {
  const routeBase = escapeRegExp(target.routeBase)
  return text
    .replace(new RegExp(`(["'\`])${routeBase}/([$&?!~])\\1`, 'g'), '$1/$2$1')
    .replace(
      /(["'`])\/api\/chatgpt-web\/(?:_session\/[A-Za-z0-9._~-]{16,2048}\/)?https\/chatgpt\.com\/([$&?!~])\1/g,
      '$1/$2$1',
    )
}

function chatGptProxyBootstrap(target: ChatGptProxyTarget): string {
  return `<script data-openclaude-chatgpt-proxy>
(() => {
  const PREFIX = ${JSON.stringify(CHATGPT_PROXY_PREFIX)};
  const ROUTE_PREFIX = ${JSON.stringify(target.routePrefix)};
  const ROUTE_BASE = ${JSON.stringify(target.routeBase)};
  const ROOTS = ${JSON.stringify(ALLOWED_ROOT_DOMAINS)};
  const allowed = (host) => {
    host = String(host || '').toLowerCase();
    return ROOTS.some((root) => host === root || host.endsWith('.' + root));
  };
  const mapUrl = (value) => {
    if (typeof value !== 'string') return value;
    if (value.startsWith(PREFIX) || /^(blob|data|about):/i.test(value)) return value;
    try {
      if (value.startsWith('//')) {
        const u = new URL('https:' + value);
        if (allowed(u.hostname) && (!u.port || u.port === '443')) {
          return ROUTE_PREFIX + '/https/' + u.hostname.toLowerCase() + u.pathname + u.search + u.hash;
        }
        return value;
      }
      if (value.startsWith('/')) return ROUTE_BASE + value;
      const u = new URL(value, location.href);
      if (u.protocol === 'https:' && allowed(u.hostname) && (!u.port || u.port === '443')) {
        return ROUTE_PREFIX + '/https/' + u.hostname.toLowerCase() + u.pathname + u.search + u.hash;
      }
    } catch {}
    return value;
  };
  const isProxyUrl = (value) => {
    if (typeof value !== 'string') return false;
    if (value.startsWith(PREFIX)) return true;
    try {
      const u = new URL(value, location.href);
      const here = new URL(location.href);
      return u.origin === here.origin && u.pathname.startsWith(PREFIX);
    } catch {}
    return false;
  };
  const rawFetch = window.fetch;
  if (rawFetch) {
    window.fetch = (input, init) => {
      let mappedToProxy = false;
      if (input instanceof Request) {
        const mapped = mapUrl(input.url);
        mappedToProxy = isProxyUrl(mapped);
        if (mapped !== input.url) input = new Request(mapped, input);
      } else {
        const mapped = mapUrl(input);
        mappedToProxy = isProxyUrl(mapped);
        input = mapped;
      }
      if (mappedToProxy) {
        init = Object.assign({ credentials: 'include' }, init || {});
        if (!init.credentials || init.credentials === 'same-origin') init.credentials = 'include';
      }
      return rawFetch(input, init);
    };
  }
  const rawOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    const mapped = mapUrl(url);
    const ret = rawOpen.call(this, method, mapped, ...rest);
    if (isProxyUrl(mapped)) this.withCredentials = true;
    return ret;
  };
  if (window.EventSource) {
    const RawEventSource = window.EventSource;
    window.EventSource = function(url, config) {
      const mapped = mapUrl(url);
      if (isProxyUrl(mapped)) config = Object.assign({ withCredentials: true }, config || {});
      return new RawEventSource(mapped, config);
    };
  }
  if (window.WebSocket) {
    const RawWebSocket = window.WebSocket;
    window.WebSocket = function(url, protocols) {
      const mapped = mapUrl(url);
      const absolute = typeof mapped === 'string' && mapped.startsWith('/')
        ? (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + mapped
        : mapped;
      return new RawWebSocket(absolute, protocols);
    };
  }
  if (window.Worker) {
    const RawWorker = window.Worker;
    window.Worker = function(url, options) { return new RawWorker(mapUrl(String(url)), options); };
  }
  if (navigator.serviceWorker?.register) {
    navigator.serviceWorker.register = () => Promise.reject(new Error('disabled in OpenClaude ChatGPT proxy'));
  }
})();
</script>`
}

export function rewriteChatGptProxyText(text: string, target: ChatGptProxyTarget): string {
  let rewritten = proxifyAbsoluteUrls(text, target)
  rewritten = proxifyProtocolRelativeUrls(rewritten, target)
  rewritten = proxifyRootRelativeStrings(rewritten, target)
  rewritten = restoreReactStreamingMarkers(rewritten, target)
  if (/<\s*html[\s>]/i.test(rewritten) || /<\s*head[\s>]/i.test(rewritten)) {
    rewritten = rewritten.replace(/\s+integrity=(["']).*?\1/gi, '')
    const bootstrap = chatGptProxyBootstrap(target)
    if (/<\/head>/i.test(rewritten)) {
      rewritten = rewritten.replace(/<\/head>/i, `${bootstrap}</head>`)
    } else {
      rewritten = `${bootstrap}${rewritten}`
    }
  }
  return rewritten
}

async function sendProxyResponse(
  res: ServerResponse,
  upstreamRes: IncomingMessage,
  target: ChatGptProxyTarget,
  isHead: boolean,
): Promise<void> {
  const status = upstreamRes.statusCode ?? 502
  const { headers, blockedRedirect } = buildProxyResponseHeaders(upstreamRes.headers, target)
  res.removeHeader('X-Frame-Options')
  res.removeHeader('Content-Security-Policy')
  res.removeHeader('Content-Security-Policy-Report-Only')

  if (blockedRedirect) {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(`blocked ChatGPT proxy redirect: ${blockedRedirect}`)
    upstreamRes.resume()
    return
  }

  const contentEncoding = upstreamRes.headers['content-encoding']
  const shouldRewrite =
    !isHead &&
    !contentEncoding &&
    isRewriteableChatGptProxyContentType(upstreamRes.headers['content-type'])

  if (!shouldRewrite) {
    res.writeHead(status, headers)
    if (isHead) {
      res.end()
      upstreamRes.resume()
    } else {
      upstreamRes.pipe(res)
    }
    return
  }

  const chunks: Buffer[] = []
  for await (const chunk of upstreamRes) chunks.push(Buffer.from(chunk as Buffer))
  const body = Buffer.concat(chunks).toString('utf-8')
  const rewritten = rewriteChatGptProxyText(body, target)
  res.writeHead(status, headers)
  res.end(rewritten)
}

function decodedProxyAuth(proxy: URL): string | undefined {
  if (!proxy.username && !proxy.password) return undefined
  let username = proxy.username
  let password = proxy.password
  try {
    username = decodeURIComponent(username)
    password = decodeURIComponent(password)
  } catch {}
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
}

function connectHttpsViaProxy(proxyUrl: string, targetHost: string): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    let proxy: URL
    try {
      proxy = new URL(proxyUrl)
    } catch (err) {
      reject(err)
      return
    }
    if (proxy.protocol !== 'http:' && proxy.protocol !== 'https:') {
      reject(new Error('proxyUrl must use http or https'))
      return
    }

    const headers: Record<string, string> = { Host: `${targetHost}:443` }
    const auth = decodedProxyAuth(proxy)
    if (auth) headers['Proxy-Authorization'] = auth

    const connectReq = (proxy.protocol === 'https:' ? httpsRequest : httpRequest)({
      hostname: proxy.hostname,
      port: proxy.port ? Number(proxy.port) : proxy.protocol === 'https:' ? 443 : 80,
      method: 'CONNECT',
      path: `${targetHost}:443`,
      headers,
    })

    const timer = setTimeout(() => {
      connectReq.destroy(new Error('proxy CONNECT timeout'))
    }, 30_000)

    const fail = (err: unknown) => {
      clearTimeout(timer)
      reject(err instanceof Error ? err : new Error(String(err)))
    }

    connectReq.once('connect', (proxyRes, socket: Socket, head: Buffer) => {
      clearTimeout(timer)
      if ((proxyRes.statusCode ?? 0) < 200 || (proxyRes.statusCode ?? 0) >= 300) {
        socket.destroy()
        reject(new Error(`proxy CONNECT failed: ${proxyRes.statusCode}`))
        return
      }
      if (head.length) socket.unshift(head)
      const tlsSocket = tlsConnect({ socket, servername: targetHost })
      tlsSocket.once('secureConnect', () => resolve(tlsSocket))
      tlsSocket.once('error', fail)
    })
    connectReq.once('error', fail)
    connectReq.end()
  })
}

function buildRequestOptions(
  req: IncomingMessage,
  target: ChatGptProxyTarget,
  proxyUrl: string | undefined,
  forwardAuthorization: boolean,
): RequestOptions {
  const options: RequestOptions = {
    protocol: 'https:',
    hostname: target.host,
    port: 443,
    method: req.method,
    path: `${target.url.pathname}${target.url.search}`,
    headers: buildChatGptProxyUpstreamHeaders(req.headers, target, { forwardAuthorization }),
  }
  if (proxyUrl) {
    ;(options as any).createConnection = (
      _opts: unknown,
      cb: (err: Error | null, s?: Socket) => void,
    ) => {
      connectHttpsViaProxy(proxyUrl, target.host).then((socket) => cb(null, socket), cb)
      return undefined
    }
  }
  return options
}

export async function handleChatGptWebProxy(
  req: IncomingMessage,
  res: ServerResponse,
  reqUrl: URL,
  deps: ChatGptWebProxyDeps,
): Promise<void> {
  const target = resolveChatGptProxyTarget(reqUrl)
  if (!target) {
    res.removeHeader('X-Frame-Options')
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end('bad ChatGPT proxy target')
    return
  }

  const options = buildRequestOptions(req, target, deps.proxyUrl, !!deps.forwardAuthorization)
  await new Promise<void>((resolve) => {
    const upstreamReq = httpsRequest(options, (upstreamRes) => {
      sendProxyResponse(res, upstreamRes, target, req.method === 'HEAD')
        .catch((err) => {
          deps.log?.warn?.('chatgpt proxy response failed', { host: target.host }, err)
          if (!res.headersSent) {
            res.removeHeader('X-Frame-Options')
            res.writeHead(502, {
              'Content-Type': 'text/plain; charset=utf-8',
              'Cache-Control': 'no-store',
            })
          }
          if (!res.writableEnded) res.end('ChatGPT proxy response failed')
        })
        .finally(resolve)
    })
    upstreamReq.setTimeout(60_000, () => upstreamReq.destroy(new Error('ChatGPT proxy timeout')))
    upstreamReq.once('error', (err) => {
      deps.log?.warn?.('chatgpt proxy upstream failed', { host: target.host }, err)
      if (!res.headersSent) {
        res.removeHeader('X-Frame-Options')
        res.writeHead(502, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        })
      }
      if (!res.writableEnded) res.end('ChatGPT proxy upstream failed')
      resolve()
    })

    if (req.method === 'GET' || req.method === 'HEAD') upstreamReq.end()
    else req.pipe(upstreamReq)
  })
}
