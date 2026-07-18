// dispatchSigner —— 铸 __oc_dispatch envelope 的**载荷组装侧**(RFC-v5-durable-turn-dispatch §2.2)。
//
// 分工(与 model authority 同构):
//   - authoritySigner.AuthoritySigner 持私钥,只对已组装 payload 铸签名(signDispatchAuthority);
//   - 本模块组装 DispatchAuthorityPayload 的业务字段并夹时效,再交签发器出票。
//
// 票据回答:「master 已为 (uid, session, clientMessageId) 受理了 dispatchId 的第 attemptNo
// 次执行,计费锚定 billingRequestId,帧体 hash 为 payloadHash」。容器 gateway 验签通过才对
// durable inbox 开门 —— at-most-once 执行的准入前提。裸 wire 字段可被容器内同 uid 进程伪造,
// **bridge 注入前必先无条件 strip 浏览器同名字段**(见 stripDispatchAuthorityField)。

import {
  type DispatchAuthorityPayload,
  DISPATCH_AUTHORITY_TTL_MS,
} from '@openclaude/protocol'
import type { AuthoritySigner } from '../ws/authoritySigner.js'

/** dispatchSigner 组装 payload 的业务入参(v/keyId/issuedAt/expiresAt 由本模块补齐)。 */
export interface DispatchEnvelopeInput {
  uid: bigint | number
  containerId: number
  sessionId: string
  clientMessageId: string
  dispatchId: string
  attemptNo: number
  /** = turn_dispatches.request_hash(sha256(text + sorted media refs));容器验帧体 hash 用。 */
  payloadHash: string
  /** = turn_dispatches.billing_request_id(受理铸、接管复用,永不重铸)。 */
  billingRequestId: string
  /** gateway hello attestation 给出的连接级 challenge。 */
  connectionChallenge: string
}

export interface MintDispatchOptions {
  /** 测试注入;生产恒 Date.now()。 */
  now?: number
  /** 票据 TTL(默认 DISPATCH_AUTHORITY_TTL_MS;只护送帧过桥,不护送执行期)。 */
  ttlMs?: number
}

/**
 * 组装并铸 __oc_dispatch envelope(base64url)。keyId 取签发器 activeKeyId —— 与 model
 * authority 同轮换五步基建,轮换窗口内新建容器现取新公钥即认得。
 */
export function mintDispatchEnvelope(
  signer: AuthoritySigner,
  input: DispatchEnvelopeInput,
  opts: MintDispatchOptions = {},
): string {
  const now = opts.now ?? Date.now()
  const ttlMs = opts.ttlMs ?? DISPATCH_AUTHORITY_TTL_MS
  // 签发侧对形状同样 fail-fast:签出一张必然验不过的票没有意义。
  if (!Number.isInteger(input.attemptNo) || input.attemptNo < 1) {
    throw new Error('[dispatch-authority] attemptNo must be a positive integer')
  }
  for (const [key, value] of Object.entries({
    sessionId: input.sessionId,
    clientMessageId: input.clientMessageId,
    dispatchId: input.dispatchId,
    payloadHash: input.payloadHash,
    billingRequestId: input.billingRequestId,
    connectionChallenge: input.connectionChallenge,
  })) {
    if (typeof value !== 'string' || value === '') {
      throw new Error(`[dispatch-authority] ${key} must be a non-empty string`)
    }
  }
  const payload: DispatchAuthorityPayload = {
    v: 1,
    keyId: signer.activeKeyId,
    uid: String(input.uid),
    containerId: String(input.containerId),
    sessionId: input.sessionId,
    clientMessageId: input.clientMessageId,
    dispatchId: input.dispatchId,
    attemptNo: input.attemptNo,
    payloadHash: input.payloadHash,
    billingRequestId: input.billingRequestId,
    connectionChallenge: input.connectionChallenge,
    issuedAt: now,
    expiresAt: now + ttlMs,
  }
  return signer.signDispatchAuthority(payload)
}
