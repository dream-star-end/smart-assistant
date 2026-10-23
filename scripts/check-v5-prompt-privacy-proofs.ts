/** Fresh consent and warm-process fail-closed proof. Synthetic loopback only; no live identity/model/PG. */
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = mkdtempSync(join(tmpdir(), 'oc-v5-prompt-privacy-gate-'))
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test',
  'packages/gateway/src/__tests__/promptPrivacyRuntime.test.ts',
  'packages/gateway/src/__tests__/promptPrivacy.test.ts',
  'packages/gateway/src/__tests__/sessionManagerPromptPrivacy.test.ts',
], { cwd: root, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: scratch, TMPDIR: scratch },
  stdio: 'inherit', timeout: 120_000 })
if (result.error || result.signal || result.status !== 0) {
  console.error('[prompt-privacy-proofs] FAIL')
  process.exit(1)
}
console.log('[prompt-privacy-proofs] PASS fresh consent, operation lifetime and stopped-process boundary')
