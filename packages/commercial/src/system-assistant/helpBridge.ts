/** Add independent help to the unchanged durable-dispatch envelope, only after capability attestation. */
import { DISPATCH_AUTHORITY_FIELD, SYSTEM_HELP_BOOTSTRAP_FIELD } from '@openclaude/protocol'
import { mintDispatchEnvelope } from '../dispatch/dispatchSigner.js'
import type { SystemHelpIdentityScope } from './helpGrant.js'
type MintInput = Parameters<typeof mintDispatchEnvelope>[1]
interface AdmittedHelpDispatch {
  sessionId: string; clientMessageId: string; dispatchId: string; attemptNo: number
  requestHash: string; billingRequestId: string; agentId: string; leaseOwnerId: string; leaseEpoch: number
}
export function systemHelpDispatchFields(input: {
  record: AdmittedHelpDispatch | undefined
  signer: Parameters<typeof mintDispatchEnvelope>[0] | undefined
  uid: MintInput['uid']
  containerId: MintInput['containerId'] | undefined
  connectionChallenge: string | null
  supported: boolean
  issueBootstrap?: (scope: SystemHelpIdentityScope) => { token: string; expiresAt: number }
  onUnavailable(): void
}): Record<string, unknown> {
  const { record, signer, uid, containerId, connectionChallenge } = input
  if (!record || !signer || containerId === undefined || connectionChallenge === null) return {}
  const fields: Record<string, unknown> = { [DISPATCH_AUTHORITY_FIELD]: mintDispatchEnvelope(signer, {
    uid, containerId, connectionChallenge, sessionId: record.sessionId, clientMessageId: record.clientMessageId,
    dispatchId: record.dispatchId, attemptNo: record.attemptNo, payloadHash: record.requestHash, billingRequestId: record.billingRequestId,
  }) }
  if (input.supported && input.issueBootstrap) {
    try {
      fields[SYSTEM_HELP_BOOTSTRAP_FIELD] = input.issueBootstrap({ uid: uid.toString(), containerId: containerId.toString(), sessionId: record.sessionId,
        agentId: record.agentId, dispatchId: record.dispatchId, attemptNo: record.attemptNo, ownerId: record.leaseOwnerId, dispatchLeaseEpoch: String(record.leaseEpoch) }).token
    } catch { input.onUnavailable() }
  }
  return fields
}
