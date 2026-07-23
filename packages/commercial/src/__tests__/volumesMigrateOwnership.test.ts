import assert from 'node:assert/strict'
import {
  chownSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { normalizeMigratedSkillOwnership } from '../channelMigration/volumesMigrate.js'

const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0

describe(
  'V3→V5 migrated shared-skill ownership',
  { skip: !IS_ROOT ? 'requires root to verify uid/gid repair' : false },
  () => {
    test('normalizes only the skills tree and never follows an internal symlink', async () => {
      const dataMount = mkdtempSync(join(tmpdir(), 'oc-v5-skill-owner-'))
      const skills = join(dataMount, 'skills')
      const nested = join(skills, 'demo', 'notes')
      const outside = join(dataMount, 'outside.txt')
      mkdirSync(nested, { recursive: true })
      writeFileSync(join(skills, 'demo', 'SKILL.md'), '# demo\n')
      writeFileSync(join(nested, 'x.txt'), 'x\n')
      writeFileSync(outside, 'outside\n')
      symlinkSync(outside, join(skills, 'demo', 'outside-link'))
      chownSync(dataMount, 0, 0)
      chownSync(skills, 0, 0)
      chownSync(join(skills, 'demo'), 0, 0)
      chownSync(nested, 0, 0)
      chownSync(outside, 0, 0)

      try {
        await normalizeMigratedSkillOwnership(dataMount, 1234, 1235)
        for (const path of [
          skills,
          join(skills, 'demo'),
          join(skills, 'demo', 'SKILL.md'),
          nested,
          join(nested, 'x.txt'),
        ]) {
          const st = lstatSync(path)
          assert.equal(st.uid, 1234, path)
          assert.equal(st.gid, 1235, path)
        }
        assert.equal(lstatSync(join(skills, 'demo', 'outside-link')).uid, 1234)
        assert.equal(statSync(outside).uid, 0, 'symlink target outside skills must be untouched')
      } finally {
        rmSync(dataMount, { recursive: true, force: true })
      }
    })

    test('rejects a symlinked skills root', async () => {
      const dataMount = mkdtempSync(join(tmpdir(), 'oc-v5-skill-root-link-'))
      const outside = mkdtempSync(join(tmpdir(), 'oc-v5-skill-outside-'))
      symlinkSync(outside, join(dataMount, 'skills'))
      try {
        await assert.rejects(
          () => normalizeMigratedSkillOwnership(dataMount),
          /shared skills root is not a real directory/,
        )
      } finally {
        rmSync(dataMount, { recursive: true, force: true })
        rmSync(outside, { recursive: true, force: true })
      }
    })
  },
)
