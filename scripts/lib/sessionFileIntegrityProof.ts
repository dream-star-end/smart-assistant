import { mkdtemp, mkdir, link, readFile, stat, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendSessionFile, replaceSessionFile, readSessionFile, withSessionFile } from '../../packages/storage/src/sessionFileIo.js'

/** Real kernel lock, real hard-link aliases and the release candidate's IO
 * implementation. All data and cleanup belong to this isolated proof. */
export async function proveSessionFileIntegrity(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'g607-transcript-proof-'))
  const scope = { projectsDir: join(root, 'projects'), sessionId: '60700000-0000-4000-8000-000000006070', requireKernelLock: true }
  const file = join(scope.projectsDir, 'a', `${scope.sessionId}.jsonl`), alias = join(scope.projectsDir, 'b', `${scope.sessionId}.jsonl`)
  const must = (ok: unknown, code: string): void => { if (!ok) throw new Error(code) }
  try {
    await mkdir(join(scope.projectsDir, 'b'), { recursive: true, mode: 0o700 })
    const original = Buffer.from(JSON.stringify({ type: 'user', text: 'complete synthetic original' }) + '\n')
    await appendSessionFile(file, original.toString(), scope)
    await link(file, alias)
    const inode = (await stat(file)).ino
    await withSessionFile(alias, scope, false, async () => {
      must(spawnSync('/usr/bin/flock', ['-n', file, '/usr/bin/true']).status === 1, 'TRANSCRIPT_KERNEL_LOCK_NOT_HELD')
    })
    must(spawnSync('/usr/bin/flock', ['-n', file, '/usr/bin/true']).status === 0, 'TRANSCRIPT_KERNEL_LOCK_LEAKED')
    const rows = Array.from({ length: 12 }, (_, ordinal) => JSON.stringify({ ordinal, image: 'synthetic-base64-'.repeat(8192), signature: `opaque-${ordinal}` }) + '\n')
    await Promise.all(rows.map((row, ordinal) => appendSessionFile(ordinal % 2 ? file : alias, row, scope)))
    const expected = Buffer.concat([original, Buffer.from(rows.join(''))])
    must((await readSessionFile(file, scope)).equals(expected), 'TRANSCRIPT_ADMISSION_CONTEXT_MISMATCH')
    const recovered = Buffer.concat([expected, Buffer.from(JSON.stringify({ type: 'custom-title', text: 'synthetic metadata' }) + '\n')])
    await replaceSessionFile(alias, recovered, scope)
    await appendSessionFile(file, JSON.stringify({ type: 'user', text: 'continue on original cwd' }) + '\n', scope)
    const a = await readFile(file), b = await readSessionFile(alias, scope)
    must(a.equals(b) && a.subarray(0, recovered.length).equals(recovered), 'TRANSCRIPT_ALIAS_CONTEXT_MISMATCH')
    must((await stat(file)).ino === inode && (await stat(alias)).ino === inode, 'TRANSCRIPT_ALIAS_INODE_CHANGED')
    must(a.toString().trim().split('\n').map(line => JSON.parse(line)).length === 15, 'TRANSCRIPT_COMPLETE_RECORD_COUNT')
    return '[ocv5-607-native-transcript-integrity] PASS — concurrent complete records, opaque signatures and later context survive both cwd hard links under the actual kernel lock'
  } finally { await rm(root, { recursive: true, force: true }) }
}
