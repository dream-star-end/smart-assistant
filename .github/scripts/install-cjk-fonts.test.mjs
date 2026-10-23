import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url));
const helper = readFileSync(join(root, 'install-cjk-fonts.sh'), 'utf8');
const sources = `Types: deb
URIs: mirror+file:/etc/apt/apt-mirrors.txt
Suites: noble noble-updates noble-backports
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: mirror+file:/etc/apt/apt-mirrors.txt
Suites: noble-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
`;
const stub = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
const cmd = basename(process.argv[1]);
const args = process.argv.slice(2);
const scenario = process.env.FONT_CASE;
const sourceArg = args.find(a => a.startsWith('Dir::Etc::sourcelist='));
const source = sourceArg ? readFileSync(sourceArg.slice(sourceArg.indexOf('=') + 1), 'utf8') : null;
appendFileSync(join(process.env.FONT_CASE_DIR, 'calls.jsonl'), JSON.stringify({cmd,args,source}) + '\\n');
const invoke = (argv) => { const r = spawnSync(argv[0], argv.slice(1), {stdio:'inherit'}); process.exit(r.status ?? 1); };
if (cmd === 'timeout') invoke(args.slice(2));
if (cmd === 'sudo') invoke(args[0] === '-n' ? args.slice(1) : args);
if (cmd === 'apt-cache') { console.log('  Candidate: 1:20230817+repack1-3'); process.exit(0); }
if (cmd === 'apt-get') {
  if (scenario === 'signature' && args.includes('update')) process.exit(100);
  if (scenario === 'update-primary-fails' && args.includes('update') && !sourceArg) process.exit(100);
  if (args.includes('--download-only')) {
    if (scenario === 'corrupt' || scenario === 'both-fail') process.exit(100);
    if (!['primary','update-primary-fails'].includes(scenario) && !sourceArg) process.exit(124);
  }
  process.exit(0);
}
if (cmd === 'dpkg-query') {
  console.log(args.some(a => a.includes('Version')) ? '1:20230817+repack1-3' : scenario === 'missing-package' ? 'unpacked' : 'installed');
  process.exit(0);
}
if (cmd === 'fc-match') { console.log(scenario === 'missing-font' ? 'DejaVu Sans' : 'Noto Sans CJK SC'); process.exit(0); }
process.exit(99);
`;

function runCase(scenario, input = sources, actions = 'true') {
  const dir = mkdtempSync(join(tmpdir(), 'oc-font-helper-test-'));
  try {
    const bin = join(dir, 'bin'); mkdirSync(bin); mkdirSync(join(dir, 'runner'));
    const inputPath = join(dir, 'ubuntu.sources'); writeFileSync(inputPath, input);
    // Only map the fixed runner source path into this private fixture view.
    assert.equal(helper.split('/etc/apt/sources.list.d/ubuntu.sources').length, 2);
    const script = join(dir, 'install.sh'); writeFileSync(script, helper.replace('/etc/apt/sources.list.d/ubuntu.sources', inputPath));
    writeFileSync(join(bin, 'fake.mjs'), stub); chmodSync(join(bin, 'fake.mjs'), 0o755);
    for (const name of ['sudo', 'timeout', 'apt-get', 'apt-cache', 'dpkg-query', 'fc-match']) symlinkSync('fake.mjs', join(bin, name));
    const r = spawnSync('bash', [script], {encoding:'utf8', timeout:10000, env:{...process.env, PATH:`${bin}:${process.env.PATH}`, GITHUB_ACTIONS:actions, RUNNER_TEMP:join(dir,'runner'), FONT_CASE:scenario, FONT_CASE_DIR:dir}});
    const calls = readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s));
    assert.equal(readFileSync(inputPath, 'utf8'), input, 'original runner sources stay byte-identical');
    return { ...r, calls };
  } finally { rmSync(dir, {recursive:true, force:true}); }
}

function downloads(r) { return r.calls.filter(c => c.cmd === 'apt-get' && c.args.includes('--download-only')); }
function installs(r) { return r.calls.filter(c => c.cmd === 'apt-get' && c.args.includes('--no-download')); }

test('CJK primary success retains exact version and does not switch sources', () => {
  const r = runCase('primary'); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /CJK_FONTS_READY/);
  assert.equal(downloads(r).length, 1); assert.equal(downloads(r)[0].source, null);
  assert.equal(installs(r).length, 1); assert.ok(installs(r)[0].args.includes('fonts-noto-cjk=1:20230817+repack1-3'));
  assert.ok(r.calls.filter(c => c.cmd === 'timeout').every(c => ['60s','120s'].includes(c.args[1])));
});

test('CJK timeout switches mirror+file once and preserves suites components and signature scope', () => {
  const r = runCase('timeout'); assert.equal(r.status, 0, r.stderr); assert.equal(downloads(r).length, 2);
  const fallback = downloads(r)[1]; assert.ok(fallback.source); assert.doesNotMatch(fallback.source, /mirror\+file|azure/);
  assert.match(fallback.source, /URIs: https:\/\/archive\.ubuntu\.com\/ubuntu/);
  assert.match(fallback.source, /URIs: https:\/\/security\.ubuntu\.com\/ubuntu/);
  for (const field of ['Suites','Components','Signed-By']) assert.deepEqual(fallback.source.split('\n').filter(s => s.startsWith(`${field}:`)), sources.split('\n').filter(s => s.startsWith(`${field}:`)));
  assert.ok(fallback.args.includes('Dir::Etc::sourceparts=-')); assert.equal(installs(r).length, 1);
});

test('CJK primary update failure cannot continue into a successful stale-cache download', () => {
  const r = runCase('update-primary-fails'); assert.equal(r.status, 0, r.stderr);
  const updates = r.calls.filter(c => c.cmd === 'apt-get' && c.args.includes('update'));
  assert.equal(updates.length, 2, 'failed primary update must switch sources before candidate/download');
  assert.equal(downloads(r).length, 1); assert.ok(downloads(r)[0].source);
});

for (const scenario of ['both-fail','signature','corrupt','missing-package','missing-font']) {
  test(`CJK prerequisite remains a failure: ${scenario}`, () => {
    const r = runCase(scenario); assert.notEqual(r.status, 0); assert.doesNotMatch(r.stdout, /CJK_FONTS_READY/);
    if (['both-fail','signature','corrupt'].includes(scenario)) assert.equal(installs(r).length, 0);
    assert.ok(downloads(r).length <= 2);
  });
}

test('CJK fallback rejects an unrecognized source without changing the runner file', () => {
  const r = runCase('timeout', sources.replaceAll('mirror+file:/etc/apt/apt-mirrors.txt', 'https://unrecognized.invalid/ubuntu'));
  assert.notEqual(r.status, 0); assert.equal(downloads(r).length, 1); assert.equal(installs(r).length, 0);
});
