// containerDispatchClient —— reconciler 向容器求证 dispatch 归宿的**共享调用封装**
// (RFC-v5-durable-turn-dispatch §2.3 / §3)。
//
// 复用 wechat/inboundDispatcher 的 transport/HMAC 基建(**别复制**):
//   - HMAC nonce = computeInboundNonce(bridgeSecret, containerId)(与 wechat inbound 同一 secret);
//   - header 契约 = x-openclaude-container-id / x-openclaude-inbound-nonce / x-request-id(同一约定);
//   - transport = 注入的 ContainerTransport(nodeHttpContainerTransport 已加 request(),GET/POST 共用
//     同一 SSRF/deadline 基建;tunnel 路由由 transport 决定,self-host transport 对 remote-host
//     容器返 tunnel error → 本层归为 unreachable)。
//
// **绝不推断 negative proof(I2)**:容器不可达/超时/非 2xx → unreachable/error,由 reconciler
// 保持 rejecting 重试;只有容器**显式**回执 rejected tombstone 才允许下 not_accepted 终态。

import { randomBytes } from 'node:crypto'

import { computeInboundNonce } from '../bridgeSecret.js'
import type { ContainerTransport } from '../wechat/inboundDispatcher.js'

/** 容器 durable inbox 的行状态(与 gateway 侧 turn_dispatch_inbox.state 契约同源,RFC §3)。 */
export type ContainerInboxState =
  | 'rejected'
  | 'queued'
  | 'running'
  | 'recovery_pending'
  | 'sink_staged'
  | 'sink_stage_failed'
  | 'terminal'
  | 'absent'

export interface ContainerDispatchStateResponse {
  state: ContainerInboxState
  outcome?: string
}

export type ContainerCallResult =
  | { kind: 'ok'; state: ContainerInboxState; outcome?: string }
  /** 容器当前不在跑 / 远端 host 无 tunnel / 网络不可达 —— 保持 rejecting 重试,不推断终态。 */
  | { kind: 'unreachable'; detail: string }
  /** HTTP 通了但状态码非 2xx / body 无法解析 —— 同样不推断,重试。 */
  | { kind: 'error'; detail: string }

/** 非 provision 的运行中容器 endpoint(reconciler 绝不 cold-start 容器)。 */
export interface RunningContainerEndpoint {
  host: string
  port: number
  containerId: number
  tunnel?: unknown
}

export interface ContainerDispatchClientDeps {
  transport: ContainerTransport
  bridgeSecret: string
  /** 解析**当前运行中**容器 endpoint;不在跑 → null(绝不触发 provision)。 */
  resolveRunningEndpoint: (uid: bigint) => Promise<RunningContainerEndpoint | null>
  timeoutMs?: number
}

export const TURN_REJECT_IF_ABSENT_PATH = '/internal/v3/turn-reject-if-absent'
export const TURN_DISPATCH_STATE_PATH = '/internal/v3/turn-dispatch-state'
const DEFAULT_TIMEOUT_MS = 5_000

const VALID_STATES = new Set<ContainerInboxState>([
  'rejected',
  'queued',
  'running',
  'recovery_pending',
  'sink_staged',
  'sink_stage_failed',
  'terminal',
  'absent',
])

export interface DispatchIdentity {
  uid: bigint
  dispatchId: string
  attemptNo: number
  sessionId: string
  clientMessageId: string
}

function parseStateBody(bodyText: string): ContainerDispatchStateResponse | null {
  try {
    const parsed = JSON.parse(bodyText) as { found?: unknown; state?: unknown; outcome?: unknown }
    // B4(R3):行缺失的**权威 negative signal** = found:false → absent。两侧契约:新 gateway 缺行返
    // {found:false, state:'absent'};旧 gateway 曾返 {found:false, state:null}。两种都收敛成 absent,
    // reconciler 据此对 accepted 行走 manual_reconcile(行消失),不再因 state:null 解析失败误当 error
    // 无限重试。found:true 才落到下面按 state 字段解析(found 缺席=非本端点,同样按 state 判)。
    if (parsed.found === false) {
      return { state: 'absent' }
    }
    if (typeof parsed.state !== 'string' || !VALID_STATES.has(parsed.state as ContainerInboxState)) {
      return null
    }
    return {
      state: parsed.state as ContainerInboxState,
      ...(typeof parsed.outcome === 'string' ? { outcome: parsed.outcome } : {}),
    }
  } catch {
    return null
  }
}

export function makeContainerDispatchClient(deps: ContainerDispatchClientDeps): {
  rejectIfAbsent: (id: DispatchIdentity) => Promise<ContainerCallResult>
  getDispatchState: (id: DispatchIdentity) => Promise<ContainerCallResult>
} {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const call = async (
    id: DispatchIdentity,
    method: 'GET' | 'POST',
    path: string,
  ): Promise<ContainerCallResult> => {
    let endpoint: RunningContainerEndpoint | null
    try {
      endpoint = await deps.resolveRunningEndpoint(id.uid)
    } catch (err) {
      return { kind: 'unreachable', detail: `resolve endpoint: ${(err as Error)?.message ?? String(err)}` }
    }
    if (endpoint === null) return { kind: 'unreachable', detail: 'container not running' }
    if (endpoint.tunnel !== undefined && !deps.transport.supportsTunnel) {
      // remote-host 容器需 tunnel,self-host transport 打不到 → 归 unreachable(v1 self-host 范围)。
      return { kind: 'unreachable', detail: 'remote-host tunnel unsupported' }
    }

    const nonce = computeInboundNonce(deps.bridgeSecret, endpoint.containerId)
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-openclaude-container-id': String(endpoint.containerId),
      'x-openclaude-inbound-nonce': nonce,
      'x-request-id': `tdr-${randomBytes(8).toString('hex')}`,
    }
    const body =
      method === 'POST'
        ? JSON.stringify({
            dispatchId: id.dispatchId,
            attemptNo: id.attemptNo,
            // 裸 uid(与 descriptor.uid / gateway durable inbox 的 user_id 同源;RFC B1)。
            // 容器 turn_dispatch_inbox.user_id 存的就是裸 uid,`c:<uid>` 前缀是 client_sessions
            // 的 session 主体口径,不该泄漏进容器求证协议。
            userId: id.uid.toString(),
            sessionId: id.sessionId,
            clientMessageId: id.clientMessageId,
          })
        : null
    // GET 走 query string 携带身份(同 nonce header 鉴权)。
    const fullPath =
      method === 'GET'
        ? `${path}?dispatchId=${encodeURIComponent(id.dispatchId)}&attemptNo=${id.attemptNo}`
        : path

    let res: { status: number; bodyText: string }
    try {
      if (typeof deps.transport.request === 'function') {
        res = await deps.transport.request(method, endpoint, fullPath, headers, body, timeoutMs)
      } else if (method === 'POST' && body !== null) {
        res = await deps.transport.post(endpoint, fullPath, headers, body, timeoutMs)
      } else {
        return { kind: 'error', detail: 'transport does not support GET' }
      }
    } catch (err) {
      // transport 层错(connect refused / timeout / SSRF / tunnel) = 不可达,重试,不推断。
      return { kind: 'unreachable', detail: (err as Error)?.message ?? String(err) }
    }

    if (res.status === 404) {
      // 容器无该端点(capability 未上线 / 老 runtime)→ 不可达语义,保持 rejecting 重试。
      return { kind: 'unreachable', detail: 'endpoint 404 (no durable-turn-dispatch capability)' }
    }
    if (res.status < 200 || res.status >= 300) {
      return { kind: 'error', detail: `status ${res.status}: ${res.bodyText.slice(0, 200)}` }
    }
    const parsed = parseStateBody(res.bodyText)
    if (parsed === null) return { kind: 'error', detail: `unparseable state body: ${res.bodyText.slice(0, 200)}` }
    return { kind: 'ok', state: parsed.state, ...(parsed.outcome ? { outcome: parsed.outcome } : {}) }
  }

  return {
    rejectIfAbsent: (id) => call(id, 'POST', TURN_REJECT_IF_ABSENT_PATH),
    getDispatchState: (id) => call(id, 'GET', TURN_DISPATCH_STATE_PATH),
  }
}
