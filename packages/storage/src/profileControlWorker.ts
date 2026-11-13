import { ProfileGenerationPreGoRejected } from './profileControlRejection.js'
/** Bundled into a fixed standalone ESM artifact. Data only; never imports a user's module or configuration. */
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'
import { publishProfileGeneration, recoverSelectedProfileGeneration } from './authorityGeneration.js'
import { parseProfileControlVersion } from './profileControlVersion.js'
import { exactKeys, parseProfileControlRequest, PROFILE_WORKER_MAX_BYTES } from './profileControlWire.js'
async function main() {
  if (process.argv.length !== 3 || !process.argv[2]) throw new Error('Unavailable')
  const hostRoot = process.argv[2]
  const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })
  let inputBytes = 0
  process.stdin.on('data', (b: Buffer) => { inputBytes += b.length; if (inputBytes > PROFILE_WORKER_MAX_BYTES) process.stdin.destroy(new Error('Unavailable')) })
  const iterator = lines[Symbol.asyncIterator]()
  const first = await iterator.next()
  if (first.done) throw new Error('Unavailable')
  const request = parseProfileControlRequest(JSON.parse(first.value))
  if (!request) throw new Error('Unavailable')
  const condition = parseProfileControlVersion(request.token)!
  if (request.kind === 'publish-profile' && createHash('sha256').update(request.text!, 'utf8').digest('hex') !== condition.targetProfileSha256) throw new Error('Unavailable')
  const send = (value: unknown) => new Promise<void>((resolve, reject) => { process.stdout.write(`${JSON.stringify(value)}\n`, e => e ? reject(e) : resolve()) })
  let admitted = false
  const admission = async () => {
    await send({ v: 1, jobId: request.jobId, type: 'ready' })
    const next = await iterator.next()
    if (next.done) throw new Error('Unavailable')
    const reply = JSON.parse(next.value)
    if (!exactKeys(reply, ['v', 'jobId', 'type']) || reply.v !== 1 || reply.jobId !== request.jobId) throw new Error('Unavailable')
    if (reply.type === 'cancel') throw new ProfileGenerationPreGoRejected('UNAVAILABLE')
    if (reply.type !== 'go') throw new Error('Unavailable')
    admitted = true
  }
  try {
    const store = { hostRoot, userId: request.binding.userId }
    const receipt = request.kind === 'publish-profile'
      ? await publishProfileGeneration(store, { binding: request.binding, baseManifestSha256: condition.parentManifestSha256, expectedVersion: condition.baseProfileVersion, text: request.text! }, {}, admission)
      : await recoverSelectedProfileGeneration(store, { binding: request.binding, expectedVersion: request.token }, admission)
    await send({ v: 1, jobId: request.jobId, type: 'result', receipt })
  } catch (error) {
    if (request.kind !== 'publish-profile' || admitted || !(error instanceof ProfileGenerationPreGoRejected)) throw error
    await send({ v: 1, jobId: request.jobId, type: 'rejected', code: error.code })
  } finally { lines.close(); process.stdin.destroy() }
}
main().catch(() => { process.exitCode = 1; process.stdin.destroy() })
