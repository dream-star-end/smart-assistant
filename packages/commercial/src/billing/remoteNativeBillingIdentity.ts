/** Separate from Box pool ownership and Codex durable tape recovery. */
export const REMOTE_NATIVE_BILLING_RECOVERY_VERSION = 'cc5-native-v1'

export const CODEX_REMOTE_BILLING_RECOVERY_VERSION = 'remote-native-v2'
/** Unknown future remote owners must never fall into generic refund/tape cleanup. */
export function isRemoteNativeBillingContext(ctx: Record<string, unknown>): boolean {
  return Object.hasOwn(ctx, 'remoteNativeBillingRecovery')
}
