import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const bundle = join(root, 'packages/commercial/agent-sandbox/platform-runtime')
const loader = join(bundle, 'bin/oc-system.py')
const guides = join(bundle, 'prompts/system-assistant')
function run(args: string[], entry = loader) {
  return spawnSync('python3', [entry, ...args], { encoding: 'utf8', cwd: '/', timeout: 5_000,
    env: { ...process.env, OPENCLAUDE_V3_MASTER_BASE_URL: 'http://127.0.0.1:1',
      OPENCLAUDE_V3_CONTAINER_TOKEN: 'must-not-appear-in-help' } })
}

describe('oc-system trusted static help', () => {
  test('help aliases work independently of cwd, user state or a reachable master', () => {
    for (const args of [[], ['help'], ['-h'], ['--help']]) {
      const r = run(args)
      assert.equal(r.status, 0, r.stderr)
      assert.match(r.stdout, /usage: oc-system/)
      assert.doesNotMatch(r.stdout + r.stderr, /must-not-appear-in-help/)
    }
  })
  test('every advertised topic loads its exact source, with no omitted UI protocol', () => {
    const index = run(['skill'])
    assert.equal(index.status, 0, index.stderr)
    assert.equal(index.stdout, readFileSync(join(guides, 'SKILL.md'), 'utf8'))
    for (const file of readdirSync(join(guides, 'references'))) {
      const topic = file.replace(/\.md$/, '')
      const r = run(['skill', topic])
      assert.equal(r.status, 0, `${topic}: ${r.stderr}`)
      assert.equal(r.stdout, readFileSync(join(guides, 'references', file), 'utf8'))
    }
  })
  test('unknown topics, traversal, absolute paths, writes and excess args cannot read or execute', () => {
    for (const args of [['skill', '../SKILL'], ['skill', '/etc/passwd'], ['skill', 'does-not-exist'],
      ['skill', 'preferences', 'extra'], ['prepare', 'theme'], ['execute', 'anything']]) {
      const r = run(args)
      assert.notEqual(r.status, 0, args.join(' '))
      assert.equal(r.stdout, '')
      assert.doesNotMatch(r.stderr, /root:x:|must-not-appear-in-help/)
    }
  })
  test('installed bare filename and hot symlink resolve one pinned bundle revision', () => {
    // Keep this task-owned proof directory: no remote cleanup/deletion is authorized.
    const proof = mkdtempSync(join(tmpdir(), 'oc-system-proof-'))
    const pinned = join(proof, 'revision')
    mkdirSync(join(pinned, 'bin'), { recursive: true })
    mkdirSync(join(pinned, 'prompts/system-assistant/references'), { recursive: true })
    copyFileSync(loader, join(pinned, 'bin/oc-system'))
    chmodSync(join(pinned, 'bin/oc-system'), 0o755)
    writeFileSync(join(pinned, 'prompts/system-assistant/SKILL.md'), '# pinned revision\n')
    writeFileSync(join(pinned, 'prompts/system-assistant/references/preferences.md'), '# pinned preferences\n')
    symlinkSync(pinned, join(proof, 'current'), 'dir')
    assert.equal(execFileSync(join(proof, 'current/bin/oc-system'), ['skill'], { encoding: 'utf8', cwd: '/' }), '# pinned revision\n')
    writeFileSync(join(proof, 'outside.md'), 'must-not-load-external-reference')
    symlinkSync(join(proof, 'outside.md'), join(pinned, 'prompts/system-assistant/references/models.md'))
    const r = run(['skill', 'models'], join(proof, 'current/bin/oc-system'))
    assert.notEqual(r.status, 0)
    assert.doesNotMatch(r.stdout + r.stderr, /must-not-load-external-reference/)
  })
})
