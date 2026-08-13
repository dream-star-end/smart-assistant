export const DOWNLOAD_NOTIFICATION_TITLE = 'OpenClaude Aurora'
export const DOWNLOAD_NOTIFICATION_BODY = '下载已完成'
export const LIVE_NOTIFICATION_LIMIT = 20
const OPAQUE_DOWNLOAD_ID = /^[A-Za-z0-9_-]{1,128}$/

export function canNotifyDownloadComplete({ completed, windowAlive, smokeTest } = {}) {
  return completed != null && windowAlive === true && smokeTest !== true
}

export function shouldReleaseNotificationOnClose(platform) {
  return platform !== 'win32'
}

export function retainNotification(notification, registry, { releaseOnClose = false } = {}) {
  if (!notification || !registry || typeof registry.add !== 'function') return false
  registry.add(notification)
  while (registry.size > LIVE_NOTIFICATION_LIMIT) {
    const oldest = registry.values().next().value
    if (!oldest || oldest === notification) break
    registry.delete(oldest)
  }
  const release = () => registry.delete(notification)
  if (typeof notification.on === 'function') {
    if (releaseOnClose === true) notification.on('close', release)
    notification.on('failed', release)
  }
  return true
}

export function createDownloadCompletedNotification({
  NotificationImpl,
  onShowDownload,
  id,
  registry,
  releaseOnClose = false,
} = {}) {
  if (typeof NotificationImpl !== 'function') return null
  if (typeof id !== 'string' || !OPAQUE_DOWNLOAD_ID.test(id)) return null

  let notification = null
  try {
    notification = new NotificationImpl({
      title: DOWNLOAD_NOTIFICATION_TITLE,
      body: DOWNLOAD_NOTIFICATION_BODY,
    })
    if (notification && typeof notification.on === 'function') {
      notification.on('click', () => {
        if (typeof onShowDownload === 'function') onShowDownload(id)
      })
    }
    if (registry) retainNotification(notification, registry, { releaseOnClose })
    if (typeof notification?.show === 'function') notification.show()
    return notification
  } catch {
    if (notification && registry && typeof registry.delete === 'function') {
      registry.delete(notification)
    }
    return null
  }
}

