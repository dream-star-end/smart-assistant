import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { appendFile, chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'

const exec = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const shared = [
  'packages/storage/src/sessionFileIo.ts',
  'packages/protocol/src/contextBytePressure.ts',
  'packages/gateway/src/engine/contextReference.ts',
]
const entry = 'claude-code-best/src/services/api/requestBodyBudget.ts'

test('isolated CCB budget bundle includes shared inputs and caches by all their bytes', async t => {
  const work = await mkdtemp(join(tmpdir(), 'ccb-shared-inputs-'))
  t.after(() => rm(work, { recursive: true, force: true }))
  const input = join(work, 'input')
  for (const file of [...shared, entry]) {
    await mkdir(dirname(join(input, file)), { recursive: true })
    await copyFile(join(root, file), join(input, file))
  }
  // Exercise the real release isolation/cache layout without npm install or a
  // full CCB build. This stand-in resolves runtime imports with a real bundler.
  const bun = join(work, 'bun.mjs')
  const buildLog = join(work, 'builds.log')
  await writeFile(bun, `#!/usr/bin/env node
import { build } from ${JSON.stringify(import.meta.resolve('esbuild'))}
import { appendFile } from 'node:fs/promises'
const command = process.argv[2]
if (command === '--version') console.log('isolated-fixture-v1')
else if (command === 'run') {
  if (process.env.FAIL_BUILD === '1') throw new Error('cache unexpectedly missed')
  await appendFile(process.env.BUILD_LOG, 'build\\n')
  await build({ entryPoints: ['src/services/api/requestBodyBudget.ts'], bundle: true, platform: 'node', format: 'esm', outfile: 'dist/cli.js' })
} else if (command !== 'install') throw new Error('unexpected command')
`)
  await chmod(bun, 0o700)
  const build = async (staging, previous = '', fail = false) => {
    const { stdout } = await exec('bash', ['-c', 'source "$1"; oc_hotcfg_build_ccb_dist "$2" "$3"', 'fixture', join(root, 'scripts/v5-runtime-release-lib.sh'), staging, previous], {
      env: { ...process.env, OC_BUN_BIN: bun, BUILD_LOG: buildLog, FAIL_BUILD: fail ? '1' : '0' },
    })
    return stdout.trim().split('\t')[1]
  }
  const first = join(work, 'first')
  await cp(input, first, { recursive: true })
  const key = await build(first)
  assert.match(key, /^[a-f0-9]{12}$/)
  const bundle = await readFile(join(first, 'claude-code-best/dist/cli.js'), 'utf8')
  assert.match(bundle, /request_too_large/)
  assert.match(bundle, /Context reference does not match/)
  assert.doesNotMatch(bundle, /@sinclair\/typebox/)
  await writeFile(join(first, 'MANIFEST.json'), JSON.stringify({ ccbDistKey: key }))
  const same = join(work, 'same')
  await cp(input, same, { recursive: true })
  assert.equal(await build(same, first, true), key)
  assert.equal(await readFile(join(same, 'claude-code-best/dist/cli.js'), 'utf8'), bundle)
  for (let i = 0; i < shared.length; i++) {
    const changed = join(work, `changed-${i}`)
    await cp(input, changed, { recursive: true })
    await appendFile(join(changed, shared[i]), '\n// changed shared input\n')
    assert.notEqual(await build(changed, first), key, shared[i])
  }
  assert.equal((await readFile(buildLog, 'utf8')).trim().split('\n').length, 4)
  assert.equal(await readFile(join(first, 'claude-code-best/dist/cli.js'), 'utf8'), bundle, 'prior release is immutable')
})
