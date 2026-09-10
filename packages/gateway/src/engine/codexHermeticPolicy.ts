/**
 * Codex app-server reverse-RPC policy for hermeticNoTools (advisor / Auto-Dream).
 *
 * Decision strings are taken from the installed Codex 0.153.3 binary
 * (`acceptForSession` / `approved_for_session` / ReviewDecision::Denied).
 * Unknown methods stay method-not-found at the dispatcher.
 */

export const HERMETIC_CONTROL_ALLOW = new Set(['account/chatgptAuthTokens/refresh'])

export const HERMETIC_EXECUTION_DENY = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'execCommandApproval',
  'applyPatchApproval',
  'item/permissions/requestApproval',
  'mcpServer/elicitation/request',
  'item/tool/requestUserInput',
])

export type HermeticDenial =
  | { decision: 'denied'; reason: 'hermetic_no_tools' }
  | { decision: 'denied' }
  | { action: 'decline'; content: null; _meta: null }
  | { permissions: Record<string, never>; scope: 'turn'; strictAutoReview: true }

export function isHermeticControlMethod(method: string): boolean {
  return HERMETIC_CONTROL_ALLOW.has(method)
}

export function isHermeticExecutionMethod(method: string): boolean {
  return HERMETIC_EXECUTION_DENY.has(method)
}

/** Fail-closed denial payload. Never returns accept / acceptForSession. */
export function buildHermeticDenial(method: string): HermeticDenial | null {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { decision: 'denied', reason: 'hermetic_no_tools' }
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return { decision: 'denied' }
    case 'item/permissions/requestApproval':
      return { permissions: {}, scope: 'turn', strictAutoReview: true }
    case 'mcpServer/elicitation/request':
      return { action: 'decline', content: null, _meta: null }
    case 'item/tool/requestUserInput':
      return { decision: 'denied', reason: 'hermetic_no_tools' }
    default:
      return null
  }
}

export function hermeticSpawnShouldSkipFeature(flag: 'request_user_input' | 'apply_patch_streaming'): boolean {
  return flag === 'request_user_input' || flag === 'apply_patch_streaming'
}
