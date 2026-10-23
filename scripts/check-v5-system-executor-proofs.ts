/** Browser proof + immutable execution + preference business gates. No product login/model/PG. */
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = mkdtempSync(join(tmpdir(), 'oc-v5-system-executor-proof-'))
const proof = spawnSync(process.execPath, ['--import', 'tsx', '--test',
  'packages/storage/src/systemActions.test.ts',
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
], { cwd: root, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: scratch, TMPDIR: scratch },
  stdio: 'inherit', timeout: 120_000 })
if (proof.error || proof.signal || proof.status !== 0) {
  console.error('[system-executor-proofs] FAIL')
  process.exit(1)
}
console.log('[system-executor-proofs] PASS independent browser approval, original request replay and frozen executors')
