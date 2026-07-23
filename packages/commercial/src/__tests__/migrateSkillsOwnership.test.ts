import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const TSX = join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs')
const SCRIPT = join(REPO_ROOT, 'packages/commercial/scripts/migrate-skills-to-shared.ts')

describe(
  'migrate-skills-to-shared ownership',
  { skip: !IS_ROOT ? 'requires root to emulate the production migration' : false },
  () => {
    test('root-run migration publishes the shared root, copied tree, and ledger as volume owner', () => {
      const home = mkdtempSync(join(tmpdir(), 'oc-shared-skill-migration-'))
      const source = join(home, 'agents', 'office-assistant', 'skills', 'demo')
      mkdirSync(source, { recursive: true })
      writeFileSync(
        join(source, 'SKILL.md'),
        '---\nname: demo\ndescription: demo skill\nversion: 1.0.0\n---\n\n# Demo\n',
      )
      chownSync(home, 1234, 1235)

      try {
        execFileSync(process.execPath, [TSX, SCRIPT, '--home', home, '--apply'], {
          cwd: REPO_ROOT,
          encoding: 'utf8',
        })
        for (const path of [
          join(home, 'skills'),
          join(home, 'skills', 'demo'),
          join(home, 'skills', 'demo', 'SKILL.md'),
          join(home, 'skills', '.skill-migration-ledger.json'),
        ]) {
          const st = lstatSync(path)
          assert.equal(st.uid, 1234, path)
          assert.equal(st.gid, 1235, path)
        }
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })

    test('rejects a symlinked shared root without writing or chowning its target', () => {
      const home = mkdtempSync(join(tmpdir(), 'oc-shared-skill-link-home-'))
      const outside = mkdtempSync(join(tmpdir(), 'oc-shared-skill-link-outside-'))
      const source = join(home, 'agents', 'office-assistant', 'skills', 'demo')
      mkdirSync(source, { recursive: true })
      writeFileSync(
        join(source, 'SKILL.md'),
        '---\nname: demo\ndescription: demo skill\nversion: 1.0.0\n---\n\n# Demo\n',
      )
      chownSync(home, 1234, 1235)
      chownSync(outside, 0, 0)
      symlinkSync(outside, join(home, 'skills'))

      try {
        assert.throws(
          () =>
            execFileSync(process.execPath, [TSX, SCRIPT, '--home', home, '--apply'], {
              cwd: REPO_ROOT,
              encoding: 'utf8',
              stdio: 'pipe',
            }),
          /Command failed/,
        )
        assert.equal(existsSync(join(outside, 'demo')), false)
        assert.equal(existsSync(join(outside, '.skill-migration-ledger.json')), false)
        assert.equal(lstatSync(outside).uid, 0, 'outside target ownership must remain unchanged')
      } finally {
        rmSync(home, { recursive: true, force: true })
        rmSync(outside, { recursive: true, force: true })
      }
    })
  },
)
