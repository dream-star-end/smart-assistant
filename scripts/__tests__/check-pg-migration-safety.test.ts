import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  BOSS_APPROVAL_ENV,
  checkPgMigrationSql,
  formatPgViolation,
  runPgMigrationSafetyCheck,
} from '../check-pg-migration-safety.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SCRIPT = path.join(ROOT, 'scripts/check-pg-migration-safety.ts')

function initTempGitRepo(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'pg-safety-git-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const git = (args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    }).trim()
  git(['init', '-q'])
  git(['config', 'user.name', 'test'])
  git(['config', 'user.email', 'test@example.com'])
  writeFileSync(path.join(dir, 'README.md'), 'init\n')
  git(['add', 'README.md'])
  git(['commit', '-q', '-m', 'init'])
  return dir
}

describe('check-pg-migration-safety: 7 dangerous DDL classes (red)', () => {
  test('1. PG-BAN-DROP-TABLE blocks DROP TABLE including deeply nested DO/BEGIN/IF/LOOP blocks', () => {
    const v1 = checkPgMigrationSql('DROP TABLE users;', '0999_drop.sql')
    assert.deepEqual(
      v1.map((v) => v.rule),
      ['PG-BAN-DROP-TABLE'],
    )

    const v2 = checkPgMigrationSql('DROP TABLE IF EXISTS public.orders CASCADE;', '0999_drop.sql')
    assert.deepEqual(
      v2.map((v) => v.rule),
      ['PG-BAN-DROP-TABLE'],
    )

    const v3 = checkPgMigrationSql(
      `DO $$
      BEGIN
        IF TRUE THEN
          FOR i IN 1..1 LOOP
            DROP TABLE legacy_sessions;
          END LOOP;
        END IF;
      END $$;`,
      '0999_do_drop.sql',
    )
    assert.deepEqual(
      v3.map((v) => v.rule),
      ['PG-BAN-DROP-TABLE'],
    )
  })

  test('2. PG-BAN-DROP-COLUMN blocks ALTER TABLE ... DROP COLUMN and shorthand DROP col', () => {
    const v1 = checkPgMigrationSql('ALTER TABLE users DROP COLUMN legacy_pin;', '0999_col.sql')
    assert.deepEqual(
      v1.map((v) => v.rule),
      ['PG-BAN-DROP-COLUMN'],
    )

    const v2 = checkPgMigrationSql('ALTER TABLE users DROP IF EXISTS legacy_pin;', '0999_col.sql')
    assert.deepEqual(
      v2.map((v) => v.rule),
      ['PG-BAN-DROP-COLUMN'],
    )
  })

  test('3. PG-BAN-RENAME blocks RENAME TABLE and RENAME COLUMN', () => {
    const v1 = checkPgMigrationSql('ALTER TABLE users RENAME TO accounts;', '0999_ren.sql')
    assert.deepEqual(
      v1.map((v) => v.rule),
      ['PG-BAN-RENAME'],
    )

    const v2 = checkPgMigrationSql(
      'ALTER TABLE users RENAME COLUMN nick TO display_name;',
      '0999_ren.sql',
    )
    assert.deepEqual(
      v2.map((v) => v.rule),
      ['PG-BAN-RENAME'],
    )
  })

  test('4. PG-BAN-TRUNCATE blocks TRUNCATE', () => {
    const v1 = checkPgMigrationSql('TRUNCATE TABLE sessions;', '0999_trunc.sql')
    assert.deepEqual(
      v1.map((v) => v.rule),
      ['PG-BAN-TRUNCATE'],
    )

    const v2 = checkPgMigrationSql('TRUNCATE audit_logs RESTART IDENTITY CASCADE;', '0999_trunc.sql')
    assert.deepEqual(
      v2.map((v) => v.rule),
      ['PG-BAN-TRUNCATE'],
    )
  })

  test('5. PG-ADDING-REQUIRED-FIELD blocks ADD COLUMN NOT NULL without DEFAULT', () => {
    const v1 = checkPgMigrationSql(
      'ALTER TABLE users ADD COLUMN tenant_id TEXT NOT NULL;',
      '0999_req.sql',
    )
    assert.deepEqual(
      v1.map((v) => v.rule),
      ['PG-ADDING-REQUIRED-FIELD'],
    )

    // Multi-action ALTER TABLE where first column has DEFAULT but second does not
    const v2 = checkPgMigrationSql(
      "ALTER TABLE users ADD COLUMN tier TEXT NOT NULL DEFAULT 'free', ADD COLUMN org_id BIGINT NOT NULL;",
      '0999_req.sql',
    )
    assert.deepEqual(
      v2.map((v) => v.rule),
      ['PG-ADDING-REQUIRED-FIELD'],
    )
  })

  test('6. PG-CHANGING-COLUMN-TYPE blocks ALTER COLUMN TYPE', () => {
    const v1 = checkPgMigrationSql(
      'ALTER TABLE usage_records ALTER COLUMN cost TYPE BIGINT;',
      '0999_type.sql',
    )
    assert.deepEqual(
      v1.map((v) => v.rule),
      ['PG-CHANGING-COLUMN-TYPE'],
    )

    const v2 = checkPgMigrationSql(
      'ALTER TABLE usage_records ALTER COLUMN cost SET DATA TYPE NUMERIC(18, 2);',
      '0999_type.sql',
    )
    assert.deepEqual(
      v2.map((v) => v.rule),
      ['PG-CHANGING-COLUMN-TYPE'],
    )
  })

  test('7. PG-LOCKING-INDEX-OR-CONSTRAINT blocks non-concurrent index, validating CHECK/FK, and nested DO/BEGIN/IF CHECK (0102 regression)', () => {
    const vIdx = checkPgMigrationSql(
      'CREATE INDEX idx_users_email ON users (email);',
      '0999_idx.sql',
    )
    assert.deepEqual(
      vIdx.map((v) => v.rule),
      ['PG-LOCKING-INDEX-OR-CONSTRAINT'],
    )

    const vUniq = checkPgMigrationSql(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_slug ON public.users (slug);',
      '0999_idx.sql',
    )
    assert.deepEqual(
      vUniq.map((v) => v.rule),
      ['PG-LOCKING-INDEX-OR-CONSTRAINT'],
    )

    const vCheck = checkPgMigrationSql(
      'ALTER TABLE orders ADD CONSTRAINT chk_orders_positive CHECK (amount > 0);',
      '0999_chk.sql',
    )
    assert.deepEqual(
      vCheck.map((v) => v.rule),
      ['PG-LOCKING-INDEX-OR-CONSTRAINT'],
    )

    const vFk = checkPgMigrationSql(
      'ALTER TABLE orders ADD CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users (id);',
      '0999_fk.sql',
    )
    assert.deepEqual(
      vFk.map((v) => v.rule),
      ['PG-LOCKING-INDEX-OR-CONSTRAINT'],
    )

    // Real regression: 0102_marketplace_install_agent_scope.sql nested DO -> BEGIN -> IF -> ALTER TABLE ADD CONSTRAINT CHECK without NOT VALID
    const sql0102 = readFileSync(
      path.join(ROOT, 'packages/commercial/src/db/migrations/0102_marketplace_install_agent_scope.sql'),
      'utf8',
    )
    const v0102 = checkPgMigrationSql(sql0102, '0102_marketplace_install_agent_scope.sql')
    assert.deepEqual(
      v0102.map((v) => v.rule),
      ['PG-LOCKING-INDEX-OR-CONSTRAINT'],
    )
  })

  test('8. PG-CONCURRENTLY-REQUIRES-NO-TRANSACTION enforces migrate.ts -- no-transaction header (0180 regression)', () => {
    const sql0180 = readFileSync(
      path.join(ROOT, 'packages/commercial/src/db/migrations/0180_refresh_tokens_rotated_to_index.sql'),
      'utf8',
    )
    // Keeping `-- no-transaction` passes cleanly
    assert.deepEqual(checkPgMigrationSql(sql0180, '0180_refresh_tokens_rotated_to_index.sql'), [])

    // Removing the first line (`-- no-transaction`) MUST fail loud
    const withoutHeader = sql0180.split('\n').slice(1).join('\n')
    const vNoHeader = checkPgMigrationSql(withoutHeader, '0180_missing_header.sql')
    assert.deepEqual(
      vNoHeader.map((v) => v.rule),
      ['PG-CONCURRENTLY-REQUIRES-NO-TRANSACTION'],
    )

    // DROP INDEX CONCURRENTLY without `-- no-transaction` MUST also fail
    const vDropIdx = checkPgMigrationSql(
      'DROP INDEX CONCURRENTLY IF EXISTS idx_old_unused;',
      '0999_drop_idx.sql',
    )
    assert.deepEqual(
      vDropIdx.map((v) => v.rule),
      ['PG-CONCURRENTLY-REQUIRES-NO-TRANSACTION'],
    )

    // CONCURRENTLY inside DO $$ ... $$ is always forbidden by PostgreSQL even with `-- no-transaction`
    const vDoConcurrent = checkPgMigrationSql(
      '-- no-transaction\nDO $$ BEGIN CREATE INDEX CONCURRENTLY idx_x ON users (x); END $$;',
      '0999_do_concurrent.sql',
    )
    assert.deepEqual(
      vDoConcurrent.map((v) => v.rule),
      ['PG-CONCURRENTLY-REQUIRES-NO-TRANSACTION'],
    )
  })
})

describe('check-pg-migration-safety: anti-bypass & trusted Boss approval', () => {
  test('-- compat: comments CANNOT bypass any deadly DDL rule', () => {
    const sql = `
      -- compat: safe because old instances ignore it
      DROP TABLE legacy_items;
      -- compat: column unused
      ALTER TABLE users DROP COLUMN old_flag;
      -- compat: small table
      CREATE INDEX idx_users_x ON users (x);
      -- compat: quick check
      ALTER TABLE orders ADD CONSTRAINT chk_x CHECK (x > 0);
    `
    const violations = checkPgMigrationSql(sql, '0999_bypass_attempt.sql')
    assert.deepEqual(
      violations.map((v) => v.rule),
      [
        'PG-BAN-DROP-TABLE',
        'PG-BAN-DROP-COLUMN',
        'PG-LOCKING-INDEX-OR-CONSTRAINT',
        'PG-LOCKING-INDEX-OR-CONSTRAINT',
      ],
    )
    const rendered = formatPgViolation(violations[0]!)
    assert.match(rendered, /\[GATE-ERROR\] PG-BAN-DROP-TABLE/)
    assert.match(rendered, /Expand-Contract/)
    assert.match(rendered, /-- compat:.*CANNOT bypass/)
    assert.match(rendered, new RegExp(`${BOSS_APPROVAL_ENV}=1`))
  })

  test('OC_PG_MIGRATION_BOSS_APPROVED=1 allows local manual escape hatch', (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pg-safety-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const f = path.join(dir, '0999_contract.sql')
    writeFileSync(f, 'DROP TABLE retired_table;\n')

    const blocked = runPgMigrationSafetyCheck({
      root: dir,
      files: [f],
      useSquawk: false,
      env: {},
    })
    assert.equal(blocked.violations.length, 1)
    assert.equal(blocked.bossApproved, false)

    const approved = runPgMigrationSafetyCheck({
      root: dir,
      files: [f],
      useSquawk: false,
      env: { [BOSS_APPROVAL_ENV]: '1' },
    })
    assert.equal(approved.violations.length, 1)
    assert.equal(approved.bossApproved, true)
    assert.equal(approved.approvedVia, 'env')
  })

  test('--approved-commit authorizes exact HEAD or last migration commit (batch push), rejects mismatch/dirty/malformed', (t) => {
    const dir = initTempGitRepo(t)
    const git = (args: string[]) =>
      execFileSync('git', ['-C', dir, ...args], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'test',
          GIT_AUTHOR_EMAIL: 'test@example.com',
          GIT_COMMITTER_NAME: 'test',
          GIT_COMMITTER_EMAIL: 'test@example.com',
        },
      }).trim()

    const baseSha = git(['rev-parse', 'HEAD'])
    const migDir = path.join(dir, 'packages/commercial/src/db/migrations')
    mkdirSync(migDir, { recursive: true })
    const migFile = path.join(migDir, '9999_contract_drop.sql')
    writeFileSync(migFile, 'DROP TABLE retired_table;\n')
    git(['add', '.'])
    git(['commit', '-q', '-m', 'contract drop migration'])
    const migCommitSha = git(['rev-parse', 'HEAD'])

    // 1. Malformed SHA -> fail-closed throw
    assert.throws(
      () =>
        runPgMigrationSafetyCheck({
          root: dir,
          base: baseSha,
          approvedCommit: 'not-a-40-hex-sha',
          useSquawk: false,
          env: {},
        }),
      /invalid --approved-commit/,
    )

    // 2. Wrong 40-hex SHA -> rejected
    const wrongSha = '0'.repeat(40)
    const rWrong = runPgMigrationSafetyCheck({
      root: dir,
      base: baseSha,
      approvedCommit: wrongSha,
      useSquawk: false,
      env: {},
    })
    assert.equal(rWrong.violations.length, 1)
    assert.equal(rWrong.bossApproved, false)

    // 3. Exact HEAD SHA with clean tree -> approved
    const rHead = runPgMigrationSafetyCheck({
      root: dir,
      base: baseSha,
      approvedCommit: migCommitSha,
      useSquawk: false,
      env: {},
    })
    assert.equal(rHead.violations.length, 1)
    assert.equal(rHead.bossApproved, true)
    assert.equal(rHead.approvedVia, 'approved-commit')

    // 4. Batch push: a subsequent non-migration commit lands on top; approving migCommitSha still matches lastMigrationCommit
    writeFileSync(path.join(dir, 'README.md'), 'follow-up non-migration doc\n')
    git(['add', 'README.md'])
    git(['commit', '-q', '-m', 'non-migration follow-up'])
    const laterHeadSha = git(['rev-parse', 'HEAD'])
    assert.notEqual(laterHeadSha, migCommitSha)

    const rBatch = runPgMigrationSafetyCheck({
      root: dir,
      base: baseSha,
      approvedCommit: migCommitSha,
      useSquawk: false,
      env: {},
    })
    assert.equal(rBatch.violations.length, 1)
    assert.equal(rBatch.lastMigrationCommit, migCommitSha)
    assert.equal(rBatch.bossApproved, true)
    assert.equal(rBatch.approvedVia, 'approved-commit')

    // 5. Dirty working-tree edit to migration MUST revoke commit approval
    writeFileSync(migFile, 'DROP TABLE retired_table;\nDROP TABLE another_table;\n')
    const rDirty = runPgMigrationSafetyCheck({
      root: dir,
      base: baseSha,
      approvedCommit: laterHeadSha,
      useSquawk: false,
      env: {},
    })
    assert.equal(rDirty.hasDirtyMigrationEdit, true)
    assert.equal(rDirty.bossApproved, false)
  })
})

describe('check-pg-migration-safety: safe Expand-Contract SQL (green)', () => {
  test('allows safe additive DDL, NOT VALID constraints, new-table indexes, temp tables, comments & strings', () => {
    const transactionalExpand = `
      -- DROP TABLE should be ignored in line comments
      /* Nested /* DROP TABLE users; TRUNCATE orders; */ block comment */
      CREATE TABLE IF NOT EXISTS user_audit_events (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL,
        note TEXT NOT NULL DEFAULT 'DROP TABLE literal inside string'
      );
      -- Non-concurrent index on a table created in the SAME migration is safe
      CREATE INDEX idx_user_audit_events_user ON user_audit_events (user_id);
      CREATE UNIQUE INDEX idx_user_audit_events_uniq ON public.user_audit_events (id, user_id);

      -- Temp table lifecycle is safe
      CREATE TEMP TABLE tmp_backfill_ids (id BIGINT);
      TRUNCATE tmp_backfill_ids;
      DROP TABLE tmp_backfill_ids;

      -- Expand phase: ADD COLUMN with DEFAULT or nullable
      ALTER TABLE users ADD COLUMN tier TEXT NOT NULL DEFAULT 'free';
      ALTER TABLE users ADD COLUMN bio TEXT;
      ALTER TABLE users ALTER COLUMN legacy_col DROP NOT NULL;
      ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_legacy_obsolete;

      -- Two-step non-blocking constraint validation
      ALTER TABLE orders ADD CONSTRAINT chk_orders_positive CHECK (amount > 0) NOT VALID;
      ALTER TABLE orders VALIDATE CONSTRAINT chk_orders_positive;
      ALTER TABLE orders ADD CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users (id) NOT VALID;
      ALTER TABLE orders VALIDATE CONSTRAINT fk_orders_user;
    `
    assert.deepEqual(checkPgMigrationSql(transactionalExpand, '0999_safe_expand.sql'), [])

    const concurrentIndexMigration = [
      '-- no-transaction',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_tier ON users (tier);',
      'CREATE UNIQUE INDEX CONCURRENTLY idx_users_external_id ON users (external_id);',
      'DROP INDEX CONCURRENTLY IF EXISTS idx_users_legacy;',
    ].join('\n')
    assert.deepEqual(checkPgMigrationSql(concurrentIndexMigration, '0999_safe_idx.sql'), [])
  })

  test('CLI exits 1 on unsafe file, 0 with boss approval, 0 on safe file, 2 on parse error', (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pg-safety-cli-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const badFile = path.join(dir, 'bad.sql')
    const goodFile = path.join(dir, 'good.sql')
    const brokenFile = path.join(dir, 'broken.sql')
    writeFileSync(badFile, '-- compat: trying to bypass\nALTER TABLE users DROP COLUMN email;\n')
    writeFileSync(goodFile, "ALTER TABLE users ADD COLUMN region TEXT NOT NULL DEFAULT 'cn';\n")
    writeFileSync(brokenFile, '/* unterminated comment\nSELECT 1;\n')

    const tsxBin = path.join(ROOT, 'node_modules/.bin/tsx')
    const rBad = spawnSync(tsxBin, [SCRIPT, '--file', badFile, '--no-squawk'], {
      encoding: 'utf8',
      env: { ...process.env, [BOSS_APPROVAL_ENV]: '' },
    })
    assert.equal(rBad.status, 1)
    assert.match(rBad.stderr, /\[GATE-ERROR\] PG-BAN-DROP-COLUMN/)

    const rApproved = spawnSync(tsxBin, [SCRIPT, '--file', badFile, '--no-squawk'], {
      encoding: 'utf8',
      env: { ...process.env, [BOSS_APPROVAL_ENV]: '1' },
    })
    assert.equal(rApproved.status, 0)

    const rGood = spawnSync(tsxBin, [SCRIPT, '--file', goodFile, '--no-squawk'], {
      encoding: 'utf8',
    })
    assert.equal(rGood.status, 0)

    const rBroken = spawnSync(tsxBin, [SCRIPT, '--file', brokenFile, '--no-squawk'], {
      encoding: 'utf8',
    })
    assert.equal(rBroken.status, 2)
  })

  test('NON-WAIVABLE: PG-CONCURRENTLY-REQUIRES-NO-TRANSACTION is NEVER waived even with Boss approval', (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pg-safety-nonwaivable-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const badTxConcurrent = path.join(dir, '0999_tx_concurrent.sql')
    writeFileSync(badTxConcurrent, 'CREATE INDEX CONCURRENTLY idx_x ON users (id);\n')

    const tsxBin = path.join(ROOT, 'node_modules/.bin/tsx')
    const rEvenApproved = spawnSync(tsxBin, [SCRIPT, '--file', badTxConcurrent, '--no-squawk'], {
      encoding: 'utf8',
      env: { ...process.env, [BOSS_APPROVAL_ENV]: '1' },
    })
    assert.equal(rEvenApproved.status, 1)
    assert.match(rEvenApproved.stderr, /\[GATE-ERROR\] PG-CONCURRENTLY-REQUIRES-NO-TRANSACTION/)
  })

  test('--approved-file scopes batch-push approval strictly to approved migration files only', (t) => {
    const dir = initTempGitRepo(t)
    const git = (args: string[]) =>
      execFileSync('git', ['-C', dir, ...args], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'test',
          GIT_AUTHOR_EMAIL: 'test@example.com',
          GIT_COMMITTER_NAME: 'test',
          GIT_COMMITTER_EMAIL: 'test@example.com',
        },
      }).trim()

    const baseSha = git(['rev-parse', 'HEAD'])
    const migDir = path.join(dir, 'packages/commercial/src/db/migrations')
    mkdirSync(migDir, { recursive: true })
    const fileA = 'packages/commercial/src/db/migrations/0998_approved_drop.sql'
    const fileB = 'packages/commercial/src/db/migrations/0999_unapproved_drop.sql'
    writeFileSync(path.join(migDir, '0998_approved_drop.sql'), 'DROP TABLE old_a;\n')
    git(['add', fileA])
    git(['commit', '-qm', 'approved migration A'])
    writeFileSync(path.join(migDir, '0999_unapproved_drop.sql'), 'DROP TABLE old_b;\n')
    git(['add', fileB])
    git(['commit', '-qm', 'unapproved migration B'])

    const tsxBin = path.join(ROOT, 'node_modules/.bin/tsx')
    // Approving only fileA must STILL fail on unapproved fileB
    const partial = spawnSync(
      tsxBin,
      [SCRIPT, '--root', dir, '--base', baseSha, '--approved-file', fileA, '--no-squawk'],
      { encoding: 'utf8', env: { ...process.env, [BOSS_APPROVAL_ENV]: '0' } },
    )
    assert.equal(partial.status, 1)
    assert.match(partial.stderr, /0999_unapproved_drop\.sql/)
    assert.doesNotMatch(partial.stderr, /0998_approved_drop\.sql/)

    // Approving both fileA and fileB passes
    const both = spawnSync(
      tsxBin,
      [
        SCRIPT,
        '--root',
        dir,
        '--base',
        baseSha,
        '--approved-file',
        fileA,
        '--approved-file',
        fileB,
        '--no-squawk',
      ],
      { encoding: 'utf8', env: { ...process.env, [BOSS_APPROVAL_ENV]: '0' } },
    )
    assert.equal(both.status, 0, both.stderr)
  })
})
