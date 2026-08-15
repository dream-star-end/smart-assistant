import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const lib = path.join(root, 'scripts/v5-hot-config-lib.sh')
const deploy = path.join(root, 'scripts/deploy-v5.sh')

function sh(args: string[], env: NodeJS.ProcessEnv = {}, cwd?: string) {
  return spawnSync('bash', args, {
    cwd: cwd ?? root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

function initRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'v5-hot-config-'))
  const git = (a: string[]) => {
    const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    return r
  }
  git(['init', '-b', 'feat/v5-aurora-rewrite'])
  git(['config', 'user.email', 'wt-b2@example.test'])
  git(['config', 'user.name', 'wt-b2'])
  writeFileSync(path.join(dir, 'README.md'), 'base\n')
  mkdirSync(path.join(dir, 'deploy/v5'), { recursive: true })
  writeFileSync(path.join(dir, 'deploy/v5/commercial-v5.env.overrides'), 'OC_X=1\n')
  git(['add', '.'])
  git(['commit', '-m', 'base'])
  return dir
}

test('hot-config accepts env override and catalog json only', () => {
  const dir = initRepo()
  try {
    writeFileSync(path.join(dir, 'deploy/v5/commercial-v5.env.overrides'), 'OC_X=2\n')
    mkdirSync(path.join(dir, 'packages/commercial/agent-sandbox/platform-runtime/etc-codex'), {
      recursive: true,
    })
    writeFileSync(
      path.join(dir, 'packages/commercial/agent-sandbox/platform-runtime/etc-codex/model-catalog.local.json'),
      '{}\n',
    )
    const add = spawnSync('git', ['add', '.'], { cwd: dir, encoding: 'utf8' })
    assert.equal(add.status, 0, add.stderr)
    const commit = spawnSync('git', ['commit', '-m', 'cfg'], { cwd: dir, encoding: 'utf8' })
    assert.equal(commit.status, 0, commit.stderr)

    const result = sh([lib, '--check'], { OC_V5_HOT_CONFIG_REPO_ROOT: dir })
    assert.equal(result.status, 0, result.stderr + result.stdout)
    assert.match(result.stdout, /变更集全部落在 hot-config 白名单/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('hot-config rejects TypeScript and migrations without a silent bypass', () => {
  const dir = initRepo()
  try {
    mkdirSync(path.join(dir, 'packages/commercial/src'), { recursive: true })
    writeFileSync(path.join(dir, 'packages/commercial/src/modelCatalog.ts'), 'export const x = 1\n')
    mkdirSync(path.join(dir, 'packages/commercial/src/db/migrations'), { recursive: true })
    writeFileSync(path.join(dir, 'packages/commercial/src/db/migrations/0999_x.sql'), 'SELECT 1;\n')
    spawnSync('git', ['add', '.'], { cwd: dir })
    spawnSync('git', ['commit', '-m', 'src'], { cwd: dir })

    const denied = sh([lib, '--check'], { OC_V5_HOT_CONFIG_REPO_ROOT: dir })
    assert.equal(denied.status, 2, denied.stdout + denied.stderr)
    assert.match(denied.stderr, /拒绝/)
    assert.match(denied.stderr, /改用完整 deploy/)

    const noReason = sh([lib, '--check'], {
      OC_V5_HOT_CONFIG_REPO_ROOT: dir,
      HOT_CONFIG_FORCE: '1',
    })
    assert.equal(noReason.status, 2, noReason.stdout + noReason.stderr)
    assert.match(noReason.stderr, /OC_V5_HOT_CONFIG_FORCE_REASON/)

    const audit = path.join(dir, 'force.audit.log')
    const forced = sh([lib, '--check'], {
      OC_V5_HOT_CONFIG_REPO_ROOT: dir,
      HOT_CONFIG_FORCE: '1',
      OC_V5_HOT_CONFIG_FORCE_REASON: 'emergency-catalog-plus-ts-hotfix',
      OC_V5_HOT_CONFIG_AUDIT_LOG: audit,
    })
    assert.equal(forced.status, 0, forced.stderr + forced.stdout)
    assert.match(forced.stdout, /AUDIT hot-config-force/)
    const logged = spawnSync('cat', [audit], { encoding: 'utf8' })
    assert.match(logged.stdout, /emergency-catalog-plus-ts-hotfix/)
    assert.match(logged.stdout, /modelCatalog\.ts/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('hot-config rejects an empty changeset', () => {
  const dir = initRepo()
  try {
    const result = sh([lib, '--check'], { OC_V5_HOT_CONFIG_REPO_ROOT: dir })
    assert.equal(result.status, 2, result.stdout + result.stderr)
    assert.match(result.stderr, /变更集为空/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('deploy-v5.sh --hot-config --with-dist is rejected before any remote work', () => {
  const result = sh([deploy, '--hot-config', '--with-dist'], {
    V5_DEPLOY_SOURCE_ONLY: '1',
    ALLOW_ANY_BRANCH: '1',
  })
  assert.equal(result.status, 2, result.stdout + result.stderr)
  assert.match(result.stderr, /--hot-config 与 --with-dist 互斥/)
})

test('deploy-v5.sh --hot-config --canary is rejected', () => {
  const result = sh([deploy, '--hot-config', '--canary'], {
    V5_DEPLOY_SOURCE_ONLY: '1',
    ALLOW_ANY_BRANCH: '1',
  })
  assert.equal(result.status, 2, result.stdout + result.stderr)
  assert.match(result.stderr, /只允许普通 deploy lane/)
})
