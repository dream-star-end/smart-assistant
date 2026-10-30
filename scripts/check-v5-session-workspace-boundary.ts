/** #1238 session workspace boundary reaches every engine prompt. Synthetic only; no live identity/model/PG. */
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = mkdtempSync(join(tmpdir(), 'oc-v5-session-boundary-gate-'))
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test',
  'packages/gateway/src/__tests__/sessionWorkspaceBoundary.test.ts',
  'packages/gateway/src/__tests__/promptToolRecovery.test.ts',
], { cwd: root, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: scratch, TMPDIR: scratch },
  stdio: 'inherit', timeout: 120_000 })
if (result.error || result.signal || result.status !== 0) {
  console.error('[session-workspace-boundary] FAIL')
  process.exit(1)
}
console.log('[session-workspace-boundary] PASS every engine prompt keeps file work inside the current conversation')
