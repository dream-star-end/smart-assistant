/** Browser proof + immutable execution + preference business gates. No product login/model/PG. */
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = mkdtempSync(join(tmpdir(), 'oc-v5-system-executor-proof-'))
// Complete cold/load-bound runs have taken >100s; retain a finite budget without retrying or omitting tests.
const timeoutMs = 180_000
const startedAt = performance.now()
const proof = spawnSync(process.execPath, ['--import', 'tsx', '--test',
  'packages/storage/src/systemActions.test.ts',
  'packages/storage/src/__tests__/controlRecoveryRecord.test.ts',
  'packages/storage/src/__tests__/profileControlBroker.test.ts',
  'packages/storage/src/__tests__/authorityGeneration.test.ts',
  'packages/storage/src/__tests__/authorityStateReader.test.ts',
  'packages/storage/src/__tests__/authorityGenerationLock.test.ts',
  'packages/storage/src/__tests__/userProfileAt.test.ts',
  'packages/commercial/src/__tests__/browserConfirmation.test.ts',
  'packages/commercial/src/__tests__/systemOperationService.test.ts',
  'packages/commercial/src/__tests__/preferenceOperations.test.ts',
  'packages/commercial/src/__tests__/preferencesOperationValidation.test.ts',
  'packages/commercial/src/__tests__/systemActionsBrowserHttp.test.ts',
  'packages/commercial/src/__tests__/systemActionPrivateState.test.ts',
  'packages/commercial/src/__tests__/systemActionsRuntime.test.ts',
  'packages/commercial/src/__tests__/systemHelpGrant.test.ts',
  'packages/commercial/src/__tests__/systemHelpHttp.test.ts',
  'packages/commercial/src/__tests__/systemActionHttpLifetime.test.ts',
  'packages/commercial/src/__tests__/systemActionsAssembly.test.ts',
  'packages/commercial/src/__tests__/systemReadOperations.test.ts',
  'packages/commercial/src/__tests__/systemStateReadOperations.test.ts',
  'packages/commercial/src/__tests__/systemModelReadOperations.test.ts',
  'packages/commercial/src/__tests__/systemRuntimeStatusRead.test.ts',
  'packages/commercial/src/__tests__/systemNotificationOperations.test.ts',
  'packages/commercial/src/__tests__/systemSessionMetadataOperations.test.ts',
  'packages/commercial/src/__tests__/sessionMetadataHttp.test.ts',
  'packages/commercial/src/__tests__/systemActionPgReceipts.test.ts',
  'packages/gateway/src/__tests__/systemHelpRelay.test.ts',
  'packages/gateway/src/__tests__/systemHelpFrames.test.ts',
  'packages/gateway/src/__tests__/systemHelpCli.test.ts',
  'packages/gateway/src/__tests__/systemHelpTurnLifecycle.test.ts',
], { cwd: root, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: scratch, TMPDIR: scratch },
  stdio: 'inherit', timeout: timeoutMs })
if (proof.error || proof.signal || proof.status !== 0) {
  console.error('[system-executor-proofs] FAIL', JSON.stringify({
    error: proof.error?.message ?? null, code: (proof.error as NodeJS.ErrnoException | undefined)?.code ?? null,
    signal: proof.signal, status: proof.status, timeoutMs, elapsedMs: Math.round(performance.now() - startedAt),
  }))
  process.exit(1)
}
console.log('[system-executor-proofs] PASS independent browser approval, original request replay and frozen executors')
