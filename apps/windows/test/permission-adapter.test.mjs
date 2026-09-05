import assert from 'node:assert/strict'
import test from 'node:test'

import { permissionDecision } from '../src/permission-adapter.mjs'

const appOrigin = 'https://claudeai.chat'

function webContents(url = `${appOrigin}/chat`) {
  return {
    getURL: () => url,
    isDestroyed: () => false,
  }
}

test('permission adapter denies null and destroyed WebContents without dereferencing them', () => {
  assert.equal(
    permissionDecision({
      webContents: null,
      permission: 'media',
      details: { isMainFrame: true, mediaType: 'audio' },
      appOrigin,
      checkOrigin: appOrigin,
    }),
    'deny',
  )

  const destroyed = {
    isDestroyed: () => true,
    getURL: () => {
      throw new Error('destroyed WebContents must not be dereferenced')
    },
  }
  assert.equal(
    permissionDecision({
      webContents: destroyed,
      mainWebContents: destroyed,
      permission: 'clipboard-sanitized-write',
      details: { isMainFrame: true },
      appOrigin,
      checkOrigin: appOrigin,
    }),
    'deny',
  )
})

test('permission adapter maps Electron check and request details into the strict policy', () => {
  const mainWebContents = webContents()
  assert.equal(
    permissionDecision({
      webContents: mainWebContents,
      mainWebContents,
      permission: 'media',
      details: { isMainFrame: true, mediaType: 'audio', securityOrigin: appOrigin },
      appOrigin,
      checkOrigin: appOrigin,
    }),
    'allow',
  )
  assert.equal(
    permissionDecision({
      webContents: mainWebContents,
      mainWebContents,
      permission: 'media',
      details: {
        isMainFrame: true,
        mediaTypes: ['audio'],
        requestingUrl: `${appOrigin}/chat`,
        securityOrigin: appOrigin,
      },
      appOrigin,
    }),
    'allow',
  )
  assert.equal(
    permissionDecision({
      webContents: mainWebContents,
      mainWebContents,
      permission: 'media',
      details: {
        isMainFrame: true,
        mediaTypes: ['audio'],
        requestingUrl: `${appOrigin}/chat`,
        securityOrigin: 'https://evil.example',
      },
      appOrigin,
    }),
    'deny',
  )
})
