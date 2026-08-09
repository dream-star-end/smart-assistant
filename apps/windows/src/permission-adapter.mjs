import { classifyPermission } from './security-policy.mjs'

function originOf(value) {
  try {
    return new URL(value).origin
  } catch {
    return ''
  }
}

/**
 * Converts Electron's request/check callback shapes into the shared permission policy.
 * Permission checks may legitimately have no associated WebContents (for example a worker),
 * so missing or destroyed contents must fail closed before any method is called on them.
 */
export function permissionDecision({
  webContents,
  mainWebContents,
  permission,
  details = {},
  appOrigin,
  checkOrigin,
} = {}) {
  if (!webContents || webContents.isDestroyed()) return 'deny'

  const mainFrameOrigin = originOf(webContents.getURL())
  const securityOrigin = originOf(details.securityOrigin || '')
  if (securityOrigin && securityOrigin !== appOrigin) return 'deny'

  const requestingOrigin =
    checkOrigin || details.requestingOrigin || originOf(details.requestingUrl || '')
  const embeddingOrigin = details.embeddingOrigin || mainFrameOrigin
  const mediaTypes = details.mediaTypes || (details.mediaType ? [details.mediaType] : [])
  return classifyPermission({
    permission,
    requestingOrigin,
    embeddingOrigin,
    isMainWindow: mainWebContents === webContents,
    isMainFrame: details.isMainFrame === true,
    mediaTypes,
    appOrigin,
  })
}
