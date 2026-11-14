// Closed vocabularies only: never serialize upstream errors, URLs, DOM or credentials.
export const KP_LOGIN_STAGES = ['launch', 'navigate', 'capture_qr', 'wait_scan'] as const
export const KP_LOGIN_REASONS = [
  'timeout', 'dns', 'connection', 'tls', 'proxy', 'http_error', 'policy_blocked',
  'image_unreadable', 'image_not_ready', 'unknown',
] as const
export interface KnowledgePlanetLoginDiagnostic {
  stage: (typeof KP_LOGIN_STAGES)[number]
  reason: (typeof KP_LOGIN_REASONS)[number]
}

export const KNOWLEDGE_PLANET_LOGIN_DIAGNOSTIC_SOURCE = String.raw`
function loginFailureReason(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  if (/ERR_NAME_NOT_RESOLVED/.test(message)) return 'dns';
  if (/ERR_PROXY|ERR_TUNNEL/.test(message)) return 'proxy';
  if (/ERR_CERT|ERR_SSL/.test(message)) return 'tls';
  if (/ERR_CONNECTION|ERR_NETWORK|ERR_INTERNET/.test(message)) return 'connection';
  if (error?.name === 'TimeoutError' || /Timeout|timeout/.test(message) || message === 'qr') return 'timeout';
  if (error?.name === 'SecurityError' || /SecurityError|tainted canvas/.test(message)) return 'image_unreadable';
  return 'unknown';
}
`
