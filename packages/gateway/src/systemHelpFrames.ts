/** Trusted, nonserializable ingress sidecar. No opaque grant enters a prompt or tape. */
import { getDispatchContext } from './turnDispatchInbox.js'
const bootstrapByFrame = new WeakMap<object, string>()
export function captureSystemHelpFrame(frame: object, bootstrap: string | undefined, isFromBridge: boolean): void {
  if (isFromBridge && getDispatchContext(frame) && typeof bootstrap === 'string' && bootstrap.length > 0 && bootstrap.length <= 4096) bootstrapByFrame.set(frame, bootstrap)
}
export function getSystemHelpBootstrap(frame: object): string | undefined { return bootstrapByFrame.get(frame) }
