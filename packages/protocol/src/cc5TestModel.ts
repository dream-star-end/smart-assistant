/** Task-only personal-edition model policy. Pure: no I/O or ambient env reads. */
export const CC5_TEST_MODEL_ID = 'cc5-remote-t1555u' as const
export const CC5_TEST_ENABLED_ENV = 'OC_SELFHOST_CC5_T1555U_ENABLED' as const
export const CC5_TEST_UID_ENV = 'OC_SELFHOST_CC5_T1555U_TEST_UID' as const
export type Cc5PolicyEnvironment = Readonly<Record<string, string | undefined>>

export function isCc5TestModel(value: unknown): value is typeof CC5_TEST_MODEL_ID {
  return value === CC5_TEST_MODEL_ID
}

function positiveUid(value: unknown): string | null {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) return null
    return String(value)
  }
  const text = typeof value === 'bigint' ? String(value) : value
  if (typeof text !== 'string' || !/^[1-9][0-9]{0,18}$/.test(text)) return null
  return BigInt(text) <= 9223372036854775807n ? text : null
}

/** Grant preparation may occur while the route stays disabled/staged. */
export function isCc5ConfiguredTestUid(uid: unknown, env: Cc5PolicyEnvironment): boolean {
  const configured = positiveUid(env[CC5_TEST_UID_ENV])
  return configured !== null && positiveUid(uid) === configured
}

/** AND this with existing catalog, grants, plan, authority and lease checks. */
export function canUseCc5TestModel(uid: unknown, env: Cc5PolicyEnvironment): boolean {
  return env[CC5_TEST_ENABLED_ENV] === '1' && isCc5ConfiguredTestUid(uid, env)
}
