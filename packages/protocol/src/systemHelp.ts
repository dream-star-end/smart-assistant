/** Dedicated opaque help sidecar; independent of model and dispatch envelope versions. */
export const SYSTEM_HELP_CAPABILITY = 'system-help-relay-v1'
export const SYSTEM_HELP_BOOTSTRAP_FIELD = '__oc_system_help_bootstrap'
/** Always strip, including malformed/non-bridge frames. The return value is not verified identity. */
export function takeSystemHelpBootstrap(frame: unknown): string | undefined {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return undefined
  const fields = frame as Record<string, unknown>
  const value = fields[SYSTEM_HELP_BOOTSTRAP_FIELD]
  Reflect.deleteProperty(fields, SYSTEM_HELP_BOOTSTRAP_FIELD)
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 ? value : undefined
}
