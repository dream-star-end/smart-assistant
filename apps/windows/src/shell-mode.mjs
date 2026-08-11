export const SHELL_MODES = Object.freeze(['toolbar', 'downloads', 'offline'])

export function normalizeShellMode(value) {
  return SHELL_MODES.includes(value) ? value : 'toolbar'
}

export function isModalShellMode(value) {
  return ['downloads', 'offline'].includes(normalizeShellMode(value))
}

export function shouldShowProduct(value) {
  return normalizeShellMode(value) === 'toolbar'
}

export function canFocusProduct(value) {
  return shouldShowProduct(value)
}

export function canOpenMoreMenu(value) {
  return normalizeShellMode(value) === 'toolbar'
}

export function hasProductRecoveryState(productState) {
  return productState?.network === 'offline' || Boolean(productState?.error)
}

export function canOpenDownloads(productState) {
  return !hasProductRecoveryState(productState)
}

export function shellModeAfterDownloadsClose(productState) {
  return hasProductRecoveryState(productState) ? 'offline' : 'toolbar'
}
