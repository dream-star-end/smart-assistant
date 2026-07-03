// Codex account-pool channel override for v3/v5 coexistence.
//
// This helper is ONLY for claude_accounts.runtime_channel filters where
// provider='codex'. It must never be used for agent_containers.runtime_channel,
// Docker names/labels, volume paths, media paths, or container identity.
// v3 containers remain v3-scoped even when they consume the v5-owned Codex
// subscription pool.

export type CodexAccountRuntimeChannel = 'v3' | 'v5'

export function getCodexAccountRuntimeChannel(): CodexAccountRuntimeChannel {
  const raw = process.env.OC_CODEX_ACCOUNT_RUNTIME_CHANNEL?.trim() || 'v3'
  if (raw !== 'v3' && raw !== 'v5') {
    throw new Error(
      `[codexAccountChannel] 非法 OC_CODEX_ACCOUNT_RUNTIME_CHANNEL='${raw}'(只允许 'v3' 或 'v5')`,
    )
  }
  return raw
}
