import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ReceiptInputProof, ReceiptRecordObservation } from '@openclaude/storage/receiptDeliveryStore'

const cli = fileURLToPath(new URL('../../../claude-code-best/src/utils/receiptRecoveryOracleCli.ts', import.meta.url))

/** Caller holds the receipt writer barrier. Even timeout/error must await the
 * actual process close: returning while the oracle is alive releases it early. */
export async function observeReceiptNativeRecovery(proof: ReceiptInputProof): Promise<ReceiptRecordObservation> {
  const home = await mkdtemp(join(tmpdir(), 'oc-receipt-oracle-'))
  try {
    const kind = await new Promise<'present' | 'absent' | 'unknown'>(resolve => {
      const child = spawn('bun', [cli], { cwd: home, stdio: ['pipe', 'pipe', 'pipe'], env: {
        PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: home,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      } })
      let output = '', failed = false
      const fail = () => { failed = true; child.kill('SIGKILL') }
      const timer = setTimeout(fail, 60_000)
      child.once('error', fail)
      child.stdin.on('error', fail)
      child.stdout.on('data', b => { output += b.toString(); if (Buffer.byteLength(output) > 256) fail() })
      child.stderr.resume() // diagnostics may contain paths, never forward them as result/authority
      child.once('close', code => {
        clearTimeout(timer)
        if (failed || code !== 0) return resolve('unknown')
        try {
          const result = JSON.parse(output)
          resolve(result && Object.keys(result).join(',') === 'kind' &&
            ['present', 'absent', 'unknown'].includes(result.kind) ? result.kind : 'unknown')
        } catch { resolve('unknown') }
      })
      child.stdin.end(JSON.stringify(proof))
    })
    return kind === 'present' ? { kind, proof } : { kind }
  } finally { await rm(home, { recursive: true, force: true }) }
}
