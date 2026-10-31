import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const lib = readFileSync(join(root, 'scripts/v5-selfhost-master-release-lib.sh'), 'utf8');
const timer = join(root, 'scripts/lib/v5-selfhost-tsc-timer.cjs');
const tsc = realpathSync(join(root, 'node_modules/typescript/bin/tsc'));
const q = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const fn = (name) => {
  const match = lib.match(new RegExp(`^${name}\\(\\) \\{[^\\n]*\\n[\\s\\S]*?^\\}`, 'm'));
  assert.ok(match, name);
  return match[0];
};
const seed = fn('master_seed_frontend_buildinfo');
const build = fn('build_master_release');
const frontend = build.slice(build.indexOf('  master_job_frontend() {'), build.indexOf('  local job '));
const old = new Date('2000-01-01T00:00:00Z');

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'oc frontend incremental-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, env: { ...process.env, NODE_OPTIONS: '', HOME: dir } };
}

function project(f, name) {
  const dir = join(f.dir, name);
  const web = join(dir, 'packages/web-react');
  mkdirSync(join(web, 'src'), { recursive: true });
  mkdirSync(join(dir, 'node_modules/.bin'), { recursive: true });
  symlinkSync(join(root, 'node_modules/typescript'), join(dir, 'node_modules/typescript'), 'dir');
  symlinkSync('../typescript/bin/tsc', join(dir, 'node_modules/.bin/tsc'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/web-react'] }));
  writeFileSync(join(web, 'package.json'), JSON.stringify({
    name: '@fixture/web-react', private: true, type: 'module', scripts: { build: 'tsc -b && vite build' },
  }));
  writeFileSync(join(web, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      strict: true, noEmit: true, incremental: true, tsBuildInfoFile: 'tsconfig.tsbuildinfo',
      target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', types: [], lib: ['ES2022'],
    },
    include: ['src'], references: [],
  }));
  writeFileSync(join(web, 'src/index.ts'), 'export const answer: number = 42;\n');
  utimesSync(join(web, 'src/index.ts'), old, old);
  utimesSync(join(web, 'tsconfig.json'), old, old);
  return { dir, web, info: join(web, 'tsconfig.tsbuildinfo'), source: join(web, 'src/index.ts') };
}

function compile(f, p, env = {}) {
  return spawnSync(process.execPath, [tsc, '-b'], {
    cwd: p.web, env: { ...f.env, ...env }, encoding: 'utf8', timeout: 20_000,
  });
}

function assertPass(r) {
  assert.equal(r.status, 0, `${r.error || ''}\n${r.stdout}\n${r.stderr}`);
}

function seedInto(f, donor, staging) {
  const r = spawnSync('/bin/bash', ['-euo', 'pipefail', '-c', `${seed}\nmaster_seed_frontend_buildinfo "$1" "$2"`, '_', donor.dir, staging.dir], {
    env: f.env, encoding: 'utf8', timeout: 10_000,
  });
  assertPass(r);
}

function change(p, source) {
  writeFileSync(p.source, source);
  utimesSync(p.source, old, old);
}

function donorState(p) {
  const s = statSync(p.info);
  return { bytes: readFileSync(p.info, 'utf8'), ino: s.ino, mtimeMs: s.mtimeMs };
}

test('epoch seed catches an older-mtime type error that tsc -b otherwise skips, without modifying the donor', (t) => {
  const f = fixture(t);
  const donor = project(f, 'donor');
  const staging = project(f, 'staging');
  assertPass(compile(f, donor));
  const before = donorState(donor);
  change(staging, 'export const answer: number = "wrong";\n');
  assert.ok(statSync(staging.source).mtimeMs < before.mtimeMs);
  copyFileSync(donor.info, staging.info);
  utimesSync(staging.info, new Date(before.mtimeMs), new Date(before.mtimeMs));
  assertPass(compile(f, staging)); // Negative control: preserving the recent buildinfo timestamp misses the error.

  seedInto(f, donor, staging);
  assert.equal(statSync(staging.info).mtimeMs, 0);
  assert.notEqual(statSync(staging.info).ino, before.ino);
  const checked = compile(f, staging);
  assert.notEqual(checked.status, 0, checked.stdout + checked.stderr);
  assert.match(checked.stdout + checked.stderr, /TS2322/);
  assert.deepEqual(donorState(donor), before);
});

test('epoch seed accepts a valid changed source and detaches an existing donor hard link', (t) => {
  const f = fixture(t);
  const donor = project(f, 'donor');
  const staging = project(f, 'staging');
  assertPass(compile(f, donor));
  const before = donorState(donor);
  linkSync(donor.info, staging.info);
  change(staging, 'export const answer: number = 43;\n');
  seedInto(f, donor, staging);
  assert.equal(readFileSync(staging.info, 'utf8'), before.bytes);
  assert.notEqual(statSync(staging.info).ino, before.ino);
  assertPass(compile(f, staging));
  assert.notEqual(readFileSync(staging.info, 'utf8'), before.bytes, 'tsc updates the changed source hash');
  assert.deepEqual(donorState(donor), before);
});

for (const kind of ['version mismatch', 'damaged JSON']) {
  test(`tsc itself fully checks a seeded buildinfo with ${kind}`, (t) => {
    const f = fixture(t);
    const donor = project(f, 'donor');
    const staging = project(f, 'staging');
    assertPass(compile(f, donor));
    const info = readFileSync(donor.info, 'utf8');
    const supplied = kind === 'damaged JSON' ? '{broken buildinfo\n' : JSON.stringify({ ...JSON.parse(info), version: '0.0.fixture' });
    writeFileSync(donor.info, supplied);
    const before = donorState(donor);
    change(staging, 'export const answer: number = "must be checked";\n');
    seedInto(f, donor, staging);
    assert.equal(readFileSync(staging.info, 'utf8'), supplied, 'the seeder neither parses nor discards incompatible buildinfo');
    const checked = compile(f, staging);
    assert.notEqual(checked.status, 0, checked.stdout + checked.stderr);
    assert.match(checked.stdout + checked.stderr, /TS2322/);
    assert.deepEqual(donorState(donor), before);
  });
}

test('a source symlink is copied as private buildinfo content, and a missing donor needs no cache', (t) => {
  const f = fixture(t);
  const donor = project(f, 'donor');
  const staging = project(f, 'staging');
  const cache = join(f.dir, 'cache');
  writeFileSync(cache, 'cache bytes\n');
  const before = statSync(cache).mtimeMs;
  symlinkSync(cache, donor.info);
  seedInto(f, donor, staging);
  assert.equal(readFileSync(staging.info, 'utf8'), 'cache bytes\n');
  assert.notEqual(realpathSync(staging.info), cache);
  assert.equal(statSync(cache).mtimeMs, before);
  const noCache = project(f, 'no-cache');
  const emptyStaging = project(f, 'empty-staging');
  seedInto(f, noCache, emptyStaging);
  assert.equal(existsSync(emptyStaging.info), false);
});

function runFrontend(f, staging, extraEnv = {}, donorDir = '') {
  const privateTmp = join(f.dir, 'D');
  mkdirSync(privateTmp, { recursive: true });
  const scriptDir = join(f.dir, 'controller scripts');
  mkdirSync(join(scriptDir, 'lib'), { recursive: true });
  copyFileSync(timer, join(scriptDir, 'lib/v5-selfhost-tsc-timer.cjs'));
  const script = `
SCRIPT_DIR=${q(scriptDir)}
staging=${q(staging.dir)}
MASTER_GATE_TMPDIR=${q(privateTmp)}
full_sha=${q('a'.repeat(40))}
donor=${q(donorDir)}
WEB_DIST_REUSE_RECORD=.web-dist-reuse.json
mlog() { echo "$*" >&2; }
master_web_dist_key() { :; }
write_web_dist_reuse_record() { :; }
${seed}
${frontend}
master_job_frontend
`;
  return spawnSync('/bin/bash', ['-euo', 'pipefail', '-c', script], {
    cwd: staging.dir, env: { ...f.env, ...extraEnv }, encoding: 'utf8', timeout: 20_000,
  });
}

test('the original npm build seeds B donor and records only tsc time with spaces in controller and staging paths', (t) => {
  const f = fixture(t);
  const donor = project(f, 'donor');
  const staging = project(f, 'staging');
  assertPass(compile(f, donor));
  const before = donorState(donor);
  change(staging, 'export const answer: number = 43;\n');
  const vite = join(staging.dir, 'node_modules/.bin/vite');
  writeFileSync(vite, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.TIMER_SNAPSHOT, fs.readFileSync(process.env.OC_V5_SELFHOST_TSC_TIMER_FILE));
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 650);
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/index.html', '<meta name="oc-build" content="0123456789abcdef">');
`);
  chmodSync(vite, 0o755);
  const snapshot = join(f.dir, 'tsc-at-vite-start');
  const start = process.hrtime.bigint();
  assertPass(runFrontend(f, staging, { TIMER_SNAPSHOT: snapshot }, donor.dir));
  const wall = Number(process.hrtime.bigint() - start) / 1e9;
  const recorded = readFileSync(join(f.dir, 'D/frontend-tsc-sec'), 'utf8');
  assert.equal(recorded, readFileSync(snapshot, 'utf8'), 'npm and Vite must not overwrite the compiler measurement');
  const seconds = Number(recorded);
  assert.ok(Number.isFinite(seconds) && seconds > 0, recorded);
  assert.ok(wall - seconds >= 0.6, `wall=${wall}, tsc=${seconds}: Vite delay must be excluded`);
  assert.equal(readFileSync(join(f.dir, 'D/frontend.result'), 'utf8').trim().split(' ')[2], recorded.trim());
  assert.notEqual(statSync(staging.info).ino, before.ino);
  assert.deepEqual(donorState(donor), before);
});

test('the tsc timer records compiler failures and never changes their exit status', (t) => {
  const f = fixture(t);
  const staging = project(f, 'staging');
  change(staging, 'export const answer: number = "wrong";\n');
  const uninstrumented = compile(f, staging);
  rmSync(staging.info, { force: true });
  const metric = join(f.dir, 'failed-tsc-sec');
  const instrumented = compile(f, staging, {
    NODE_OPTIONS: `--require="${timer}"`, OC_V5_SELFHOST_TSC_TIMER_FILE: metric,
  });
  assert.notEqual(uninstrumented.status, 0);
  assert.equal(instrumented.status, uninstrumented.status, instrumented.stdout + instrumented.stderr);
  assert.match(instrumented.stdout + instrumented.stderr, /TS2322/);
  assert.ok(Number(readFileSync(metric, 'utf8')) > 0);

  change(staging, 'export const answer: number = 44;\n');
  rmSync(staging.info, { force: true });
  assertPass(compile(f, staging, {
    NODE_OPTIONS: `--require="${timer}"`, OC_V5_SELFHOST_TSC_TIMER_FILE: join(f.dir, 'absent', 'metric'),
  }));
});
