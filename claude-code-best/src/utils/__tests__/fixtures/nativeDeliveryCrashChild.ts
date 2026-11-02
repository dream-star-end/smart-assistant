/** Plain Bun child: flock --no-fork makes this actual Writer own its UUID lock. */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const [root, point, mode, control] = process.argv.slice(2)
if (!root || !point || !mode || !control) throw Error('fixture arguments')
const pinned = JSON.parse(readFileSync(join(root, 'delivery.json'), 'utf8'))
const project = join(root, 'projects', 'fixture')
const file = join(project, `${pinned.nativeSessionId}.jsonl`)
mkdirSync(project, { recursive: true, mode: 0o700 })
if (!existsSync(file)) writeFileSync(file, '', { mode: 0o600 })
process.env.CLAUDE_CONFIG_DIR = root
process.env.OPENCLAUDE_TRANSCRIPT_INTEGRITY = '1'
process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
// Load the real Node control process while CCB imports. It waits on stdin;
// no commit request exists until the Writer produces its lock-held proof.
const controlChild = spawn('node', ['--import', 'tsx', control, 'commit', root], {
  cwd: dirname(control),
  stdio: ['pipe', 'pipe', 'pipe'],
})
const controlClosed = once(controlChild, 'close')
void controlClosed.catch(() => {})
let controlOutput = ''
let controlError = ''
controlChild.stdout.on('data', (bytes) => {
  controlOutput = (controlOutput + bytes.toString()).slice(-1048576)
})
controlChild.stderr.on('data', (bytes) => {
  controlError = (controlError + bytes.toString()).slice(-8192)
})
process.on('exit', () => {
  if (controlChild.exitCode === null && controlChild.signalCode === null)
    controlChild.kill('SIGKILL')
})

writeFileSync(join(root, 'stage'), 'import-state')
const { switchSession } = await import('../../../bootstrap/state.js')
writeFileSync(join(root, 'stage'), 'import-storage')
const storage = await import('../../sessionStorage.js')
writeFileSync(join(root, 'stage'), 'initialize-writer')
switchSession(pinned.nativeSessionId, project)
storage.resetProjectForTesting()
storage.clearSessionMessagesCache()
storage.setSessionFileForTesting(file)
if (mode === 'crash') {
  writeFileSync(join(root, 'stage'), 'record-initial')
  await storage.recordTranscript(pinned.initial, undefined, undefined, undefined, true)
  await storage.flushSessionStorage()
}
async function barrier() {
  writeFileSync(join(root, 'stage'), 'barrier')
  process.stdout.write('BARRIER\n')
  await new Promise(() => {
    setInterval(() => {}, 1000)
  })
}
writeFileSync(join(root, 'stage'), 'deliver')
const commit = await storage.deliverNativeTranscript({
  nativeSessionId: pinned.nativeSessionId,
  operationId: pinned.operationId,
  payloadHash: pinned.payloadHash,
  preparation: pinned.preparation,
  nativeWriterLockPath: process.env.NATIVE_ARTIFACT_TEST_LOCK_PATH!,
  artifacts: [],
  resolveMessage: async (projection) => {
    writeFileSync(join(root, 'stage'), `resolve:${projection.uuid}`)
    if (mode === 'crash' && point === 'partial' && projection.uuid === pinned.messages[1].uuid)
      await barrier()
    appendFileSync(
      join(root, 'resolved.jsonl'),
      `${JSON.stringify({ mode, uuid: projection.uuid })}\n`,
    )
    return pinned.messages.find((message: { uuid: string }) => message.uuid === projection.uuid)
  },
  openArtifactSource: async function* () {
    yield Buffer.alloc(0)
    throw Error('no artifacts')
  },
  commitProof: async (proof) => {
    writeFileSync(join(root, 'stage'), 'commit-proof')
    if (mode === 'crash' && point === 'before-commit') await barrier()
    controlChild.stdin.end(JSON.stringify(proof))
    const [code, signal] = await controlClosed
    if (code !== 0) throw Error(`control fixture exit ${code}/${signal}: ${controlError}`)
    writeFileSync(join(root, 'stage'), 'commit-response')
    const row = JSON.parse(controlOutput)
    if (mode === 'crash' && point === 'after-commit') await barrier()
    return row.deliveryCommit
  },
})
writeFileSync(join(root, 'stage'), 'flush')
await storage.flushSessionStorage()
writeFileSync(join(root, 'recovered-commit.json'), JSON.stringify(commit), { mode: 0o600 })

writeFileSync(join(root, 'stage'), 'cleanup')
const { runCleanupFunctions } = await import('../../cleanupRegistry.js')
await runCleanupFunctions()
await storage.flushSessionStorage()
writeFileSync(join(root, 'stage'), 'done')
