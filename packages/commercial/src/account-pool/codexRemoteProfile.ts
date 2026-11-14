import { createHash } from 'node:crypto'
import { PLATFORM_REASONING_EFFORTS } from '@openclaude/protocol'
export interface CodexExecutionSnapshot {
  version: 1
  modelList: Array<Record<string, any>>
  modelCatalog: { models: Array<Record<string, any>> }
  cliSha256: string; nativeSha256: string; controllerSha256: string
}
export function parseCodexExecutionSnapshot(raw: unknown): CodexExecutionSnapshot {
  const s = raw as CodexExecutionSnapshot
  if (!s || s.version !== 1 || !Array.isArray(s.modelList) || !s.modelList.length || !Array.isArray(s.modelCatalog?.models) ||
    ![s.cliSha256, s.nativeSha256, s.controllerSha256].every(x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x)))
    throw new Error('CODEX_EXECUTION_SNAPSHOT_INVALID')
  const ids = s.modelList.map(m => m.model ?? m.id)
  if (ids.some(x => typeof x !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,56}$/.test(x)) ||
    new Set(ids).size !== ids.length || s.modelCatalog.models.length !== ids.length ||
    new Set(s.modelCatalog.models.map(m => m.slug)).size !== ids.length ||
    s.modelCatalog.models.some(m => !ids.includes(m.slug))) throw new Error('CODEX_EXECUTION_SNAPSHOT_INVALID')
  return structuredClone(s)
}
export function codexExecutionReady(profile: Record<string, any>): boolean {
  const p = profile.probe_snapshot, m = profile.execution_manifest
  try {
    const s = parseCodexExecutionSnapshot(p?.execution_snapshot)
    return profile.engine === 'codex' && profile.runner_mode === 'app-server' && profile.execution_ready === true &&
      p.probe_schema_version === 2 && p.source === 'codex-app-server:model/list' && p.freshness === 'cli-observed' &&
      p.auth_present === true && p.account_observed === true && p.models_observed === true && !p.error_code &&
      m?.version === 1 && m.backendKind === 'codex-app-server-v1' && m.authEpoch === profile.auth_epoch &&
      m.snapshotSha256 === p.snapshot_sha256 && m.controllerSha256 === s.controllerSha256 &&
      m.gatewayRevision === 'codex-remote-adapter-v1' && /^[a-f0-9]{64}$/.test(m.e2eReceiptSha256) &&
      m.installed === true && m.text === true
  } catch { return false }
}
export function projectCodexRemoteCapabilities(profile: Record<string, any>, upstream: string) {
  const snapshot = parseCodexExecutionSnapshot(profile.probe_snapshot?.execution_snapshot)
  const model = snapshot.modelList.find(m => (m.model ?? m.id) === upstream)
  if (!model || model.hidden === true) throw new Error('CODEX_MODEL_NOT_OBSERVED')
  const observed = Array.isArray(model.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts.map((e: any) => e.reasoningEffort) : []
  // Match the local Codex policy (protocol/engineModels): ultra enables native delegation,
  // which is owned by OpenClaude. Keep the native snapshot intact; reject every other unknown.
  const supported = observed.filter((e: any) => e !== 'ultra')
  if (supported.some((e: any) => !PLATFORM_REASONING_EFFORTS.includes(e)) || new Set(observed).size !== observed.length)
    throw new Error('CODEX_REASONING_PROFILE_INVALID')
  const def = model.defaultReasoningEffort ?? null
  // Never invent a remote default or let an omitted effort fall back to native ultra.
  if (def !== null && !supported.includes(def)) throw new Error('CODEX_REASONING_PROFILE_INVALID')
  const tiers = Array.isArray(model.serviceTiers) && model.serviceTiers.every((t: unknown) => typeof t === 'string') ? model.serviceTiers : []
  const image = Array.isArray(model.inputModalities) && model.inputModalities.includes('image')
  return {
    // The segment-1 controller deliberately only accepts text input. Never advertise unreachable vision/Fast.
    supports_vision: false,
    reasoning: { supported, codex_model_default: def },
    ccb: { capability_zero: false, supports_thinking: false },
    remote: { source: 'codex-app-server:model/list', observed_service_tiers: tiers, observed_vision: image,
      service_tiers: [], supports_fast: false },
  }
}
export function codexManifestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
