import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const runner = path.join(root, 'scripts/v5-worktree-new.sh')

function sh(args: string[], env: NodeJS.ProcessEnv = {}, cwd?: string) {
  return spawnSync('bash', [runner, ...args], {
    cwd: cwd ?? root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

function fakeDonor(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'v5-wt-donor-'))
  const git = (a: string[]) => {
    const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    return r
  }
  git(['init', '-b', 'feat/v5-aurora-rewrite'])
  git(['config', 'user.email', 'wt-b2@example.test'])
  git(['config', 'user.name', 'wt-b2'])
  writeFileSync(path.join(dir, 'README.md'), 'donor\n')
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'openclaude', private: true, workspaces: ['packages/*'] }) + '\n',
  )
  mkdirSync(path.join(dir, 'packages/protocol/src'), { recursive: true })
  writeFileSync(
    path.join(dir, 'packages/protocol/package.json'),
    JSON.stringify({ name: '@openclaude/protocol', type: 'module', exports: { '.': './src/index.ts' } }) +
      '\n',
  )
  writeFileSync(path.join(dir, 'packages/protocol/src/index.ts'), 'export const mark = "donor"\n')
  mkdirSync(path.join(dir, 'packages/protocol/dist-types'), { recursive: true })
  writeFileSync(path.join(dir, 'packages/protocol/dist-types/.tsbuildinfo'), '{"version":"fake"}\n')
  writeFileSync(path.join(dir, 'packages/protocol/dist-types/index.d.ts'), 'export {}\n')
  mkdirSync(path.join(dir, 'node_modules/.bin'), { recursive: true })
  mkdirSync(path.join(dir, 'node_modules/typescript/bin'), { recursive: true })
  writeFileSync(
    path.join(dir, 'node_modules/typescript/bin/tsc'),
    '#!/bin/sh\necho "Version 5.0.0-fake"\n',
  )
  chmodSync(path.join(dir, 'node_modules/typescript/bin/tsc'), 0o755)
  mkdirSync(path.join(dir, 'node_modules/tsx/dist'), { recursive: true })
  writeFileSync(
    path.join(dir, 'node_modules/tsx/dist/cli.mjs'),
    '#!/usr/bin/env node\nconsole.log("tsx 4.0.0-fake")\n',
  )
  chmodSync(path.join(dir, 'node_modules/tsx/dist/cli.mjs'), 0o755)
  symlinkSync('../typescript/bin/tsc', path.join(dir, 'node_modules/.bin/tsc'))
  symlinkSync('../tsx/dist/cli.mjs', path.join(dir, 'node_modules/.bin/tsx'))
  // 复现缺陷:相对链接。整棵 node_modules 被软链时会解析进 donor。
  mkdirSync(path.join(dir, 'node_modules/@openclaude'), { recursive: true })
  symlinkSync('../../packages/protocol', path.join(dir, 'node_modules/@openclaude/protocol'))
  writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n')
  git(['add', '.'])
  git(['commit', '-m', 'donor'])
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('refuses to clobber an existing path and rejects a bad name', () => {
  const bad = sh(['../escape'])
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /非法 name/)

  const help = sh(['--help'])
  assert.equal(help.status, 0)
  assert.match(help.stdout, /--fresh/)
  assert.match(help.stdout, /--report/)
  assert.match(help.stdout, /--self-check/)
})

test('shared tree self-points @openclaude/* and keeps third-party on donor', () => {
  const donor = fakeDonor()
  const base = mkdtempSync(path.join(tmpdir(), 'v5-wt-base-'))
  const cache = mkdtempSync(path.join(tmpdir(), 'v5-wt-cache-'))
  try {
    const created = sh(['probe1', 'feat/v5-aurora-rewrite'], {
      OC_V5_CANONICAL: donor.dir,
      OC_V5_WORKTREE_BASE_DIR: base,
      OC_V5_WORKTREE_CACHE: cache,
    })
    assert.equal(created.status, 0, created.stderr + created.stdout)
    assert.match(created.stdout, /symlink/)
    assert.match(created.stdout, /\.bin 可用/)
    assert.match(created.stdout, /tsc 增量缓存已从 donor 拷入/)
    assert.match(created.stdout, /自检通过/)

    const wt = path.join(base, 'openclaude-v5-probe1')
    const proto = realpathSync(path.join(wt, 'node_modules/@openclaude/protocol'))
    const tscPkg = realpathSync(path.join(wt, 'node_modules/typescript'))
    assert.equal(proto, realpathSync(path.join(wt, 'packages/protocol')))
    assert.ok(tscPkg.startsWith(realpathSync(donor.dir) + path.sep), tscPkg)
    assert.notEqual(proto, realpathSync(path.join(donor.dir, 'packages/protocol')))

    const tsc = spawnSync(path.join(wt, 'node_modules/.bin/tsc'), ['--version'], { encoding: 'utf8' })
    assert.equal(tsc.status, 0, tsc.stderr)
    assert.match(tsc.stdout, /5\.0\.0-fake/)

    const check = sh(['--self-check', wt], { OC_V5_CANONICAL: donor.dir })
    assert.equal(check.status, 0, check.stderr + check.stdout)

    const again = sh(['probe1', 'feat/v5-aurora-rewrite'], {
      OC_V5_CANONICAL: donor.dir,
      OC_V5_WORKTREE_BASE_DIR: base,
      OC_V5_WORKTREE_CACHE: cache,
    })
    assert.equal(again.status, 2, again.stdout + again.stderr)
    assert.match(again.stderr, /目标路径已存在/)

    const report = sh(['--report'], { OC_V5_WORKTREE_BASE_DIR: base })
    assert.equal(report.status, 0, report.stderr)
    assert.match(report.stdout, /只列不删/)
    assert.match(report.stdout, /openclaude-v5-probe1/)
  } finally {
    const wt = path.join(base, 'openclaude-v5-probe1')
    spawnSync('git', ['-C', donor.dir, 'worktree', 'remove', '--force', wt], { encoding: 'utf8' })
    rmSync(base, { recursive: true, force: true })
    rmSync(cache, { recursive: true, force: true })
    donor.cleanup()
  }
})

test('--heal rebinds a whole-tree node_modules symlink back onto this worktree', () => {
  const donor = fakeDonor()
  const base = mkdtempSync(path.join(tmpdir(), 'v5-wt-heal-bug-'))
  const cache = mkdtempSync(path.join(tmpdir(), 'v5-wt-cache-'))
  try {
    const created = sh(['healbug', 'feat/v5-aurora-rewrite'], {
      OC_V5_CANONICAL: donor.dir,
      OC_V5_WORKTREE_BASE_DIR: base,
      OC_V5_WORKTREE_CACHE: cache,
    })
    assert.equal(created.status, 0, created.stderr + created.stdout)
    const wt = path.join(base, 'openclaude-v5-healbug')

    rmSync(path.join(wt, 'node_modules'), { recursive: true, force: true })
    symlinkSync(path.join(donor.dir, 'node_modules'), path.join(wt, 'node_modules'))
    const leaked = realpathSync(path.join(wt, 'node_modules/@openclaude/protocol'))
    assert.equal(leaked, realpathSync(path.join(donor.dir, 'packages/protocol')))

    const broken = sh(['--self-check', wt], { OC_V5_CANONICAL: donor.dir })
    assert.equal(broken.status, 2, broken.stdout + broken.stderr)
    assert.match(broken.stderr, /不在本树/)

    const heal = sh(['--heal', wt], { OC_V5_CANONICAL: donor.dir })
    assert.equal(heal.status, 0, heal.stdout + heal.stderr)
    assert.match(heal.stdout, /拆开重绑|自指/)
    const fixed = realpathSync(path.join(wt, 'node_modules/@openclaude/protocol'))
    assert.equal(fixed, realpathSync(path.join(wt, 'packages/protocol')))
    const tscPkg = realpathSync(path.join(wt, 'node_modules/typescript'))
    assert.ok(tscPkg.startsWith(realpathSync(donor.dir) + path.sep), tscPkg)
  } finally {
    const wt = path.join(base, 'openclaude-v5-healbug')
    spawnSync('git', ['-C', donor.dir, 'worktree', 'remove', '--force', wt], { encoding: 'utf8' })
    rmSync(base, { recursive: true, force: true })
    rmSync(cache, { recursive: true, force: true })
    donor.cleanup()
  }
})

test('--heal drops stale tsbuildinfo when HEAD left the cache bucket', () => {
  const donor = fakeDonor()
  const base = mkdtempSync(path.join(tmpdir(), 'v5-wt-heal-'))
  const cache = mkdtempSync(path.join(tmpdir(), 'v5-wt-cache-'))
  try {
    const created = sh(['healme', 'feat/v5-aurora-rewrite'], {
      OC_V5_CANONICAL: donor.dir,
      OC_V5_WORKTREE_BASE_DIR: base,
      OC_V5_WORKTREE_CACHE: cache,
    })
    assert.equal(created.status, 0, created.stderr + created.stdout)
    const wt = path.join(base, 'openclaude-v5-healme')
    writeFileSync(path.join(wt, 'extra.txt'), 'moved\n')
    const commit = spawnSync('git', ['-C', wt, 'add', 'extra.txt'], { encoding: 'utf8' })
    assert.equal(commit.status, 0, commit.stderr)
    const c2 = spawnSync(
      'git',
      ['-C', wt, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'move'],
      { encoding: 'utf8' },
    )
    assert.equal(c2.status, 0, c2.stderr)
    const heal = sh(['--heal', wt], { OC_V5_CANONICAL: donor.dir })
    assert.equal(heal.status, 0, heal.stdout + heal.stderr)
    assert.match(heal.stdout, /丢弃本树 tsbuildinfo/)
  } finally {
    const wt = path.join(base, 'openclaude-v5-healme')
    spawnSync('git', ['-C', donor.dir, 'worktree', 'remove', '--force', wt], { encoding: 'utf8' })
    rmSync(base, { recursive: true, force: true })
    rmSync(cache, { recursive: true, force: true })
    donor.cleanup()
  }
})
