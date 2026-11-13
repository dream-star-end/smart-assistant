/** Twenty-two real private-PG receipt and exact inbox approval proofs. Never pass through a product credential environment. */
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const scratch = mkdtempSync(join(tmpdir(), 'oc-system-pg-receipt-proof-'))
const proof = spawnSync(process.execPath, ['--import', 'tsx', '--import', './scripts/lib/test-blocking-stdio.mjs',
  '--test', '--test-force-exit', '--test-concurrency=1', '--test-timeout=180000', '--test-reporter=tap',
  'packages/commercial/src/__tests__/systemActionPgReceipts.integ.test.ts',
  'packages/commercial/src/__tests__/systemNotificationOperations.integ.test.ts',
  'packages/commercial/src/__tests__/systemSessionMetadataOperations.integ.test.ts'], {
  env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: scratch, TMPDIR: scratch, CI: 'true', REQUIRE_TEST_DB: '1',
    ...(process.env.TEST_DATABASE_URL ? { TEST_DATABASE_URL: process.env.TEST_DATABASE_URL } : {}) },
  encoding: 'utf8', timeout: 190_000, maxBuffer: 16 * 1024 * 1024,
})
process.stdout.write(proof.stdout ?? '')
process.stderr.write(proof.stderr ?? '')
const output = proof.stdout ?? ''
const count = (name: string): number => Number([...output.matchAll(new RegExp(`^# ${name}\\s+(\\d+)\\s*$`, 'gm'))].at(-1)?.[1] ?? -1)
if (proof.error || proof.signal || proof.status !== 0 || !/^1\.\.22\s*$/m.test(output)
  || count('tests') !== 22 || count('pass') !== 22 || ['fail', 'cancelled', 'skipped', 'todo'].some(name => count(name) !== 0)) {
  console.error('[system-pg-receipt-proofs] FAIL: complete twenty-two-test plan and zero failures/cancellations/skips/todos required')
  process.exit(1)
}
console.log('[system-pg-receipt-proofs] PASS real atomic effect, lost COMMIT reply and exact positive reconciliation')
