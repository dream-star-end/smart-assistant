/** Personal deployments opt in explicitly; absence preserves foreground waits. */
export function isDelegateBackgroundEnabled(env: Record<string, string | undefined>): boolean {
  return env.OC_SELFHOST_ENGINE_LOCAL_TURNS === '1' && env.OC_DELEGATE_BACKGROUND === '1'
}
