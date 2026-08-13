export function isPositiveTitlebarGeometry(width, height) {
  return Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0
}

export function attachWcoGeometryListeners({ window: targetWindow, overlay, onChange } = {}) {
  if (typeof onChange !== 'function') return false
  if (targetWindow && typeof targetWindow.addEventListener === 'function') {
    targetWindow.addEventListener('resize', onChange)
  }
  if (overlay && typeof overlay.addEventListener === 'function') {
    overlay.addEventListener('geometrychange', onChange)
  }
  return true
}
