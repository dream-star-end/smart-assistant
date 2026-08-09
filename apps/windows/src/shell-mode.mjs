export function hasProductRecoveryState(productState) {
  return productState?.network === 'offline' || Boolean(productState?.error)
}

export function canOpenDownloads(productState) {
  return !hasProductRecoveryState(productState)
}

export function shellModeAfterDownloadsClose(productState) {
  return hasProductRecoveryState(productState) ? 'offline' : 'toolbar'
}
