/**
 * OCV5-556 release proof (INC-20261021-AGY-CRED-RESUME-GAP), shared by the
 * pinned selfhost release gate (scripts/check-v5-box-success-recovery.ts) and
 * the unit suite. Synthetic inputs only: no network, no database, no real token.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { supportsAutomaticTurnRecovery, supportsAutomaticRecoveryWithoutCheckpoint } from '@openclaude/protocol'
import { normalizeAntigravityErrorDetail } from '../engine/antigravityAdapter.js'
import { cleanupAntigravityLaunch, projectAntigravityPlatform } from '../engine/antigravityPlatform.js'
import { classifyRunError } from '../errorClassify.js'
import { historicalContextInjectionKey, providerGapMessagesAfterOwnTurn } from '../sessionManager.js'

export const RESUME_AGY_CRED_PROOF =
  '[ocv5-556-resume-agycred] PASS — a recovery give-up card keeps the native resume, a real gap injects only the missing rows, the Antigravity CLI token file outlives the turn hard limit, and its expiry error is a platform credential error recovered only through fresh master admission and a safe checkpoint'

/** Run inside a private OPENCLAUDE_HOME; returns the receipt line. */
export function proveResumeAgyCred(): string {
  const own = { role: 'assistant', id: 'srv-p-main-t7', text: 'engine answer' }
  const giveUp = {
    role: 'assistant',
    id: 'm-recovery-giveup-dlgcb-proof-1',
    text: '自动恢复已停止',
    status: 'completed',
    _source: 'server',
  }
  const next = { role: 'user', id: 'u-next', text: '继续', status: 'sending' }
  assert.equal(
    historicalContextInjectionKey({
      messages: [own, giveUp, next],
      peerId: 'p',
      agentId: 'main',
      hasProviderResumeId: true,
    }),
    null,
    'GIVEUP_CARD_DROPS_RESUME',
  )
  const other = { role: 'assistant', id: 'srv-p-codex-t1', text: 'other agent answer' }
  const delta = providerGapMessagesAfterOwnTurn({
    messages: [{ role: 'user', id: 'u-old', text: 'old' }, own, other, giveUp, next],
    peerId: 'p',
    agentId: 'main',
  })
  assert.deepEqual(
    delta?.map((row) => (row as { id: string }).id),
    ['srv-p-codex-t1', 'm-recovery-giveup-dlgcb-proof-1', 'u-next'],
    'GAP_DELTA_NOT_BOUNDED',
  )

  const startedAt = Date.now()
  const launch = projectAntigravityPlatform({
    credential: { accessToken: 'synthetic-agy-token', accessTokenExpiresAt: new Date(startedAt + 20 * 60_000).toISOString() },
    agentId: 'main',
    sessionKey: 'agent:main:webchat:dm:agy-cred-proof',
    gatewayPort: 18789,
    gatewayToken: '',
    delegationDepth: 0,
    hostBin: null,
  })
  try {
    const file = JSON.parse(
      readFileSync(join(launch.launchHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), 'utf8'),
    ) as { token: { refresh_token: string; expiry: string } }
    assert.equal(file.token.refresh_token, '', 'AGY_REFRESH_TOKEN_LEAK')
    assert.ok(
      Date.parse(file.token.expiry) > startedAt + 12 * 60 * 60_000,
      'AGY_TOKEN_FILE_EXPIRES_MID_TURN',
    )
    assert.equal(launch.cliTokenFileExpiry, file.token.expiry, 'AGY_EXPIRY_LOG_MISMATCH')
  } finally {
    cleanupAntigravityLaunch(launch)
  }

  const detail = normalizeAntigravityErrorDetail(
    'agent executor error: generating and executing: request failed: Post "http://127.0.0.1:18789/internal/v5/antigravity-relay/route/<route>/v1internal:streamGenerateContent?alt=sse": oauth2: token expired and refresh token is not set',
  )
  const code = classifyRunError(detail).code
  assert.equal(code, 'platform_credential_expired', 'AGY_CRED_NOT_PLATFORM_ERROR')
  assert.equal(supportsAutomaticTurnRecovery(code), true, 'AGY_CRED_MASTER_RECOVERY_MISSING')
  assert.equal(supportsAutomaticRecoveryWithoutCheckpoint(code), false, 'AGY_CRED_UNPROVEN_REPLAY')
  return RESUME_AGY_CRED_PROOF
}
