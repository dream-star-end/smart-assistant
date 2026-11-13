import { createHash } from 'node:crypto'
import { CODEX_REMOTE_BACKEND, parseCodexExecutionBackend, type CodexExecutionBackend } from '@openclaude/protocol'
import type { Cc5BridgeBinding } from './cc5BridgePort.js'
import type { Cc5NativeTerminalReceipt, Cc5NativeUsage } from './cc5Finance.js'
import { cc5ToolInputSha256 } from './cc5NativeTool.js'

export interface CodexRemoteBinding extends Omit<Cc5BridgeBinding, 'version' | 'backendKind'> {
  readonly version: 3
  readonly backendKind: typeof CODEX_REMOTE_BACKEND
  readonly generation: string
  readonly profileId: string
  readonly authEpoch: string
  readonly manifestSha256: string
}
export type RemoteBridgeBinding = Cc5BridgeBinding | CodexRemoteBinding
export const CODEX_USAGE_SEMANTICS = 'codex-0.167-total-v1' as const
export interface CodexNativeTokens {
  inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number
  outputTokens: number; reasoningOutputTokens: number
}
export interface CodexNativeTerminalReceipt {
  version: 3
  backendKind: typeof CODEX_REMOTE_BACKEND
  uid: string; containerDbId: string; dockerId: string; operationId: string; runId: string
  sessionKey: string; canonicalModel: string; upstreamModel: string
  generation: string; profileId: string; authEpoch: string; manifestSha256: string
  authorityTurnId: string; turnKey: string
  nativeThreadId: string; nativeTurnId: string
  usageSemantics: typeof CODEX_USAGE_SEMANTICS
  baseline: CodexNativeTokens; total: CodexNativeTokens; nativeUsage: CodexNativeTokens
  usage: Cc5NativeUsage
  status: 'success' | 'error'
  nativeStatus: 'completed' | 'failed' | 'interrupted'
  resultSha256: string
}
export type RemoteNativeTerminalReceipt = Cc5NativeTerminalReceipt | CodexNativeTerminalReceipt
export const nativeId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v)
export function codexNeed(value: unknown, label = 'CODEX_REMOTE_REJECTED'): asserts value {
  if (!value) throw new Error(label)
}
export function codexBackend(binding: CodexRemoteBinding): CodexExecutionBackend {
  return parseCodexExecutionBackend({ kind: binding.backendKind, version: 1, sessionKey: binding.sessionKey,
    operationId: binding.operationId, generation: binding.generation, profileId: binding.profileId, authEpoch: binding.authEpoch })
}
export function assertCodexBinding(b: CodexRemoteBinding): void {
  codexBackend(b)
  codexNeed(b.version === 3 && /^[a-z0-9][a-z0-9._-]{0,56}-remote$/.test(b.canonicalModel) &&
    /^[1-9][0-9]{0,18}$/.test(b.uid) && /^[1-9][0-9]{0,18}$/.test(b.containerDbId) &&
    /^[a-f0-9]{64}$/.test(b.dockerId) && /^[a-f0-9]{64}$/.test(b.capability) &&
    /^[a-f0-9]{64}$/.test(b.manifestSha256) && /^[a-f0-9-]{36}$/.test(b.runId) && Number.isSafeInteger(b.expiresAt))
}
export function nativeTokens(raw: unknown): CodexNativeTokens {
  const u = raw as CodexNativeTokens
  codexNeed(u && typeof u === 'object' && !Array.isArray(u) &&
    Object.keys(u).sort().join(',') === 'cacheWriteInputTokens,cachedInputTokens,inputTokens,outputTokens,reasoningOutputTokens')
  for (const v of Object.values(u)) codexNeed(typeof v === 'number' && Number.isSafeInteger(v) && v >= 0)
  codexNeed(u.cachedInputTokens <= u.inputTokens && u.reasoningOutputTokens <= u.outputTokens)
  // No measured cache-write semantics yet. Do not silently lose or double-charge this field.
  codexNeed(u.cacheWriteInputTokens === 0, 'CODEX_USAGE_SEMANTICS_UNPROVEN')
  return { ...u }
}
export function zeroNativeTokens(): CodexNativeTokens {
  return { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }
}
export function nativeDelta(total: CodexNativeTokens, baseline: CodexNativeTokens): CodexNativeTokens {
  nativeTokens(total); nativeTokens(baseline)
  const d = Object.fromEntries(Object.keys(total).map(k => [k, total[k as keyof CodexNativeTokens] - baseline[k as keyof CodexNativeTokens]]))
  return nativeTokens(d)
}
export function normalizeCodexUsage(delta: CodexNativeTokens): Cc5NativeUsage {
  nativeTokens(delta)
  return { inputTokens: delta.inputTokens - delta.cachedInputTokens, outputTokens: delta.outputTokens,
    cacheReadTokens: delta.cachedInputTokens, cacheWriteTokens: delta.cacheWriteInputTokens }
}
/** Semantic digest excludes transport run/generation so reconnect cannot mint a new native turn. */
export function codexReceiptDigest(r: Omit<CodexNativeTerminalReceipt, 'resultSha256'>): string {
  return cc5ToolInputSha256({ uid: r.uid, operationId: r.operationId, profileId: r.profileId, authEpoch: r.authEpoch,
    nativeThreadId: r.nativeThreadId, nativeTurnId: r.nativeTurnId, canonicalModel: r.canonicalModel,
    upstreamModel: r.upstreamModel, authorityTurnId: r.authorityTurnId, turnKey: r.turnKey,
    status: r.status, nativeStatus: r.nativeStatus, usageSemantics: r.usageSemantics, baseline: r.baseline, total: r.total })
}
export function buildCodexReceipt(b: CodexRemoteBinding, identity: {
  authorityTurnId: string; turnKey: string; upstreamModel: string; nativeThreadId: string; nativeTurnId: string
}, baseline: CodexNativeTokens, total: CodexNativeTokens, status: CodexNativeTerminalReceipt['nativeStatus']): CodexNativeTerminalReceipt {
  assertCodexBinding(b)
  const { capability: _, expiresAt: __, ...scope } = b
  const nativeUsage = nativeDelta(total, baseline)
  const r = { ...scope, ...identity, usageSemantics: CODEX_USAGE_SEMANTICS, baseline: nativeTokens(baseline), total: nativeTokens(total),
    nativeUsage, usage: normalizeCodexUsage(nativeUsage), status: status === 'completed' ? 'success' as const : 'error' as const, nativeStatus: status }
  return { ...r, resultSha256: codexReceiptDigest(r) }
}
export const codexJsonHash = (raw: string | Buffer): string => createHash('sha256').update(raw).digest('hex')
