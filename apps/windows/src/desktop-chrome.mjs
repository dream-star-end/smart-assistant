import { TOOLBAR_HEIGHT } from './window-layout.mjs'

export const CAPTION_OVERLAY_HEIGHT = TOOLBAR_HEIGHT

function opaqueHex(value, fallback) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : fallback
}

export function shouldUseCaptionOverlay({
  platform = typeof process !== 'undefined' ? process.platform : '',
} = {}) {
  return platform === 'win32'
}

export function captionOverlayColors({ dark = false, forcedColors = false } = {}) {
  if (forcedColors === true) {
    return dark === true
      ? { color: '#000000', symbolColor: '#ffffff' }
      : { color: '#ffffff', symbolColor: '#000000' }
  }
  return dark === true
    ? { color: '#1f2023', symbolColor: '#f3f4f5' }
    : { color: '#ffffff', symbolColor: '#1f2328' }
}

export function captionOverlayOptions(theme = {}) {
  const colors = captionOverlayColors(theme)
  return {
    height: CAPTION_OVERLAY_HEIGHT,
    color: opaqueHex(colors.color, '#ffffff'),
    symbolColor: opaqueHex(colors.symbolColor, '#1f2328'),
  }
}

export function overlayWindowOptions({ platform, theme } = {}) {
  if (!shouldUseCaptionOverlay({ platform })) {
    return { overlayActive: false, windowOptions: {} }
  }
  return {
    overlayActive: true,
    windowOptions: {
      titleBarStyle: 'hidden',
      titleBarOverlay: captionOverlayOptions(theme),
    },
  }
}

export function hasCaptionOverlayKeys(options = {}) {
  return Object.hasOwn(options, 'titleBarStyle') || Object.hasOwn(options, 'titleBarOverlay')
}

/**
 * Create a BaseWindow with Window Controls Overlay on Windows, or a standard frame otherwise.
 * Overlay construction is atomic: a failed overlay path never leaves a hidden window without
 * caption buttons. Non-overlay failures from the fallback constructor still propagate.
 */
export function createWindowWithCaptionFallback({
  platform,
  theme,
  extraOptions = {},
  createWindow,
} = {}) {
  if (typeof createWindow !== 'function') {
    throw new TypeError('createWindowWithCaptionFallback requires createWindow')
  }

  const requested = overlayWindowOptions({ platform, theme })
  const baseOptions = { ...extraOptions }
  if (hasCaptionOverlayKeys(baseOptions)) {
    throw new TypeError('extraOptions must not include titleBarStyle or titleBarOverlay')
  }

  if (requested.overlayActive !== true) {
    return { window: createWindow(baseOptions), overlayActive: false }
  }

  try {
    const window = createWindow({ ...baseOptions, ...requested.windowOptions })
    return { window, overlayActive: true }
  } catch {
    const window = createWindow(baseOptions)
    return { window, overlayActive: false }
  }
}

export function applyCaptionOverlay(window, { overlayActive, nativeTheme } = {}) {
  if (overlayActive !== true || typeof window?.setTitleBarOverlay !== 'function') return false
  const dark = nativeTheme?.shouldUseDarkColors === true
  const forcedColors =
    nativeTheme?.inForcedColorsMode === true || nativeTheme?.shouldUseHighContrastColors === true
  try {
    window.setTitleBarOverlay(captionOverlayOptions({ dark, forcedColors }))
    return true
  } catch {
    return false
  }
}
