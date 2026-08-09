export const PINNED_APP_URL = 'https://claudeai.chat/'
export const PINNED_APP_ORIGIN = 'https://claudeai.chat'
export const OAUTH_CALLBACK_PATHS = Object.freeze([
  '/api/auth/github/callback',
  '/api/connectors/oauth/callback',
  '/api/auth/linuxdo/callback',
])

const OAUTH_CALLBACK_URLS = new Set(
  OAUTH_CALLBACK_PATHS.map((pathname) => `${PINNED_APP_ORIGIN}${pathname}`),
)
const MAX_OAUTH_STATE_LENGTH = 512
const MAX_EXTERNAL_URL_LENGTH = 8192
const MAX_WINDOWS_FILENAME_LENGTH = 240
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

const URL_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const ENCODED_LINE_BREAK = /%0a|%0d/i
const WINDOWS_INVALID_CHARACTERS = /[\u0000-\u001f\u007f-\u009f<>:"/\\|?*]/g
const INVISIBLE_DIRECTIONAL_CHARACTERS = /[\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g
const WINDOWS_RESERVED_BASENAME =
  /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com(?:[1-9]|[¹²³])|lpt(?:[1-9]|[¹²³]))$/i

const DANGEROUS_WINDOWS_EXTENSIONS = new Set([
  '.ade',
  '.adp',
  '.app',
  '.application',
  '.appref-ms',
  '.appx',
  '.appxbundle',
  '.bat',
  '.chm',
  '.cmd',
  '.com',
  '.cpl',
  '.dll',
  '.docm',
  '.drv',
  '.exe',
  '.gadget',
  '.hta',
  '.inf',
  '.ins',
  '.iso',
  '.isp',
  '.jar',
  '.js',
  '.jse',
  '.lnk',
  '.mde',
  '.msc',
  '.msi',
  '.msp',
  '.mst',
  '.msix',
  '.msixbundle',
  '.pif',
  '.potm',
  '.ppam',
  '.pptm',
  '.ps1',
  '.ps1xml',
  '.psc1',
  '.psd1',
  '.psm1',
  '.reg',
  '.scf',
  '.scr',
  '.sct',
  '.shb',
  '.sldm',
  '.sys',
  '.url',
  '.vbe',
  '.vbs',
  '.vhd',
  '.vhdx',
  '.ws',
  '.wsc',
  '.wsf',
  '.wsh',
  '.xbap',
  '.xlam',
  '.xll',
  '.xlsm',
  '.xltm',
])

function parseUrl(value) {
  if (value instanceof URL) {
    try {
      return new URL(value.href)
    } catch {
      return null
    }
  }
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) return null
  if (URL_CONTROL_CHARACTERS.test(value)) return null
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function hasCredentials(url) {
  return url.username.length > 0 || url.password.length > 0
}

function normalizeAppOrigin(value = PINNED_APP_ORIGIN) {
  const url = parseUrl(value)
  if (
    !url ||
    hasCredentials(url) ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    !['http:', 'https:'].includes(url.protocol)
  ) {
    return null
  }
  if (url.origin === PINNED_APP_ORIGIN) return PINNED_APP_ORIGIN
  return LOOPBACK_HOSTS.has(url.hostname) ? url.origin : null
}

function isExactAppOriginValue(value, appOrigin) {
  const trustedOrigin = normalizeAppOrigin(appOrigin)
  const url = parseUrl(value)
  return Boolean(
    trustedOrigin &&
      url &&
      !hasCredentials(url) &&
      url.origin === trustedOrigin &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '',
  )
}

function isSafeExternalUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_EXTERNAL_URL_LENGTH) return false
  const url = parseUrl(value)
  if (!url) return false

  if (url.protocol === 'https:') {
    return !hasCredentials(url)
  }
  if (url.protocol === 'mailto:') {
    return url.pathname.length > 0 && !URL_CONTROL_CHARACTERS.test(value) && !ENCODED_LINE_BREAK.test(value)
  }
  return false
}

function isPinnedBlobUrl(value, appOrigin = PINNED_APP_ORIGIN) {
  const trustedOrigin = normalizeAppOrigin(appOrigin)
  const blobUrl = parseUrl(value)
  if (!trustedOrigin || !blobUrl || blobUrl.protocol !== 'blob:' || blobUrl.origin !== trustedOrigin)
    return false

  const serialized = blobUrl.href.slice('blob:'.length)
  const innerUrl = parseUrl(serialized)
  return Boolean(
    innerUrl &&
      ['http:', 'https:'].includes(innerUrl.protocol) &&
      innerUrl.origin === trustedOrigin &&
      !hasCredentials(innerUrl),
  )
}

function isOAuthCallbackPath(pathname) {
  return OAUTH_CALLBACK_PATHS.includes(pathname)
}

function hasSingleBoundedState(url) {
  const states = url.searchParams.getAll('state')
  if (states.length !== 1) return false
  const state = states[0]
  return (
    state.length > 0 &&
    state.length <= MAX_OAUTH_STATE_LENGTH &&
    state === state.trim() &&
    !URL_CONTROL_CHARACTERS.test(state)
  )
}

function hasExactOAuthRedirect(url, appOrigin) {
  const trustedOrigin = normalizeAppOrigin(appOrigin)
  if (!trustedOrigin) return false
  const redirects = url.searchParams.getAll('redirect_uri')
  const callbackUrls =
    trustedOrigin === PINNED_APP_ORIGIN
      ? OAUTH_CALLBACK_URLS
      : new Set(OAUTH_CALLBACK_PATHS.map((pathname) => `${trustedOrigin}${pathname}`))
  return redirects.length === 1 && callbackUrls.has(redirects[0])
}

function hasSupportedResponseType(url) {
  const responseTypes = url.searchParams.getAll('response_type')
  return responseTypes.length <= 1 && (responseTypes.length === 0 || ['', 'code'].includes(responseTypes[0]))
}

function isOAuthStart(currentUrl, targetUrl, appOrigin) {
  const trustedOrigin = normalizeAppOrigin(appOrigin)
  if (!trustedOrigin || !isPinnedOrigin(currentUrl, trustedOrigin)) return false
  const target = parseUrl(targetUrl)
  if (
    !target ||
    target.href.length > MAX_EXTERNAL_URL_LENGTH ||
    target.protocol !== 'https:' ||
    hasCredentials(target) ||
    target.origin === trustedOrigin
  ) {
    return false
  }
  return (
    hasSingleBoundedState(target) &&
    hasExactOAuthRedirect(target, trustedOrigin) &&
    hasSupportedResponseType(target)
  )
}

function truncateUtf16(value, maxLength) {
  if (value.length <= maxLength) return value
  let result = value.slice(0, maxLength)
  const finalCodeUnit = result.charCodeAt(result.length - 1)
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) result = result.slice(0, -1)
  return result
}

function truncateWindowsFilename(value) {
  if (value.length <= MAX_WINDOWS_FILENAME_LENGTH) return value

  const finalDot = value.lastIndexOf('.')
  const extension = finalDot > 0 && value.length - finalDot <= 32 ? value.slice(finalDot) : ''
  const stem = extension ? value.slice(0, finalDot) : value
  const stemLimit = MAX_WINDOWS_FILENAME_LENGTH - extension.length
  const shortenedStem = truncateUtf16(stem, stemLimit).replace(/[ .]+$/g, '')
  return `${shortenedStem || 'download'}${extension}`
}

function protectWindowsReservedName(value) {
  const firstDot = value.indexOf('.')
  const basename = (firstDot === -1 ? value : value.slice(0, firstDot)).replace(/[ .]+$/g, '')
  return WINDOWS_RESERVED_BASENAME.test(basename) ? `_${value}` : value
}

/**
 * Packaged builds always use the production origin. Development overrides fail closed and are
 * limited to explicit loopback hostnames; no DNS names that merely resolve to loopback are trusted.
 */
export function resolveStartUrl({ isPackaged, devUrl } = {}) {
  if (isPackaged || devUrl == null || devUrl === '') return PINNED_APP_URL

  const url = parseUrl(devUrl)
  if (
    !url ||
    !['http:', 'https:'].includes(url.protocol) ||
    hasCredentials(url) ||
    !LOOPBACK_HOSTS.has(url.hostname)
  ) {
    throw new TypeError('development URL must be http(s) on an explicit loopback host')
  }
  return url.href
}

export function isPinnedOrigin(value, appOrigin = PINNED_APP_ORIGIN) {
  const trustedOrigin = normalizeAppOrigin(appOrigin)
  const trustedUrl = trustedOrigin ? parseUrl(trustedOrigin) : null
  const url = parseUrl(value)
  return Boolean(
    trustedOrigin &&
      trustedUrl &&
      url &&
      url.protocol === trustedUrl.protocol &&
      url.origin === trustedOrigin &&
      !hasCredentials(url),
  )
}

export function isOAuthReturn(value, appOrigin = PINNED_APP_ORIGIN) {
  const url = parseUrl(value)
  return Boolean(
    url && isPinnedOrigin(url, appOrigin) && isOAuthCallbackPath(url.pathname) && url.hash === '',
  )
}

export function isOAuthFinalLanding(value, appOrigin = PINNED_APP_ORIGIN) {
  const url = parseUrl(value)
  return Boolean(url && isPinnedOrigin(url, appOrigin) && !isOAuthCallbackPath(url.pathname))
}

/**
 * @returns {'allow'|'oauth'|'external'|'oauth-return'|'oauth-final'|'deny'}
 */
export function classifyTopLevelNavigation({
  windowKind = 'main',
  currentUrl,
  targetUrl,
  appOrigin = PINNED_APP_ORIGIN,
} = {}) {
  const trustedOrigin = normalizeAppOrigin(appOrigin)
  const target = parseUrl(targetUrl)
  if (!trustedOrigin || !target) return 'deny'

  if (windowKind === 'auth') {
    if (hasCredentials(target)) return 'deny'
    if (isOAuthReturn(target, trustedOrigin)) return 'oauth-return'
    if (isPinnedOrigin(target, trustedOrigin) && isOAuthCallbackPath(target.pathname)) return 'deny'
    if (isOAuthFinalLanding(target, trustedOrigin)) return 'oauth-final'
    if (target.protocol !== 'https:') return 'deny'
    return 'allow'
  }

  if (windowKind !== 'main') return 'deny'
  if (isPinnedOrigin(target, trustedOrigin)) return 'allow'
  if (isOAuthStart(currentUrl, target, trustedOrigin)) return 'oauth'
  if (isPinnedOrigin(currentUrl, trustedOrigin) && isSafeExternalUrl(targetUrl)) return 'external'
  return 'deny'
}

/**
 * Renderer-created windows never inherit privileges. Main-page blobs get a restricted viewer;
 * ordinary links (including short-lived signed media URLs) are delegated to the system browser.
 * @returns {'blob-view'|'external'|'deny'}
 */
export function classifyWindowOpen({
  windowKind = 'main',
  currentUrl,
  targetUrl,
  appOrigin = PINNED_APP_ORIGIN,
} = {}) {
  const trustedOrigin = normalizeAppOrigin(appOrigin)
  if (!trustedOrigin || windowKind !== 'main' || !isPinnedOrigin(currentUrl, trustedOrigin))
    return 'deny'
  if (isPinnedBlobUrl(targetUrl, trustedOrigin)) return 'blob-view'
  if (isSafeExternalUrl(targetUrl)) return 'external'
  return 'deny'
}

/** @returns {'allow'|'deny'} */
export function classifyPermission({
  permission,
  requestingOrigin,
  embeddingOrigin,
  isMainWindow,
  isMainFrame,
  mediaTypes,
  appOrigin = PINNED_APP_ORIGIN,
} = {}) {
  const trustedOrigin = normalizeAppOrigin(appOrigin)
  if (
    !trustedOrigin ||
    isMainWindow !== true ||
    isMainFrame !== true ||
    !isExactAppOriginValue(requestingOrigin, trustedOrigin) ||
    !isExactAppOriginValue(embeddingOrigin, trustedOrigin)
  ) {
    return 'deny'
  }

  if (permission === 'clipboard-sanitized-write') return 'allow'
  if (
    permission === 'media' &&
    Array.isArray(mediaTypes) &&
    mediaTypes.length > 0 &&
    mediaTypes.every((mediaType) => mediaType === 'audio')
  ) {
    return 'allow'
  }
  return 'deny'
}

/** @returns {'allow'|'deny'} */
export function classifyDownload(targetUrl, appOrigin = PINNED_APP_ORIGIN) {
  const trustedOrigin = normalizeAppOrigin(appOrigin)
  const url = parseUrl(targetUrl)
  if (!trustedOrigin || !url) return 'deny'
  if (isPinnedOrigin(url, trustedOrigin)) return 'allow'
  return isPinnedBlobUrl(url, trustedOrigin) ? 'allow' : 'deny'
}

export function sanitizeWindowsFilename(input) {
  let value = typeof input === 'string' ? input : ''
  try {
    value = value.normalize('NFC')
  } catch {
    value = ''
  }

  value = value
    .replace(WINDOWS_INVALID_CHARACTERS, '_')
    .replace(INVISIBLE_DIRECTIONAL_CHARACTERS, '_')
    .trim()
    .replace(/[ .]+$/g, '')

  if (value === '' || value === '.' || value === '..') value = 'download'
  value = protectWindowsReservedName(value)
  value = truncateWindowsFilename(value).replace(/[ .]+$/g, '')
  if (value === '') value = 'download'
  return protectWindowsReservedName(value)
}

/** @returns {'dangerous'|'safe'} */
export function downloadRisk(filename) {
  let canonical = typeof filename === 'string' ? filename : ''
  try {
    canonical = canonical.normalize('NFKC')
  } catch {
    canonical = ''
  }
  canonical = sanitizeWindowsFilename(canonical).toLowerCase()
  const finalDot = canonical.lastIndexOf('.')
  const extension = finalDot > 0 ? canonical.slice(finalDot) : ''
  return DANGEROUS_WINDOWS_EXTENSIONS.has(extension) ? 'dangerous' : 'safe'
}
