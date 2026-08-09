import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  SHELL_CSP,
  SHELL_ORIGIN,
  SHELL_URL,
  SMOKE_PRODUCT_ROUTE_URL,
  SMOKE_PRODUCT_URL,
  createShellResponse,
  registerShellProtocol,
  registerShellScheme,
  resolveShellAsset,
} from '../src/shell-protocol.mjs'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const rootDirectory = path.resolve(testDirectory, '../src/shell')

test('registerShellScheme grants only the minimum secure standard privileges', () => {
  let registrations = null
  registerShellScheme({
    registerSchemesAsPrivileged(value) {
      registrations = value
    },
  })

  assert.deepEqual(registrations, [
    {
      scheme: 'app',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: false,
      },
    },
  ])
})

test('registerShellProtocol binds the allowlisted handler to the supplied session protocol', async () => {
  let boundScheme = null
  let boundHandler = null
  const returnedHandler = registerShellProtocol(
    {
      handle(scheme, handler) {
        boundScheme = scheme
        boundHandler = handler
      },
    },
    { rootDirectory },
  )

  assert.equal(boundScheme, 'app')
  assert.equal(boundHandler, returnedHandler)
  const response = await boundHandler({ method: 'GET', url: SHELL_URL })
  assert.equal(response.status, 200)
})

test('shell handler allows GET only', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'get']) {
    const response = await createShellResponse({ method, url: SHELL_URL }, { rootDirectory })
    assert.equal(response.status, 405, method)
    assert.equal(response.headers.get('allow'), 'GET')
  }
})

test('shell handler requires the exact scheme and authority', async () => {
  assert.equal(SHELL_ORIGIN, 'app://aurora-shell')
  for (const requestUrl of [
    'http://aurora-shell/index.html',
    'app://AURORA-SHELL/index.html',
    'app://aurora-shell.evil/index.html',
    'app://user@aurora-shell/index.html',
    'app://aurora-shell:80/index.html',
    'app:///index.html',
    'app://aurora-shell/index.html?debug=1',
    'app://aurora-shell/index.html#fragment',
  ]) {
    const response = await createShellResponse(
      { method: 'GET', url: requestUrl },
      { rootDirectory },
    )
    assert.equal(response.status, 404, requestUrl)
  }
})

test('shell handler serves only normalized allowlisted paths and rejects traversal', async () => {
  const allowed = [
    [SHELL_ORIGIN, 'text/html; charset=utf-8'],
    [SHELL_URL, 'text/html; charset=utf-8'],
    [`${SHELL_ORIGIN}/shell.css`, 'text/css; charset=utf-8'],
    [`${SHELL_ORIGIN}/shell.mjs`, 'text/javascript; charset=utf-8'],
    [SMOKE_PRODUCT_URL, 'text/html; charset=utf-8'],
    [SMOKE_PRODUCT_ROUTE_URL, 'text/html; charset=utf-8'],
  ]
  for (const [requestUrl, mime] of allowed) {
    const response = await createShellResponse(
      { method: 'GET', url: requestUrl },
      { rootDirectory },
    )
    assert.equal(response.status, 200, requestUrl)
    assert.equal(response.headers.get('content-type'), mime)
    assert.ok((await response.arrayBuffer()).byteLength > 0)
  }

  for (const requestUrl of [
    `${SHELL_ORIGIN}/main.mjs`,
    `${SHELL_ORIGIN}/offline.html`,
    `${SHELL_ORIGIN}/../index.html`,
    `${SHELL_ORIGIN}/folder/../index.html`,
    `${SHELL_ORIGIN}/%2e%2e/index.html`,
    `${SHELL_ORIGIN}/%252e%252e/index.html`,
    `${SHELL_ORIGIN}/%2findex.html`,
    `${SHELL_ORIGIN}/..\\index.html`,
    `${SHELL_ORIGIN}//index.html`,
  ]) {
    assert.equal(resolveShellAsset(requestUrl), null, requestUrl)
    const response = await createShellResponse(
      { method: 'GET', url: requestUrl },
      { rootDirectory },
    )
    assert.equal(response.status, 404, requestUrl)
  }
})

test('every response carries a restrictive CSP and hardening headers', async () => {
  for (const requestUrl of [SHELL_URL, `${SHELL_ORIGIN}/missing`]) {
    const response = await createShellResponse(
      { method: 'GET', url: requestUrl },
      { rootDirectory },
    )
    assert.equal(response.headers.get('content-security-policy'), SHELL_CSP)
    assert.match(SHELL_CSP, /default-src 'none'/)
    assert.match(SHELL_CSP, /script-src 'self'/)
    assert.match(SHELL_CSP, /style-src 'self'/)
    assert.match(SHELL_CSP, /img-src 'self' data:/)
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(
      response.headers.get('permissions-policy'),
      'camera=(), microphone=(), geolocation=(), display-capture=()',
    )
  }
})
