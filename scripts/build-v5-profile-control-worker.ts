/** Inert standalone artifact for the fixed host data worker; not part of production activation yet. */
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
export async function buildProfileControlWorker(runtimeRoot: string) {
  const out = join(runtimeRoot, 'packages/storage/dist/profile-control-worker.mjs')
  const built = await build({ entryPoints: [join(runtimeRoot, 'packages/storage/src/profileControlWorker.ts')],
    bundle: true, write: false, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent' })
  if (built.outputFiles.length !== 1) throw new Error('Worker build failed')
  const bytes = built.outputFiles[0]!.contents
  await mkdir(dirname(out), { recursive: true, mode: 0o755 })
  await writeFile(out, bytes, { mode: 0o644 })
  return { file: out, sha256: createHash('sha256').update(bytes).digest('hex') }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildProfileControlWorker(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
}
