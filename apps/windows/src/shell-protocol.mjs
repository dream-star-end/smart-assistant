import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SHELL_SCHEME = 'app'
export const SHELL_HOST = 'aurora-shell'
export const SHELL_ORIGIN = `${SHELL_SCHEME}://${SHELL_HOST}`
export const SHELL_URL = `${SHELL_ORIGIN}/index.html`
export const SMOKE_PRODUCT_URL = `${SHELL_ORIGIN}/smoke-product.html`
export const SMOKE_PRODUCT_ROUTE_URL = `${SHELL_ORIGIN}/smoke-product-route.html`

export const SHELL_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT_DIRECTORY = path.join(__dirname, 'shell')
const ASSETS = new Map([
  ['/', Object.freeze({ filename: 'index.html', mime: 'text/html; charset=utf-8' })],
  ['/index.html', Object.freeze({ filename: 'index.html', mime: 'text/html; charset=utf-8' })],
  ['/shell.css', Object.freeze({ filename: 'shell.css', mime: 'text/css; charset=utf-8' })],
  ['/shell.mjs', Object.freeze({ filename: 'shell.mjs', mime: 'text/javascript; charset=utf-8' })],
  [
    '/wco-geometry.mjs',
    Object.freeze({ filename: 'wco-geometry.mjs', mime: 'text/javascript; charset=utf-8' }),
  ],
  [
    '/icons/aurora.svg',
    Object.freeze({ filename: 'icons/aurora.svg', mime: 'image/svg+xml' }),
  ],
  [
    '/icons/arrow_download_20_regular.svg',
    Object.freeze({
      filename: 'icons/arrow_download_20_regular.svg',
      mime: 'image/svg+xml',
    }),
  ],
  [
    '/icons/more_horizontal_20_regular.svg',
    Object.freeze({
      filename: 'icons/more_horizontal_20_regular.svg',
      mime: 'image/svg+xml',
    }),
  ],
  [
    '/icons/arrow_clockwise_20_regular.svg',
    Object.freeze({ filename: 'icons/arrow_clockwise_20_regular.svg', mime: 'image/svg+xml' }),
  ],
  [
    '/icons/folder_open_20_regular.svg',
    Object.freeze({ filename: 'icons/folder_open_20_regular.svg', mime: 'image/svg+xml' }),
  ],
  [
    '/icons/dismiss_20_regular.svg',
    Object.freeze({ filename: 'icons/dismiss_20_regular.svg', mime: 'image/svg+xml' }),
  ],
  [
    '/icons/wifi_off_24_regular.svg',
    Object.freeze({ filename: 'icons/wifi_off_24_regular.svg', mime: 'image/svg+xml' }),
  ],
  [
    '/icons/document_20_regular.svg',
    Object.freeze({ filename: 'icons/document_20_regular.svg', mime: 'image/svg+xml' }),
  ],
  [
    '/smoke-product.html',
    Object.freeze({ filename: 'smoke-product.html', mime: 'text/html; charset=utf-8' }),
  ],
  [
    '/smoke-product-route.html',
    Object.freeze({ filename: 'smoke-product.html', mime: 'text/html; charset=utf-8' }),
  ],
])

const COMMON_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'Content-Security-Policy': SHELL_CSP,
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), display-capture=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
})

// biome-ignore lint/suspicious/noControlCharactersInRegex: Raw URL validation intentionally rejects ASCII controls.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

function plainResponse(status, body, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      ...COMMON_HEADERS,
      'Content-Type': 'text/plain; charset=utf-8',
      ...extraHeaders,
    },
  })
}

/**
 * Parse the original serialization before URL normalization. This prevents inputs such as
 * `/folder/../index.html` from being normalized into an allowlisted asset.
 */
export function resolveShellAsset(requestUrl) {
  if (
    typeof requestUrl !== 'string' ||
    requestUrl.length === 0 ||
    requestUrl !== requestUrl.trim() ||
    CONTROL_CHARACTERS.test(requestUrl)
  ) {
    return null
  }

  const prefix = `${SHELL_SCHEME}://`
  if (!requestUrl.startsWith(prefix)) return null

  const remainder = requestUrl.slice(prefix.length)
  const separatorIndex = remainder.search(/[/?#]/)
  const rawAuthority = separatorIndex === -1 ? remainder : remainder.slice(0, separatorIndex)
  const rawTarget = separatorIndex === -1 ? '' : remainder.slice(separatorIndex)
  if (rawAuthority !== SHELL_HOST || rawTarget.includes('?') || rawTarget.includes('#')) return null

  const rawPath = rawTarget || '/'
  if (
    rawPath.includes('%') ||
    rawPath.includes('\\') ||
    rawPath.includes('//') ||
    rawPath.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    return null
  }

  let parsed
  try {
    parsed = new URL(requestUrl)
  } catch {
    return null
  }
  if (
    parsed.protocol !== `${SHELL_SCHEME}:` ||
    parsed.host !== SHELL_HOST ||
    parsed.hostname !== SHELL_HOST ||
    parsed.port !== '' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    (parsed.pathname || '/') !== rawPath
  ) {
    return null
  }

  return ASSETS.get(rawPath) ?? null
}

export async function createShellResponse(
  request,
  { rootDirectory = DEFAULT_ROOT_DIRECTORY } = {},
) {
  if (!request || request.method !== 'GET') {
    return plainResponse(405, 'Method Not Allowed', { Allow: 'GET' })
  }

  const asset = resolveShellAsset(request.url)
  if (!asset) return plainResponse(404, 'Not Found')

  try {
    const contents = await readFile(path.join(rootDirectory, asset.filename))
    return new Response(contents, {
      status: 200,
      headers: {
        ...COMMON_HEADERS,
        'Content-Type': asset.mime,
      },
    })
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return plainResponse(404, 'Not Found')
    }
    return plainResponse(500, 'Internal Server Error')
  }
}

/** Must be called during main-module initialization, before app.whenReady(). */
export function registerShellScheme(protocolModule) {
  if (!protocolModule || typeof protocolModule.registerSchemesAsPrivileged !== 'function') {
    throw new TypeError('Electron protocol.registerSchemesAsPrivileged is required')
  }

  protocolModule.registerSchemesAsPrivileged([
    {
      scheme: SHELL_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: false,
      },
    },
  ])
}

/** Register the handler on the non-persistent shell session's protocol object after app ready. */
export function registerShellProtocol(
  protocolModule,
  { rootDirectory = DEFAULT_ROOT_DIRECTORY } = {},
) {
  if (!protocolModule || typeof protocolModule.handle !== 'function') {
    throw new TypeError('Electron protocol.handle is required')
  }

  const handler = (request) => createShellResponse(request, { rootDirectory })
  protocolModule.handle(SHELL_SCHEME, handler)
  return handler
}
