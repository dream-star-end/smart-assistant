export function shouldWriteSmokeFailureReport({ smokeTest, smokeLocalHost } = {}) {
  return smokeTest === true || smokeLocalHost === true
}

export function resolveSmokeReportMode({ stage, smokeTest, smokeLocalHost } = {}) {
  if (stage === 'local-host' || (smokeLocalHost === true && smokeTest !== true)) {
    return 'smoke-local-host'
  }
  return 'smoke-test'
}

export function formatSmokeFailureReport({ stage, error, mode } = {}) {
  const detail = error instanceof Error ? error.stack || error.message : String(error ?? '')
  const resolvedMode = mode || 'smoke-test'
  return `[windows] ${stage} failed:\nmode: ${resolvedMode}\n${detail}\n`
}
