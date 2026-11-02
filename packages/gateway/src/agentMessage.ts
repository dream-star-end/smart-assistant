/**
 * Gateway inbound agent-message handling, adapter outbound send, bridge bypass check and session-open preheat
 *
 * Moved verbatim out of Gateway (server.ts) — FINDINGS §7.6, OCV5-533. The class
 * keeps one-line forwarders that call these with the instance as `this`, so behaviour, closures and
 * `this.x` reads/writes are unchanged. AgentMessageHost lists exactly the Gateway members this code
 * touches (typed from the class itself).
 */
import { runSessionPreheat, type SessionPreheatHost } from './sessionPreheat.js'
import { fetchIdentityCompatProjection } from '@openclaude/storage'
import { resolveIdentityCompat, assertIdentityCompatReady } from '@openclaude/protocol'
import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isIPv4 } from 'node:net'
import type { ChannelAdapter } from '@openclaude/plugin-sdk'
import type { OutboundMessage } from '@openclaude/protocol'
import { isHiddenSystemAgentId } from './agentVisibility.js'
import { matchBridgeApiAllowlist } from './bridgeApiAllowlist.js'
import { resolveLocalExecutionIfEnforced, localExecutionOverride, resolveSyntheticTurnModel } from './localExecution.js'
import type { LocalExecutionDecision } from './localExecution.js'
import { _stripPrivateRoutingFields } from './turnFrames.js'
import { SESSION_OPEN_PREHEAT_DEBOUNCE_MS, hasContainerCatalogEnv } from './server.js'
import type { Gateway } from './server.js'

export interface AgentMessageHost {
  _getAgentsConfig: Gateway['_getAgentsConfig']
  _mapLocalExecutionError: Gateway['_mapLocalExecutionError']
  _sessionOpenPreheatAt: Gateway['_sessionOpenPreheatAt']
  deliver: Gateway['deliver']
  deps: Gateway['deps']
  lastActiveChannel: Gateway['lastActiveChannel']
  log: Gateway['log']
  readBody: Gateway['readBody']
  sendError: Gateway['sendError']
  sendJson: Gateway['sendJson']
  sessions: Gateway['sessions']
}

// GET /api/search?q=... → full-text search past sessions
// ── Inter-agent messaging ──
export async function handleAgentMessage(this: AgentMessageHost, req: IncomingMessage, res: ServerResponse, targetAgentId: string): Promise<void> {
  if (req.method !== 'POST') return this.sendError(res, 405, 'method not allowed')
  const body = await this.readBody(req)
  let parsed: any
  try {
    parsed = JSON.parse(body)
  } catch {
    return this.sendError(res, 400, 'invalid JSON')
  }
  const { message, sourceAgent } = parsed
  if (!message) return this.sendError(res, 400, 'message required')
  if (isHiddenSystemAgentId(targetAgentId)) {
    return this.sendError(res, 404, `agent "${targetAgentId}" not found`)
  }

  // Find target agent
  const cfg = await this._getAgentsConfig()
  const identityProjection = await fetchIdentityCompatProjection()
  const targetIdentity = identityProjection ? resolveIdentityCompat(targetAgentId, identityProjection) : undefined
  if (targetIdentity) assertIdentityCompatReady(targetIdentity)
  const targetAgent = cfg.agents.find((a) => a.id === (targetIdentity?.executionAgentId ?? targetAgentId))
  if (!targetAgent) return this.sendError(res, 404, `agent "${targetAgentId}" not found`)

  const sessionKey = `agent:${targetAgentId}:inter:dm:${sourceAgent || 'system'}`
  this.log.info('inter-agent message', {
    sourceAgent,
    targetAgentId,
    preview: message.slice(0, 60),
  })

  // Create/reuse session for the target agent
  // 合成首帧路由字段补齐(同 cron):agent 间消息的会话首帧绕过 master bridge
  // 计费编排,落 codex 会被 CODEX_BILLING_GUARD 拒 → 解析为非 codex 执行模型。
  const _iaRoute = resolveSyntheticTurnModel(targetAgent, this.deps.config.defaults.model)
  // 模型权威 §3(无 envelope 的本地路径):flag 开 → 判定源换成 master catalog 投影。
  let _iaExec: LocalExecutionDecision | undefined
  try {
    _iaExec = await resolveLocalExecutionIfEnforced({
      catalog: this.sessions.runtime?.catalog,
      agent: targetAgent,
      kind: 'synthetic',
      model: _iaRoute?.model,
      defaultModel: this.deps.config.defaults.model,
    })
  } catch (err) {
    const mapped = this._mapLocalExecutionError(err)
    if (!mapped) throw err
    return this.sendError(res, mapped.httpStatus, mapped.message)
  }
  const _iaModel = _iaExec?.canonicalModel ?? _iaRoute?.model
  const session = await this.sessions.getOrCreate({
    sessionKey,
    agent: targetAgent,
    ...(_iaModel ? { model: _iaModel } : {}),
    ...localExecutionOverride(_iaExec),
    channel: 'inter-agent',
    peerId: sourceAgent || 'system',
    title: `[from ${sourceAgent}] ${message.slice(0, 30)}`,
  })

  // Submit message and collect output
  let output = ''
  await this.sessions.submit(
    session,
    `[来自 agent "${sourceAgent}" 的消息]\n\n${message}`,
    (e) => {
      if (e.kind === 'block' && e.block.kind === 'text') output += e.block.text
    },
    undefined,
    _iaModel,
  )

  // Push result to user's active channel
  // (MAJOR-2 透明化:降级后的 effective_model 随 API 响应元数据回给调用方,见下方 sendJson。)
  const lastActive =
    this.lastActiveChannel.get('main') || this.lastActiveChannel.values().next().value
  if (lastActive && output.trim()) {
    // Route through deliver() so the ts-stamp happens centrally — bypass here
    // would let inter-agent replies slip past the web client's stale-final guard.
    this.deliver({
      type: 'outbound.message' as const,
      sessionKey: lastActive.sessionKey || `agent:${targetAgentId}:inter:dm:${sourceAgent}`,
      channel: 'webchat' as const,
      peer: { id: lastActive.peerId, kind: 'dm' as const },
      blocks: [
        { kind: 'text' as const, text: `📨 **${targetAgentId}** 回复:\n\n${output.trim()}` },
      ],
      isFinal: true,
      _userId: lastActive.userId,
    } as OutboundMessage)
  }

  this.sendJson(res, 200, {
    ok: true,
    agentId: targetAgentId,
    outputLength: output.length,
    ...(_iaRoute ? { effectiveModel: _iaRoute.model } : {}),
  })
}

export async function _sendAdapterOutboundMessage(this: AgentMessageHost, out: OutboundMessage, adapter: ChannelAdapter): Promise<void> {
  const { wire } = _stripPrivateRoutingFields(out as unknown as Record<string, unknown>)
  await adapter.send(wire as unknown as OutboundMessage)
}

/**
 * v3 file proxy: check whether this HTTP request is a valid HOST→container
 * bridge call for the explicit v3 bridge API allowlist. When true, the normal
 * checkHttpAuth() requirement is bypassed.
 *
 * All four conditions MUST hold:
 *  1. remote IP === OPENCLAUDE_TRUST_BRIDGE_IP (host in docker bridge)
 *  2. method + path match `BRIDGE_API_ALLOWLIST`
 *  3. X-OpenClaude-Container-Id === env.OC_CONTAINER_ID (binding)
 *  4. timingSafeEqual(X-OpenClaude-Bridge-Nonce, env.OC_BRIDGE_NONCE)
 *
 * Container side doesn't know the HOST's HMAC rootSecret — only its own
 * per-container nonce (HMAC(rootSecret, containerId)) injected at start.
 */
export function checkBridgeBypass(this: AgentMessageHost, req: IncomingMessage, url: URL): boolean {
  const TRUST_BRIDGE_IP = process.env.OPENCLAUDE_TRUST_BRIDGE_IP || ''
  const OC_CONTAINER_ID = process.env.OC_CONTAINER_ID || ''
  const OC_BRIDGE_NONCE = process.env.OC_BRIDGE_NONCE || ''
  if (!TRUST_BRIDGE_IP || !OC_CONTAINER_ID || !OC_BRIDGE_NONCE) return false
  // Codex R1/R2 SHOULD-3:形态校验与 /healthz 保持一致,防止 env 写错时 bypass 只
  // 看非空就放行(healthz 广播 ready 但 bypass 因细节 reject 会造成哑锁)。
  // 用 net.isIPv4 严格校验,不用松正则 —— out-of-range octet 也要拒。
  if (!isIPv4(TRUST_BRIDGE_IP)) return false
  if (!/^[1-9][0-9]{0,18}$/.test(OC_CONTAINER_ID)) return false
  if (!/^[0-9a-f]{64}$/i.test(OC_BRIDGE_NONCE)) return false
  const remoteIp = req.socket.remoteAddress || ''
  if (remoteIp !== TRUST_BRIDGE_IP && remoteIp !== `::ffff:${TRUST_BRIDGE_IP}`) return false
  const m = req.method || ''
  const p = url.pathname
  if (!matchBridgeApiAllowlist(p, m)) return false
  const hdrId = String(req.headers['x-openclaude-container-id'] ?? '').trim()
  if (hdrId !== OC_CONTAINER_ID) return false
  const hdrNonce = String(req.headers['x-openclaude-bridge-nonce'] ?? '').trim()
  if (!/^[0-9a-f]{64}$/i.test(hdrNonce)) return false
  if (hdrNonce.length !== OC_BRIDGE_NONCE.length) return false
  try {
    return timingSafeEqual(Buffer.from(hdrNonce, 'hex'), Buffer.from(OC_BRIDGE_NONCE, 'hex'))
  } catch {
    return false
  }
}

export function _preheatSessionOnOpen(this: AgentMessageHost, sessId: string, userId: string, row: { agentId?: string; modelId?: string }): void {
  if (process.env.OC_ENGINE_PREHEAT !== '1') return
  const aid = row.agentId || 'main'
  if (isHiddenSystemAgentId(aid)) return
  const stamps = this._sessionOpenPreheatAt ?? (this._sessionOpenPreheatAt = new Map())
  const debounceKey = `${sessId}:${aid}:${row.modelId ?? ''}`
  const now = Date.now()
  const last = stamps.get(debounceKey)
  if (last !== undefined && now - last < SESSION_OPEN_PREHEAT_DEBOUNCE_MS) return
  stamps.set(debounceKey, now)
  if (stamps.size > 256) {
    for (const [k, ts] of stamps) {
      if (now - ts >= SESSION_OPEN_PREHEAT_DEBOUNCE_MS) stamps.delete(k)
    }
  }
  void (async () => {
    if (hasContainerCatalogEnv()) {
      await runSessionPreheat(this as unknown as SessionPreheatHost, sessId, userId, row)
      return
    }
    const hook = this.deps.commercial?.preheatUserContainer
    if (!hook) {
      this.log.info('engine_preheat_skipped', {
        sessionKey: `agent:${aid}:webchat:dm:${sessId}`,
        outcome: 'skipped_no_container_channel',
      })
      return
    }
    await hook({
      userId,
      sessionId: sessId,
      agentId: aid,
      ...(row.modelId ? { modelId: row.modelId } : {}),
    })
  })().catch((err) => {
    this.log.warn('session-open engine preheat failed', { sessId }, err)
  })
}
