import {
  PINNED_APP_ORIGIN,
  PINNED_APP_URL,
  classifyTopLevelNavigation,
} from './security-policy.mjs'

export const OPENCLAUDE_PROTOCOL = 'openclaude'
const OPENCLAUDE_SCHEME = `${OPENCLAUDE_PROTOCOL}:`
const MAX_DEEP_LINK_LENGTH = 8192
// biome-ignore lint/suspicious/noControlCharactersInRegex: deep-link parsing rejects ASCII controls.
const URL_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

export function findOpenClaudeUrlInArgv(argv) {
  if (!Array.isArray(argv)) return null
  for (const argument of argv) {
    if (typeof argument === 'string' && argument.startsWith(`${OPENCLAUDE_PROTOCOL}:`)) {
      return argument
    }
  }
  return null
}

export function parseOpenClaudeDeepLink(raw, { appOrigin = PINNED_APP_ORIGIN } = {}) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_DEEP_LINK_LENGTH) {
    return { action: 'ignore', reason: 'invalid-url' }
  }
  if (raw !== raw.trim() || URL_CONTROL_CHARACTERS.test(raw)) {
    return { action: 'ignore', reason: 'invalid-url' }
  }

  let url
  try {
    url = new URL(raw)
  } catch {
    return { action: 'ignore', reason: 'invalid-url' }
  }

  if (url.protocol !== OPENCLAUDE_SCHEME) {
    return { action: 'ignore', reason: 'unsupported-scheme' }
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return { action: 'ignore', reason: 'credentials' }
  }
  if (url.hostname !== 'open' || (url.pathname !== '' && url.pathname !== '/')) {
    return { action: 'ignore', reason: 'unsupported-host' }
  }

  const paths = url.searchParams.getAll('path')
  if (paths.length !== 1) {
    return { action: 'ignore', reason: 'invalid-path' }
  }

  const pathValue = paths[0]
  if (
    typeof pathValue !== 'string' ||
    !pathValue.startsWith('/') ||
    pathValue.startsWith('//') ||
    pathValue.includes('\\')
  ) {
    return { action: 'ignore', reason: 'invalid-path' }
  }

  let target
  try {
    target = new URL(pathValue, `${PINNED_APP_ORIGIN}/`)
  } catch {
    return { action: 'ignore', reason: 'invalid-path' }
  }

  if (target.origin !== PINNED_APP_ORIGIN) {
    return { action: 'ignore', reason: 'unpinned-origin' }
  }

  const classification = classifyTopLevelNavigation({
    windowKind: 'main',
    currentUrl: PINNED_APP_URL,
    targetUrl: target.href,
    appOrigin,
  })
  if (classification !== 'allow') {
    return { action: 'ignore', reason: 'navigation-denied', classification }
  }

  return { action: 'open', targetUrl: target.href }
}
