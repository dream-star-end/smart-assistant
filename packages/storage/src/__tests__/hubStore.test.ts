/**
 * Regression tests for HubStore safe async extraction & flattening (no shell execSync).
 *
 * Run: npx tsx --test packages/storage/src/__tests__/hubStore.test.ts
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

const home = await mkdtemp(join(tmpdir(), 'oc-hubstore-test-'))
process.env.OPENCLAUDE_HOME = home

const { HubStore } = await import('../hubStore.js')

function hasPython3AndUnzip(): boolean {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' })
    execFileSync('unzip', ['-v'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

after(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('HubStore.install safe async zip extraction & flatten', () => {
  it(
    'extracts nested skill zip with shell-metacharacter filename without executing shell commands',
    { skip: !hasPython3AndUnzip() && 'python3 or unzip not available' },
    async () => {
      const workDir = await mkdtemp(join(tmpdir(), 'oc-hubstore-zip-'))
      const markerName = `pwned-${Date.now()}`
      const pwnedCwd = join(process.cwd(), markerName)
      const zipPath = join(workDir, 'skill.zip')
      const origFetch = globalThis.fetch

      try {
        // Build a zip containing a single nested folder and a file whose name contains
        // shell command substitution syntax to prove no shell interpolation occurs.
        const nestedName = 'demo-skill-pkg'
        const srcRoot = join(workDir, 'src', nestedName)
        await mkdir(srcRoot, { recursive: true })
        await writeFile(
          join(srcRoot, 'SKILL.md'),
          '---\nname: Demo Skill\ndescription: Safe zip test\nversion: 1.2.3\n---\n# Body\n',
        )
        const trickyFile = `note-$(touch ${markerName}).txt`
        await writeFile(join(srcRoot, trickyFile), 'safe content')

        execFileSync('python3', [
          '-c',
          `import os, sys, zipfile
src_base, zip_out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(zip_out, 'w', zipfile.ZIP_DEFLATED) as zf:
    for root, _, files in os.walk(src_base):
        for f in files:
            full = os.path.join(root, f)
            zf.write(full, os.path.relpath(full, src_base))`,
          join(workDir, 'src'),
          zipPath,
        ])
        const zipBuf = await readFile(zipPath)

        globalThis.fetch = (async () =>
          new Response(new Uint8Array(zipBuf), {
            status: 200,
            headers: { 'Content-Type': 'application/zip' },
          })) as typeof fetch

        const store = new HubStore()
        const res = await store.install('demo-skill', '1.2.3', true)
        assert.equal(res.ok, true, res.error)
        assert.ok(res.path)
        assert.equal(existsSync(pwnedCwd), false, 'shell metacharacter must NEVER be evaluated')
        assert.equal(
          existsSync(join(res.path!, markerName)),
          false,
          'shell metacharacter must NEVER be evaluated',
        )
        assert.equal(existsSync(join(res.path!, 'SKILL.md')), true)
        assert.equal(existsSync(join(res.path!, trickyFile)), true)

        const view = await store.view('demo-skill')
        assert.equal(view?.meta.name, 'Demo Skill')
        assert.equal(view?.meta.version, '1.2.3')
      } finally {
        globalThis.fetch = origFetch
        await rm(pwnedCwd, { force: true })
        await rm(workDir, { recursive: true, force: true })
      }
    },
  )
})
