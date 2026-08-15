import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const advisor = path.join(root, 'scripts/v5-change-route.sh')
const deploy = path.join(root, 'scripts/deploy-v5.sh')

function sh(args: string[], env: NodeJS.ProcessEnv = {}, cwd?: string) {
  return spawnSync('bash', args, {
    cwd: cwd ?? root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

function initRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'v5-change-route-'))
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

function commitFiles(dir: string, files: Record<string, string>, message: string) {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true })
    writeFileSync(path.join(dir, rel), body)
  }
  const add = spawnSync('git', ['add', '.'], { cwd: dir, encoding: 'utf8' })
  assert.equal(add.status, 0, add.stderr)
  const commit = spawnSync('git', ['commit', '-m', message], { cwd: dir, encoding: 'utf8' })
  assert.equal(commit.status, 0, commit.stderr)
}

test('frontend-only changeset routes to --with-dist', () => {
  const dir = initRepo()
  try {
    commitFiles(dir, { 'packages/web-react/public/logo.svg': '<svg/>\n' }, 'logo')
    const result = sh([advisor, '--repo', dir])
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /route: with-dist/)
    assert.match(result.stdout, /--with-dist/)
    assert.match(result.stdout, /logo\.svg/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('source-only changeset routes to full deploy', () => {
  const dir = initRepo()
  try {
    commitFiles(dir, { 'packages/gateway/src/x.ts': 'export const x = 1\n' }, 'src')
    const result = sh([advisor, '--repo', dir])
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /route: deploy\n/)
    assert.doesNotMatch(result.stdout, /route: deploy-with-dist/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('source plus frontend collapses to deploy-with-dist', () => {
  const dir = initRepo()
  try {
    commitFiles(
      dir,
      {
        'packages/gateway/src/x.ts': 'export const x = 1\n',
        'packages/web-react/src/App.tsx': 'export const App = () => null\n',
      },
      'both',
    )
    const result = sh([advisor, '--repo', dir])
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /route: deploy-with-dist/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('catalog routes to admin API; catalog+env is mixed; unknown is fail-closed', () => {
  const catalogDir = initRepo()
  try {
    commitFiles(
      catalogDir,
      {
        'packages/commercial/agent-sandbox/platform-runtime/etc-codex/model-catalog.local.json':
          '{}\n',
      },
      'cat',
    )
    const catalog = sh([advisor, '--repo', catalogDir])
    assert.equal(catalog.status, 0, catalog.stdout + catalog.stderr)
    assert.match(catalog.stdout, /route: admin-catalog/)
  } finally {
    rmSync(catalogDir, { recursive: true, force: true })
  }

  const mixedDir = initRepo()
  try {
    commitFiles(
      mixedDir,
      {
        'packages/commercial/agent-sandbox/platform-runtime/etc-codex/model-catalog.local.json':
          '{}\n',
        'deploy/v5/commercial-v5.env.overrides': 'OC_X=2\n',
      },
      'mixed',
    )
    const mixed = sh([advisor, '--repo', mixedDir])
    assert.equal(mixed.status, 2, mixed.stdout + mixed.stderr)
    assert.match(mixed.stdout, /route: mixed/)
  } finally {
    rmSync(mixedDir, { recursive: true, force: true })
  }

  const unkDir = initRepo()
  try {
    commitFiles(unkDir, { 'mystery.bin': 'x\n' }, 'unk')
    const unk = sh([advisor, '--repo', unkDir])
    assert.equal(unk.status, 2, unk.stdout + unk.stderr)
    assert.match(unk.stdout, /route: unknown/)
    assert.match(unk.stderr, /fail-closed/)
  } finally {
    rmSync(unkDir, { recursive: true, force: true })
  }
})

test('docs and changelog are no-deploy', () => {
  const dir = initRepo()
  try {
    commitFiles(dir, { 'docs/note.md': 'hi\n', 'changelog.json': '{"releases":[]}\n' }, 'docs')
    const result = sh([advisor, '--repo', dir])
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /route: no-deploy/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('deploy-v5.sh --hot-config is a seatbelt: prints the route and refuses to deploy', () => {
  const dir = initRepo()
  try {
    commitFiles(dir, { 'packages/web-react/public/logo.svg': '<svg/>\n' }, 'logo')
    const result = sh([deploy, '--hot-config'], {
      V5_DEPLOY_SOURCE_ONLY: '1',
      ALLOW_ANY_BRANCH: '1',
      OC_V5_HOT_CONFIG_REPO_ROOT: dir,
    })
    assert.equal(result.status, 2, result.stdout + result.stderr)
    assert.match(result.stderr, /安全带|拒绝执行 deploy/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
