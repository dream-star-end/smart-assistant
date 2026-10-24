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

  test('a base with no merge base fails closed (exit 2), never "no changes"', () => {
    migration('0002_add', 'ALTER TABLE a ADD COLUMN b int;')
    git('add', '-A')
    git('commit', '-qm', 'unregistered')
    git('checkout', '-q', '--orphan', 'other')
    git('commit', '-qm', 'unrelated root', '--allow-empty')
    const orphan = git('rev-parse', 'HEAD')
    git('checkout', '-q', 'main')
    const r = precheck(orphan)
    assert.equal(r.status, 2, r.out)
    assert.doesNotMatch(r.out, /no migration changes/)
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

describe('TRUNCATE command versus a table privilege (OCV5-610)', () => {
  function detect(sql: string) {
    const file = path.join(repo, 'acl-fixture.sql')
    writeFileSync(file, sql)
    return spawnSync('bash', ['-c', 'source "$1"; sql_file_has_breaking_ddl "$2"', '_',
      path.join(root, 'scripts/lib/v5-migration-ddl.sh'), file], { encoding: 'utf8' })
  }
  for (const sql of [
    'REVOKE UPDATE, DELETE, TRUNCATE ON system_action_receipts FROM CURRENT_USER;',
    'grant select, truncate on table public.receipts to app;',
    'REVOKE GRANT OPTION FOR TRUNCATE ON receipts FROM app CASCADE;',
    'REVOKE UPDATE, /* an ACL privilege */\n TRUNCATE ON receipts FROM app;',
    'GRANT SELECT ON receipts TO app; REVOKE TRUNCATE ON receipts FROM app;',
  ]) test(`ACL privilege is not destructive: ${sql}`, () => {
    const result = detect(sql)
    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert.equal(result.stdout, '')
  })
  for (const sql of [
    'TRUNCATE receipts;', 'truncate table public.receipts restart identity cascade;',
    'TRUNCATE receipts, other;',
    'REVOKE TRUNCATE ON receipts FROM app; TRUNCATE receipts;',
    'TRUNCATE receipts; GRANT TRUNCATE ON receipts TO app;',
    'GRANT SELECT ON receipts TO app; TRUNCATE receipts; REVOKE TRUNCATE ON receipts FROM app;',
    'DO $$ BEGIN TRUNCATE receipts; END $$;',
    "DO $$ BEGIN EXECUTE 'TRUNCATE receipts'; END $$;",
    'REVOKE TRUNCATE ON receipts;',
    'REVOKE UNKNOWN, TRUNCATE ON receipts FROM app;',
  ]) test(`actual or unrecognized TRUNCATE stays blocked: ${sql}`, () => {
    const result = detect(sql)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.equal(result.stdout.trim(), 'TRUNCATE')
  })
  for (const sql of ['DROP TABLE receipts;', 'ALTER TABLE receipts DROP COLUMN id;',
    'ALTER TABLE receipts DROP CONSTRAINT c;', 'ALTER TABLE receipts RENAME TO old;']) {
    test(`other breaking DDL remains blocked: ${sql}`, () => assert.equal(detect(sql).status, 0))
  }
  test('the exact already-applied receipt migration has no breaking DDL', () => {
    const sql = readFileSync(path.join(root, 'packages/commercial/src/db/migrations/0327_system_action_receipts.sql'), 'utf8')
    assert.equal(detect(sql).status, 1)
  })
  test('registered ACL migration passes the actual PR precheck with no breaking warning', () => {
    migration('0002_receipt_acl', 'REVOKE UPDATE, DELETE, TRUNCATE ON receipts FROM CURRENT_USER;')
    writeMeta(['0001_init', '0002_receipt_acl'])
    git('add', '-A'); git('commit', '-qm', 'table ACL')
    const result = precheck('base')
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /files=1 unregistered=0 breaking_ddl=0/)
    assert.doesNotMatch(result.out, /::warning/)
  })
})
