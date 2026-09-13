/** Internal stdin-only oracle. The gateway owns the receipt flock until close.
 * No tools, model request, transcript output, or alternate recovery algorithm. */
import { observeStrictReceiptInput } from './sessionStorage.js'
import type { NativeReceiptProof } from './nativeReceiptTranscript.js'

let kind: 'present' | 'absent' | 'unknown' = 'unknown'
try {
  let input = ''
  for await (const chunk of process.stdin) {
    input += chunk.toString()
    if (Buffer.byteLength(input) > 4096) throw new Error('oversized oracle input')
  }
  const p = JSON.parse(input) as NativeReceiptProof
  if (!p || typeof p.nativeSessionId !== 'string' || !p.nativeSessionId || p.nativeSessionId.length > 256 ||
      typeof p.recordLocator !== 'string' || p.recordLocator.length > 2048 ||
      typeof p.recordHash !== 'string' || !/^[a-f0-9]{64}$/.test(p.recordHash)) throw new Error('invalid oracle proof')
  kind = (await observeStrictReceiptInput(p)).kind
} catch { /* Read/import/runtime failures never imply absent. */ }
process.stdout.write(JSON.stringify({ kind }) + '\n', () => process.exit(0))
