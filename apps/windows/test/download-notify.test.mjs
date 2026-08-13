import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DOWNLOAD_NOTIFICATION_BODY,
  DOWNLOAD_NOTIFICATION_TITLE,
  LIVE_NOTIFICATION_LIMIT,
  canNotifyDownloadComplete,
  createDownloadCompletedNotification,
  retainNotification,
  shouldReleaseNotificationOnClose,
} from '../src/download-notify.mjs'

class FakeNotification {
  constructor(payload) {
    this.payload = payload
    this.handlers = new Map()
    this.shown = false
  }

  on(eventName, handler) {
    this.handlers.set(eventName, handler)
  }

  show() {
    this.shown = true
  }

  click() {
    this.handlers.get('click')?.()
  }
}

test('download toast uses a fixed title and body with no filename or path', () => {
  const shown = []
  const notification = createDownloadCompletedNotification({
    NotificationImpl: FakeNotification,
    id: 'abc-123',
    onShowDownload: (id) => shown.push(id),
  })
  assert.equal(notification.payload.title, DOWNLOAD_NOTIFICATION_TITLE)
  assert.equal(notification.payload.body, DOWNLOAD_NOTIFICATION_BODY)
  assert.equal(notification.payload.body.includes('\\'), false)
  assert.equal(notification.payload.body.includes('/'), false)
  assert.equal(notification.shown, true)
  notification.click()
  assert.deepEqual(shown, ['abc-123'])
})

test('download toast rejects unsafe ids and missing Notification implementations', () => {
  assert.equal(
    createDownloadCompletedNotification({
      NotificationImpl: FakeNotification,
      id: 'C:\\secret.pdf',
      onShowDownload: () => assert.fail('must not click'),
    }),
    null,
  )
  assert.equal(
    createDownloadCompletedNotification({
      NotificationImpl: FakeNotification,
      id: '../secret',
    }),
    null,
  )
  assert.equal(createDownloadCompletedNotification({ id: 'ok-id' }), null)
})

test('download toast construction failure and stale click stay silent', () => {
  class ThrowingNotification {
    constructor() {
      throw new Error('notifications unavailable')
    }
  }
  assert.equal(
    createDownloadCompletedNotification({
      NotificationImpl: ThrowingNotification,
      id: 'ok-id',
    }),
    null,
  )

  const notification = createDownloadCompletedNotification({
    NotificationImpl: FakeNotification,
    id: 'ok-id',
    onShowDownload: undefined,
  })
  notification.click()
})

test('download toast is suppressed after a failed registry complete or dead window', () => {
  assert.equal(
    canNotifyDownloadComplete({ completed: { id: 'ok' }, windowAlive: true, smokeTest: false }),
    true,
  )
  assert.equal(
    canNotifyDownloadComplete({ completed: null, windowAlive: true, smokeTest: false }),
    false,
  )
  assert.equal(
    canNotifyDownloadComplete({ completed: { id: 'ok' }, windowAlive: false, smokeTest: false }),
    false,
  )
  assert.equal(
    canNotifyDownloadComplete({ completed: { id: 'ok' }, windowAlive: true, smokeTest: true }),
    false,
  )
})

test('retainNotification keeps Windows toasts after close for Action Center clicks', () => {
  const registry = new Set()
  const notification = new FakeNotification({ title: 'x' })
  assert.equal(shouldReleaseNotificationOnClose('win32'), false)
  assert.equal(retainNotification(notification, registry, { releaseOnClose: false }), true)
  notification.handlers.get('close')?.()
  assert.equal(registry.has(notification), true)
  notification.handlers.get('failed')?.()
  assert.equal(registry.has(notification), false)
})

test('retainNotification releases on close when the platform does not keep Action Center toasts', () => {
  const registry = new Set()
  const notification = new FakeNotification({ title: 'x' })
  assert.equal(shouldReleaseNotificationOnClose('darwin'), true)
  assert.equal(retainNotification(notification, registry, { releaseOnClose: true }), true)
  notification.handlers.get('close')?.()
  assert.equal(registry.has(notification), false)
})

test('createDownloadCompletedNotification retains before show so sync failed is released', () => {
  class SyncFailedNotification {
    constructor(payload) {
      this.payload = payload
      this.handlers = new Map()
      this.shown = false
    }

    on(eventName, handler) {
      this.handlers.set(eventName, handler)
    }

    show() {
      this.shown = true
      this.handlers.get('failed')?.()
    }
  }

  const registry = new Set()
  const notification = createDownloadCompletedNotification({
    NotificationImpl: SyncFailedNotification,
    id: 'ok-id',
    registry,
    releaseOnClose: false,
  })
  assert.equal(notification.shown, true)
  assert.equal(registry.size, 0)
})

test('createDownloadCompletedNotification releases retain when show throws', () => {
  class ShowThrowsNotification {
    constructor(payload) {
      this.payload = payload
      this.handlers = new Map()
    }

    on(eventName, handler) {
      this.handlers.set(eventName, handler)
    }

    show() {
      throw new Error('show failed')
    }
  }

  const registry = new Set()
  assert.equal(
    createDownloadCompletedNotification({
      NotificationImpl: ShowThrowsNotification,
      id: 'ok-id',
      registry,
      releaseOnClose: false,
    }),
    null,
  )
  assert.equal(registry.size, 0)
})

test('live notification registry evicts the oldest instance at the cap', () => {
  const registry = new Set()
  const kept = []
  for (let index = 0; index < LIVE_NOTIFICATION_LIMIT + 3; index += 1) {
    const notification = new FakeNotification({ title: String(index) })
    retainNotification(notification, registry, { releaseOnClose: false })
    kept.push(notification)
  }
  assert.equal(registry.size, LIVE_NOTIFICATION_LIMIT)
  assert.equal(registry.has(kept[0]), false)
  assert.equal(registry.has(kept[3]), true)
  assert.equal(registry.has(kept.at(-1)), true)
})
