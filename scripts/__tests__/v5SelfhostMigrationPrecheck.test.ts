// OCV5-450: PR-time migration precheck uses the train's own rules.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
let repo: string

function git(...args: string[]) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}

function writeMeta(names: string[]) {
  writeFileSync(
    path.join(repo, 'deploy/v5/release-metadata.json'),
    JSON.stringify({ requiredMigrations: names }),
  )
}

function migration(name: string, sql: string) {
  writeFileSync(path.join(repo, `packages/commercial/src/db/migrations/${name}.sql`), sql)
}

function precheck(base: string) {
  const r = spawnSync(
    'bash',
    [path.join(repo, 'scripts/v5-selfhost-migration-precheck.sh'), '--base', base],
    {
      encoding: 'utf8',
    },
  )
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'ocv5-450-'))
  for (const d of ['scripts/lib', 'deploy/v5', 'packages/commercial/src/db/migrations']) {
    mkdirSync(path.join(repo, d), { recursive: true })
  }
  copyFileSync(
    path.join(root, 'scripts/v5-selfhost-migration-precheck.sh'),
    path.join(repo, 'scripts/v5-selfhost-migration-precheck.sh'),
  )
  copyFileSync(
    path.join(root, 'scripts/lib/v5-migration-ddl.sh'),
    path.join(repo, 'scripts/lib/v5-migration-ddl.sh'),
  )
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  writeMeta(['0001_init'])
  migration('0001_init', 'CREATE TABLE a (id int);')
  git('add', '-A')
  git('commit', '-qm', 'base')
  git('tag', 'base')
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('v5-selfhost-migration-precheck.sh', () => {
  test('no migration change: ok', () => {
    const r = precheck('base')
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /no migration changes/)
  })

  test('registered additive migration: ok, no warning', () => {
    migration('0002_add', 'ALTER TABLE a ADD COLUMN b int;')
    writeMeta(['0001_init', '0002_add'])
    git('add', '-A')
    git('commit', '-qm', 'add')
    const r = precheck('base')
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /files=1 unregistered=0 breaking_ddl=0/)
  })

  test('migration missing from requiredMigrations: exit 1 with an error annotation', () => {
    migration('0002_add', 'ALTER TABLE a ADD COLUMN b int;')
    git('add', '-A')
    git('commit', '-qm', 'add')
    const r = precheck('base')
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /::error file=packages\/commercial\/src\/db\/migrations\/0002_add\.sql::/)
  })

  test('breaking DDL is reported as a warning only, never as an override', () => {
    migration('0002_drop', '-- DROP TABLE in a comment is ignored\nALTER TABLE a DROP COLUMN id;')
    writeMeta(['0001_init', '0002_drop'])
    git('add', '-A')
    git('commit', '-qm', 'drop')
    const r = precheck('base')
    assert.equal(r.status, 0, r.out)
    assert.match(
      r.out,
      /::warning file=.*0002_drop\.sql::.*\(DROP COLUMN\).*OC_V5_ALLOW_BREAKING_MIGRATION=1/,
    )
  })

  test('usage errors exit 2', () => {
    assert.equal(precheck('no-such-ref').status, 2)
    const r = spawnSync('bash', [path.join(repo, 'scripts/v5-selfhost-migration-precheck.sh')], {
      encoding: 'utf8',
    })
    assert.equal(r.status, 2)
  })
})

describe('one breaking-DDL detector for train and PR', () => {
  test('the release lib sources the shared detector and defines none of its own', () => {
    const lib = readFileSync(path.join(root, 'scripts/v5-selfhost-master-release-lib.sh'), 'utf8')
    assert.match(lib, /source "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)\/lib\/v5-migration-ddl\.sh"/)
    assert.equal(lib.includes('sql_file_has_breaking_ddl() {'), false)
    const shared = readFileSync(path.join(root, 'scripts/lib/v5-migration-ddl.sh'), 'utf8')
    assert.ok(shared.includes('sql_file_has_breaking_ddl() {'))
  })

  test('the gates workflow runs the precheck against the resolved base', () => {
    const wf = readFileSync(path.join(root, '.github/workflows/v5-selfhost-gates.yml'), 'utf8')
    assert.match(
      wf,
      /bash scripts\/v5-selfhost-migration-precheck\.sh --base "\$\{\{ steps\.base\.outputs\.ref \}\}"/,
    )
  })
})
