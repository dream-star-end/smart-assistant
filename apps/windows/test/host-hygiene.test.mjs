import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const here = path.dirname(fileURLToPath(import.meta.url))
const srcRoot = path.resolve(here, '../src')

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.name.endsWith('.mjs') || entry.name.endsWith('.cjs')) out.push(full)
  }
  return out
}

test('src/host and src/tunnel have zero rejectUnauthorized:false and no empty checkServerIdentity', () => {
  const files = [
    ...walk(path.join(srcRoot, 'host')),
    ...walk(path.join(srcRoot, 'tunnel')),
    path.join(srcRoot, 'hostSupervisor.mjs'),
  ].filter((f) => fs.existsSync(f))
  assert.ok(files.length >= 8)
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8')
    assert.equal(
      /rejectUnauthorized\s*:\s*false/.test(src),
      false,
      `${file} sets rejectUnauthorized:false`,
    )
    assert.equal(
      /checkServerIdentity\s*:\s*(undefined|null)/.test(src),
      false,
      `${file} has empty checkServerIdentity`,
    )
  }
})
