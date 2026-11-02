import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { mock } from 'node:test'
const [root, mode] = process.argv.slice(2)
const sid = '00000000-0000-4000-8000-000000000005'
const projects = join(root!, 'projects')
const session = join(projects, 'project', sid)
const relativePath = 'tool-results/call_crash.txt'
const target = join(session, relativePath)
const hold = async (marker: string) => {
  process.stdout.write(`${marker}\n`)
  const timer = setInterval(() => {}, 1000)
  await new Promise<void>(() => {})
  clearInterval(timer)
}
if (mode === 'link') {
  const actualLink = fs.link
  mock.method(fs, 'link', async (...args: Parameters<typeof fs.link>) => {
    await actualLink(...args)
    if (args[1] === target) await hold('artifact-linked')
  })
  syncBuiltinESMExports()
}
const { installNativeArtifacts } = await import('../../nativeArtifactInstaller.js')
const { withSessionFile } = await import('../../sessionFileIo.js')
await withSessionFile(
  join(projects, 'project', `${sid}.jsonl`),
  { projectsDir: projects, sessionId: sid },
  true,
  async (file, patch) => {
    await patch((await file.stat()).size, Buffer.from('one-reference\n'), async (capability) => {
      await installNativeArtifacts(capability, {
        sessionDirectory: session,
        nativeSessionId: sid,
        nativeWriterLockPath: join(root!, `${sid}.lock`),
        operationId: 'crash-op',
        artifacts: [
          {
            nativeSessionId: sid,
            relativePath,
            sizeBytes: 5,
            sha256: createHash('sha256').update('bytes').digest('hex'),
          },
        ],
        openSource: async function* () {
          if (mode === 'recover') throw new Error('recovery-must-use-installed-bytes')
          yield Buffer.from('bytes')
        },
      })
      if (mode === 'installed') await hold('artifacts-installed')
    })
  },
)
process.stdout.write('writer-committed\n')
