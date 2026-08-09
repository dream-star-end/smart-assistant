import assert from 'node:assert/strict'
import test from 'node:test'

import {
  OAUTH_CALLBACK_PATHS,
  PINNED_APP_ORIGIN,
  PINNED_APP_URL,
  classifyDownload,
  classifyPermission,
  classifyTopLevelNavigation,
  classifyWindowOpen,
  downloadRisk,
  isOAuthFinalLanding,
  isOAuthReturn,
  isPinnedOrigin,
  resolveStartUrl,
  sanitizeWindowsFilename,
} from '../src/security-policy.mjs'

const githubCallback = `${PINNED_APP_ORIGIN}${OAUTH_CALLBACK_PATHS[0]}`
const connectorCallback = `${PINNED_APP_ORIGIN}${OAUTH_CALLBACK_PATHS[1]}`
const linuxdoCallback = `${PINNED_APP_ORIGIN}${OAUTH_CALLBACK_PATHS[2]}`

function oauthUrl(origin = 'https://github.com', callback = githubCallback, extra = '') {
  const params = new URLSearchParams({
    response_type: 'code',
    state: 'bounded-state-value',
    redirect_uri: callback,
  })
  return `${origin}/login/oauth/authorize?${params}${extra}`
}

test('resolveStartUrl pins packaged builds and accepts only explicit loopback development URLs', () => {
  assert.equal(
    resolveStartUrl({ isPackaged: true, devUrl: 'http://localhost:5173/attacker-controlled' }),
    PINNED_APP_URL,
  )
  assert.equal(resolveStartUrl({ isPackaged: false }), PINNED_APP_URL)
  assert.equal(
    resolveStartUrl({ isPackaged: false, devUrl: 'http://localhost:5173/app?dev=1#route' }),
    'http://localhost:5173/app?dev=1#route',
  )
  assert.equal(
    resolveStartUrl({ isPackaged: false, devUrl: 'https://127.0.0.1:4173/' }),
    'https://127.0.0.1:4173/',
  )
  assert.equal(
    resolveStartUrl({ isPackaged: false, devUrl: 'http://[::1]:5173/' }),
    'http://[::1]:5173/',
  )

  for (const devUrl of [
    'file:///tmp/index.html',
    'http://0.0.0.0:5173/',
    'http://127.0.0.2:5173/',
    'http://localhost.evil.test/',
    'http://localhost@evil.test/',
    'https://claudeai.chat/',
    ' javascript:alert(1)',
  ]) {
    assert.throws(() => resolveStartUrl({ isPackaged: false, devUrl }), TypeError, devUrl)
  }
})

test('isPinnedOrigin rejects lookalikes, credentials, non-default ports, and punycode homographs', () => {
  assert.equal(isPinnedOrigin(PINNED_APP_URL), true)
  assert.equal(isPinnedOrigin(`${PINNED_APP_ORIGIN}/chat/123?x=1#turn`), true)
  assert.equal(isPinnedOrigin('https://claudeai.chat:443/'), true)
  assert.equal(isPinnedOrigin('blob:https://claudeai.chat/blob-id'), false)

  for (const value of [
    'http://claudeai.chat/',
    'https://claudeai.chat:444/',
    'https://claudeai.chat.evil.test/',
    'https://user@claudeai.chat/',
    'https://claudeai.chat@evil.test/',
    'https://сlaudeai.chat/', // first letter is Cyrillic and serializes as punycode
    'https://claudeai.chat./',
  ]) {
    assert.equal(isPinnedOrigin(value), false, value)
  }
})

test('classifyTopLevelNavigation distinguishes same-origin, OAuth, external, and denied main navigation', () => {
  const base = { windowKind: 'main', currentUrl: `${PINNED_APP_ORIGIN}/chat` }
  assert.equal(
    classifyTopLevelNavigation({ ...base, targetUrl: `${PINNED_APP_ORIGIN}/settings?tab=billing` }),
    'allow',
  )
  assert.equal(classifyTopLevelNavigation({ ...base, targetUrl: oauthUrl() }), 'oauth')
  assert.equal(
    classifyTopLevelNavigation({ ...base, targetUrl: oauthUrl('https://linear.app', connectorCallback) }),
    'oauth',
  )
  assert.equal(
    classifyTopLevelNavigation({
      ...base,
      targetUrl: oauthUrl('https://connect.linux.do', linuxdoCallback),
    }),
    'oauth',
  )
  assert.equal(classifyTopLevelNavigation({ ...base, targetUrl: 'https://example.com/docs' }), 'external')
  assert.equal(classifyTopLevelNavigation({ ...base, targetUrl: 'mailto:help@example.com' }), 'external')

  for (const targetUrl of [
    'http://example.com/docs',
    'javascript:alert(1)',
    'data:text/html,hello',
    'file:///C:/Windows/System32/calc.exe',
    'aurora://callback',
    'https://user@example.com/private',
    'mailto:help@example.com?subject=x%0d%0aBcc:evil@example.com',
  ]) {
    assert.equal(classifyTopLevelNavigation({ ...base, targetUrl }), 'deny', targetUrl)
  }
})

test('OAuth upgrade requires one bounded state, an exact callback URL, and response_type code or empty', () => {
  const base = { windowKind: 'main', currentUrl: PINNED_APP_URL }
  const cases = [
    oauthUrl('https://github.com', 'https://claudeai.chat.evil.test/api/auth/github/callback'),
    oauthUrl('https://github.com', 'https://claudeai.chat:444/api/auth/github/callback'),
    oauthUrl('https://github.com', `${githubCallback}?nested=1`),
    oauthUrl('https://github.com', `${githubCallback}/extra`),
    oauthUrl('https://user@github.com'),
  ]
  const missingState = new URL(oauthUrl())
  missingState.searchParams.delete('state')
  cases.push(missingState.href)
  const duplicateState = new URL(oauthUrl())
  duplicateState.searchParams.append('state', 'second')
  cases.push(duplicateState.href)
  const oversizedState = new URL(oauthUrl())
  oversizedState.searchParams.set('state', 's'.repeat(513))
  cases.push(oversizedState.href)
  const implicitResponse = new URL(oauthUrl())
  implicitResponse.searchParams.delete('response_type')
  assert.equal(classifyTopLevelNavigation({ ...base, targetUrl: implicitResponse.href }), 'oauth')
  const unsupportedResponse = new URL(oauthUrl())
  unsupportedResponse.searchParams.set('response_type', 'token')
  cases.push(unsupportedResponse.href)

  for (const targetUrl of cases) {
    const expected = targetUrl.includes('user@github.com') ? 'deny' : 'external'
    assert.equal(classifyTopLevelNavigation({ ...base, targetUrl }), expected, targetUrl)
  }

  assert.equal(
    classifyTopLevelNavigation({
      ...base,
      currentUrl: 'file:///offline.html',
      targetUrl: oauthUrl(),
    }),
    'deny',
  )
})

test('runtime appOrigin permits only explicit loopback origins in development policies', () => {
  const appOrigin = 'http://localhost:5173'
  const currentUrl = `${appOrigin}/chat`
  const callback = `${appOrigin}${OAUTH_CALLBACK_PATHS[1]}`
  assert.equal(isPinnedOrigin(`${appOrigin}/settings`, appOrigin), true)
  assert.equal(
    classifyTopLevelNavigation({
      windowKind: 'main',
      currentUrl,
      targetUrl: `${appOrigin}/settings`,
      appOrigin,
    }),
    'allow',
  )
  assert.equal(
    classifyTopLevelNavigation({
      windowKind: 'main',
      currentUrl,
      targetUrl: oauthUrl('https://linear.app', callback),
      appOrigin,
    }),
    'oauth',
  )
  assert.equal(
    classifyTopLevelNavigation({
      windowKind: 'auth',
      currentUrl: 'https://linear.app/oauth/authorize',
      targetUrl: `${callback}?code=ok&state=s`,
      appOrigin,
    }),
    'oauth-return',
  )
  assert.equal(
    classifyPermission({
      permission: 'media',
      mediaTypes: ['audio'],
      requestingOrigin: appOrigin,
      embeddingOrigin: `${appOrigin}/`,
      isMainWindow: true,
      isMainFrame: true,
      appOrigin,
    }),
    'allow',
  )
  assert.equal(classifyDownload(`${appOrigin}/download/file`, appOrigin), 'allow')
  assert.equal(classifyDownload(`blob:${appOrigin}/blob-id`, appOrigin), 'allow')
  assert.equal(
    classifyWindowOpen({
      windowKind: 'main',
      currentUrl,
      targetUrl: `blob:${appOrigin}/blob-id`,
      appOrigin,
    }),
    'blob-view',
  )

  const untrustedOrigin = 'https://dev.example.com'
  assert.equal(isPinnedOrigin(`${untrustedOrigin}/`, untrustedOrigin), false)
  assert.equal(classifyDownload(`${untrustedOrigin}/file`, untrustedOrigin), 'deny')
})

test('auth top-level navigation allows HTTPS redirects and separates callback from final landing', () => {
  const base = { windowKind: 'auth', currentUrl: 'https://github.com/login' }
  assert.equal(classifyTopLevelNavigation({ ...base, targetUrl: 'https://github.com/session' }), 'allow')
  assert.equal(
    classifyTopLevelNavigation({ ...base, targetUrl: `${githubCallback}?code=ok&state=state` }),
    'oauth-return',
  )
  assert.equal(
    classifyTopLevelNavigation({ ...base, targetUrl: `${connectorCallback}?error=denied&state=state` }),
    'oauth-return',
  )
  assert.equal(
    classifyTopLevelNavigation({ ...base, targetUrl: `${linuxdoCallback}?code=ok&state=state` }),
    'oauth-return',
  )
  assert.equal(
    classifyTopLevelNavigation({ ...base, targetUrl: `${PINNED_APP_ORIGIN}/?github_linked=1` }),
    'oauth-final',
  )
  assert.equal(
    classifyTopLevelNavigation({ ...base, targetUrl: `${PINNED_APP_ORIGIN}/settings` }),
    'oauth-final',
  )

  for (const targetUrl of [
    'http://github.com/login',
    'mailto:security@example.com',
    'javascript:alert(1)',
    'https://user@github.com/login',
    `${githubCallback}?code=ok&state=state#unexpected`,
  ]) {
    assert.equal(classifyTopLevelNavigation({ ...base, targetUrl }), 'deny', targetUrl)
  }
})

test('OAuth return and final landing helpers enforce pinned origin and callback paths', () => {
  assert.equal(isOAuthReturn(`${githubCallback}?code=ok&state=s`), true)
  assert.equal(isOAuthReturn(`${connectorCallback}?error=access_denied&state=s`), true)
  assert.equal(isOAuthReturn(`${linuxdoCallback}?code=ok&state=s`), true)
  assert.equal(isOAuthReturn(`${githubCallback}/extra?code=ok`), false)
  assert.equal(isOAuthReturn('https://claudeai.chat.evil.test/api/auth/github/callback'), false)
  assert.equal(isOAuthReturn(`${githubCallback}?code=ok#fragment`), false)

  assert.equal(isOAuthFinalLanding(`${PINNED_APP_ORIGIN}/?connector_linked=linear`), true)
  assert.equal(isOAuthFinalLanding(`${PINNED_APP_ORIGIN}/settings`), true)
  assert.equal(isOAuthFinalLanding(`${githubCallback}?code=ok`), false)
  assert.equal(isOAuthFinalLanding('https://сlaudeai.chat/?github_linked=1'), false)
})

test('classifyWindowOpen sends ordinary links external and only pinned blobs to a restricted viewer', () => {
  const base = { windowKind: 'main', currentUrl: `${PINNED_APP_ORIGIN}/chat` }
  assert.equal(
    classifyWindowOpen({ ...base, targetUrl: 'blob:https://claudeai.chat/6e2c86ce-0c71-4f68-a529' }),
    'blob-view',
  )
  assert.equal(
    classifyWindowOpen({ ...base, targetUrl: `${PINNED_APP_ORIGIN}/api/media-signed/file?sig=short` }),
    'external',
  )
  assert.equal(classifyWindowOpen({ ...base, targetUrl: 'https://example.com/' }), 'external')
  assert.equal(classifyWindowOpen({ ...base, targetUrl: 'mailto:hello@example.com' }), 'external')

  for (const targetUrl of [
    'http://example.com/',
    'blob:https://claudeai.chat.evil.test/id',
    'blob:https://user@claudeai.chat/id',
    'blob:null/id',
    'javascript:alert(1)',
    'data:text/html,hello',
    'file:///tmp/file',
    'https://user@example.com/',
  ]) {
    assert.equal(classifyWindowOpen({ ...base, targetUrl }), 'deny', targetUrl)
  }
  assert.equal(
    classifyWindowOpen({ ...base, windowKind: 'auth', targetUrl: 'https://example.com/' }),
    'deny',
  )
  assert.equal(
    classifyWindowOpen({ ...base, windowKind: 'viewer', targetUrl: 'https://example.com/' }),
    'deny',
  )
})

test('classifyPermission only grants exact-origin main-frame audio and sanitized clipboard writes', () => {
  const base = {
    requestingOrigin: PINNED_APP_ORIGIN,
    embeddingOrigin: PINNED_APP_URL,
    isMainWindow: true,
    isMainFrame: true,
  }
  assert.equal(classifyPermission({ ...base, permission: 'media', mediaTypes: ['audio'] }), 'allow')
  assert.equal(
    classifyPermission({ ...base, permission: 'clipboard-sanitized-write' }),
    'allow',
  )

  for (const candidate of [
    { ...base, permission: 'media', mediaTypes: [] },
    { ...base, permission: 'media', mediaTypes: ['video'] },
    { ...base, permission: 'media', mediaTypes: ['audio', 'video'] },
    { ...base, permission: 'notifications' },
    { ...base, permission: 'fullscreen' },
    { ...base, permission: 'media', mediaTypes: ['audio'], isMainWindow: false },
    { ...base, permission: 'media', mediaTypes: ['audio'], isMainFrame: false },
    { ...base, permission: 'media', mediaTypes: ['audio'], requestingOrigin: 'https://claudeai.chat:444' },
    { ...base, permission: 'media', mediaTypes: ['audio'], requestingOrigin: 'https://claudeai.chat/path' },
    { ...base, permission: 'media', mediaTypes: ['audio'], embeddingOrigin: 'https://claudeai.chat.evil.test' },
    { ...base, permission: 'media', mediaTypes: ['audio'], embeddingOrigin: 'https://сlaudeai.chat' },
  ]) {
    assert.equal(classifyPermission(candidate), 'deny', JSON.stringify(candidate))
  }
})

test('classifyDownload allows only pinned HTTPS and pinned-origin blob URLs', () => {
  assert.equal(classifyDownload(`${PINNED_APP_ORIGIN}/api/media-signed/file?sig=short`), 'allow')
  assert.equal(classifyDownload('blob:https://claudeai.chat/6e2c86ce-0c71-4f68-a529'), 'allow')

  for (const targetUrl of [
    'http://claudeai.chat/file',
    'https://claudeai.chat:444/file',
    'https://claudeai.chat.evil.test/file',
    'https://user@claudeai.chat/file',
    'blob:https://claudeai.chat.evil.test/id',
    'blob:https://user@claudeai.chat/id',
    'blob:null/id',
    'data:application/octet-stream,hello',
    'file:///C:/Temp/file.txt',
  ]) {
    assert.equal(classifyDownload(targetUrl), 'deny', targetUrl)
  }
})

test('sanitizeWindowsFilename removes path syntax, controls, trailing dots, and device names', () => {
  assert.equal(sanitizeWindowsFilename('report: Q3?.pdf'), 'report_ Q3_.pdf')
  assert.equal(sanitizeWindowsFilename('../private\\payload.exe'), '.._private_payload.exe')
  assert.equal(sanitizeWindowsFilename('name.   '), 'name')
  assert.equal(sanitizeWindowsFilename('\u0000\u0007'), '__')
  assert.equal(sanitizeWindowsFilename(''), 'download')
  assert.equal(sanitizeWindowsFilename('.'), 'download')
  assert.equal(sanitizeWindowsFilename('..'), 'download')
  assert.equal(sanitizeWindowsFilename('CON'), '_CON')
  assert.equal(sanitizeWindowsFilename('con.txt'), '_con.txt')
  assert.equal(sanitizeWindowsFilename('LPT9.log'), '_LPT9.log')
  assert.equal(sanitizeWindowsFilename('COM¹.txt'), '_COM¹.txt')
  assert.equal(sanitizeWindowsFilename('LPT³.log'), '_LPT³.log')
  assert.equal(sanitizeWindowsFilename('COM10.log'), 'COM10.log')
  assert.equal(sanitizeWindowsFilename('photo\u202Egnp.exe'), 'photo_gnp.exe')
  assert.equal(/[\\/:*?"<>|]/.test(sanitizeWindowsFilename('C:\\tmp/a?.txt')), false)
  assert.ok(sanitizeWindowsFilename(`${'a'.repeat(300)}.txt`).length <= 240)
})

test('downloadRisk catches executable and script extensions after Windows normalization', () => {
  for (const filename of [
    'installer.exe',
    'INSTALLER.MSI',
    'report.pdf.cmd',
    'script.ps1. ',
    'shortcut.lnk',
    'screensaver.scr',
    'macro.docm',
    'fullwidth．ｅｘｅ',
    'photo\u202Egnp.exe',
  ]) {
    assert.equal(downloadRisk(filename), 'dangerous', filename)
  }
  for (const filename of ['report.pdf', 'photo.png', 'archive.zip', 'notes.txt', 'COM10.log']) {
    assert.equal(downloadRisk(filename), 'safe', filename)
  }
})
