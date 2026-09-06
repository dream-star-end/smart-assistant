import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CAPTION_OVERLAY_HEIGHT,
  applyCaptionOverlay,
  captionOverlayColors,
  captionOverlayOptions,
  createWindowWithCaptionFallback,
  hasCaptionOverlayKeys,
  overlayWindowOptions,
  shouldUseCaptionOverlay,
} from '../src/desktop-chrome.mjs'
import { TOOLBAR_HEIGHT } from '../src/window-layout.mjs'

test('caption overlay is Windows-only and locked to the 44px app bar height', () => {
  assert.equal(CAPTION_OVERLAY_HEIGHT, TOOLBAR_HEIGHT)
  assert.equal(CAPTION_OVERLAY_HEIGHT, 44)
  assert.equal(shouldUseCaptionOverlay({ platform: 'win32' }), true)
  assert.equal(shouldUseCaptionOverlay({ platform: 'darwin' }), false)
  assert.equal(shouldUseCaptionOverlay({ platform: 'linux' }), false)
  assert.equal(overlayWindowOptions({ platform: 'darwin' }).overlayActive, false)
  assert.deepEqual(overlayWindowOptions({ platform: 'darwin' }).windowOptions, {})
})

test('overlay colors stay opaque including forced-colors high-contrast pairs', () => {
  const light = captionOverlayColors({ dark: false, forcedColors: false })
  const dark = captionOverlayColors({ dark: true, forcedColors: false })
  const forcedLight = captionOverlayColors({ dark: false, forcedColors: true })
  const forcedDark = captionOverlayColors({ dark: true, forcedColors: true })
  for (const colors of [light, dark, forcedLight, forcedDark]) {
    assert.match(colors.color, /^#[0-9a-f]{6}$/)
    assert.match(colors.symbolColor, /^#[0-9a-f]{6}$/)
  }
  assert.deepEqual(forcedLight, { color: '#ffffff', symbolColor: '#000000' })
  assert.deepEqual(forcedDark, { color: '#000000', symbolColor: '#ffffff' })
  assert.equal(captionOverlayOptions({ dark: false }).height, 44)
})

test('createWindowWithCaptionFallback uses overlay options only on the Windows success path', () => {
  const calls = []
  const created = createWindowWithCaptionFallback({
    platform: 'win32',
    theme: { dark: true, forcedColors: false },
    extraOptions: { width: 1280, height: 800, show: false },
    createWindow: (options) => {
      calls.push(options)
      return { id: 'overlay' }
    },
  })
  assert.equal(created.overlayActive, true)
  assert.equal(created.window.id, 'overlay')
  assert.equal(calls[0].titleBarStyle, 'hidden')
  assert.equal(calls[0].titleBarOverlay.height, 44)
  assert.equal(calls[0].width, 1280)
  assert.equal(hasCaptionOverlayKeys(calls[0]), true)
})

test('overlay constructor failure recreates a window without hidden or overlay keys', () => {
  const calls = []
  const created = createWindowWithCaptionFallback({
    platform: 'win32',
    theme: { dark: false, forcedColors: true },
    extraOptions: { width: 800, height: 600 },
    createWindow: (options) => {
      calls.push({ ...options })
      if (hasCaptionOverlayKeys(options)) throw new Error('overlay unsupported')
      return { id: 'standard' }
    },
  })
  assert.equal(created.overlayActive, false)
  assert.equal(created.window.id, 'standard')
  assert.equal(calls.length, 2)
  assert.equal(hasCaptionOverlayKeys(calls[0]), true)
  assert.equal(hasCaptionOverlayKeys(calls[1]), false)
  assert.equal('titleBarStyle' in calls[1], false)
  assert.equal('titleBarOverlay' in calls[1], false)
  assert.equal(calls[1].width, 800)
})

test('non-Windows creation never requests overlay options', () => {
  const calls = []
  const created = createWindowWithCaptionFallback({
    platform: 'darwin',
    extraOptions: { width: 1000, height: 700 },
    createWindow: (options) => {
      calls.push(options)
      return { id: 'mac' }
    },
  })
  assert.equal(created.overlayActive, false)
  assert.equal(hasCaptionOverlayKeys(calls[0]), false)
})

test('applyCaptionOverlay updates only an active overlay and keeps opaque colors', () => {
  const calls = []
  const window = { setTitleBarOverlay: (value) => calls.push(value) }
  assert.equal(
    applyCaptionOverlay(window, {
      overlayActive: true,
      nativeTheme: { shouldUseDarkColors: false, inForcedColorsMode: true },
    }),
    true,
  )
  assert.deepEqual(calls[0], {
    height: 44,
    color: '#ffffff',
    symbolColor: '#000000',
  })
  assert.equal(applyCaptionOverlay(window, { overlayActive: false, nativeTheme: {} }), false)
})
