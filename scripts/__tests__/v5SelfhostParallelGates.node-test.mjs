import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const lib = readFileSync(join(root, 'scripts/v5-selfhost-master-release-lib.sh'), 'utf8');
const q = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const fn = (name) => {
  const m = lib.match(new RegExp(`^${name}\\(\\) \\{[^\\n]*\\n[\\s\\S]*?^\\}`, 'm'));
  assert.ok(m, name);
  return m[0];
};
const build = fn('build_master_release');
const gates = build.slice(build.indexOf('  # P3:'), build.indexOf('  tsum_mark P.mcp-bundle'));

function fixture(t, load = '0.00') {
  const dir = mkdtempSync(join(tmpdir(), 'oc-parallel-gates-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const sub of ['tmp', 'logs', 'bin', 'staging/scripts/lib', 'staging/packages/web-react']) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  writeFileSync(join(dir, 'load'), `${load} 0 0 1/1 1\n`);
  for (const name of ['check-architecture.ts', 'v5-selfhost-watch-gate.sh', 'lib/gateTestDb.mjs',
    'check-v5-box-success-recovery.ts', 'check-v5-box-continuation.ts', 'check-v5-box-incident-proofs.ts']) {
    writeFileSync(join(dir, 'staging/scripts', name), 'fixture\n');
  }
  return { dir, env: { PATH: `${join(dir, 'bin')}:${process.env.PATH}`, HOME: dir,
    TMPDIR: join(dir, 'tmp'), LC_ALL: 'C.UTF-8', EVENTS: join(dir, 'events') } };
}

function prelude(f) {
  return `
source ${q(join(root, 'scripts/lib/v5-selfhost-build-jobs.sh'))}
source ${q(join(root, 'scripts/lib/v5-selfhost-train-summary.sh'))}
MASTER_GATE_TMPDIR=${q(join(f.dir, 'tmp'))}
MASTER_GATE_LOADAVG=${q(join(f.dir, 'load'))}
MASTER_GATE_ATTEMPT_DIR=${q(join(f.dir, 'logs'))}
MASTER_BOX_GATE_LOAD_MAX=8
MASTER_GATE_IDLE_TIMEOUT_S=20
OC_V5_TRAIN_SUMMARY_DIR=${q(join(f.dir, 'logs'))}
LEASE_TRAIN_ID=tr-parallel-test
mlog() { echo "$*" >&2; }
${['master_gate_load1', 'master_gate_attempt_log', 'master_gate_first_failure'].map(fn).join('\n')}
tsum_init
trap 'rc=$?; reap_master_build_jobs; tsum_finish "$rc"' EXIT
event() { printf '%s\n' "$*" >>"$EVENTS"; }
`;
}

function run(f, body) {
  return spawnSync('/bin/bash', ['-Eeuo', 'pipefail', '-c', prelude(f) + body], {
    env: f.env, cwd: f.dir, encoding: 'utf8', timeout: 40_000,
  });
}
const events = (f) => readFileSync(f.env.EVENTS, 'utf8').trim().split('\n');
const notes = (f) => JSON.parse(readFileSync(join(f.dir, 'logs/tr-parallel-test.summary.json'), 'utf8')).notes;

for (const [load, count] of [['0.00', 3], ['4.00', 2], ['7.99', 2]]) {
  test(`load ${load}: fills ${count} slots, overlaps jobs, reaps before reusing a slot`, (t) => {
    const f = fixture(t, load);
    const r = run(f, `
task() {
  local id="\${MASTER_GATE_TMPDIR##*/}"
  event "start $id"
  touch "$TMPDIR/../started-$id"
  if [[ "$id" != last ]]; then
    until (( $(find "$TMPDIR/.." -maxdepth 1 -name 'started-*' | wc -l) >= ${count} )); do sleep .01; done
  fi
  sleep .05
  event "end $id"
}
for id in ${Array.from({ length: count }, (_, i) => `j${i}`).join(' ')} last; do master_build_job_start "$id" task; done
master_build_jobs_wait
event drained
`);
    assert.equal(r.status, 0, r.stderr);
    const lines = events(f);
    assert.equal(lines.slice(0, count).filter((l) => l.startsWith('start ')).length, count);
    assert.ok(lines.indexOf('start last') > lines.findIndex((l) => l.startsWith('end ')));
    let active = 0;
    for (const line of lines) {
      if (line.startsWith('start ')) active++;
      if (line.startsWith('end ')) active--;
      assert.ok(active <= count && active >= 0, lines.join('\n'));
    }
    assert.equal(active, 0);
    assert.equal(notes(f)['job.last.rc'], '0');
    assert.equal(notes(f)['job.last.slots'], String(count));
  });
}

test('admission re-reads load; busy/unreadable load times out without launching', (t) => {
  const f = fixture(t, '8.00');
  const r = run(f, `
task() { event ran; }
(sleep .1; echo '1.00 0 0 1/1 1' >"$MASTER_GATE_LOADAVG") & changer=$!
master_build_job_start low task
master_build_jobs_wait
wait "$changer"
rm "$MASTER_GATE_LOADAVG"
MASTER_GATE_IDLE_TIMEOUT_S=0
if master_build_job_start unreadable task; then exit 99; fi
`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(events(f), ['ran']);
  assert.equal(notes(f)['job.low.slots'], '3');
  assert.match(r.stderr, /unreadable.*未启动/);
});

test('failure stops admission; cleanup drains owned workers and grandchildren without touching unrelated work', (t) => {
  const f = fixture(t);
  const r = run(f, `
slow() { /bin/bash -c 'sleep .3; test -d "$TMPDIR"; echo grandchild-done >>"$EVENTS"'; event slow-done; }
bad() { until [[ -f "$TMPDIR/../slow-started" ]]; do sleep .01; done; return 23; }
later() { event forbidden; }
(until [[ -f "$EVENTS.release-unrelated" ]]; do sleep .01; done; event unrelated-done) & unrelated=$!
master_build_job_start slow slow
touch "$MASTER_GATE_TMPDIR/slow-started"
master_build_job_start bad bad
until ! master_build_jobs_poll; do sleep .01; done
if master_build_job_start later later; then exit 99; fi
reap_master_build_jobs
event cleanup
rm -rf "$MASTER_GATE_TMPDIR"
touch "$EVENTS.release-unrelated"
wait "$unrelated"
`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(events(f), ['grandchild-done', 'slow-done', 'cleanup', 'unrelated-done']);
  assert.equal(notes(f)['job.bad.rc'], '23');
  assert.equal(notes(f)['job.slow.rc'], '0');
});

test('signal exit is a gate failure and inherited deploy EXIT trap stays parent-only', (t) => {
  const f = fixture(t);
  const r = run(f, `
trap 'rc=$?; reap_master_build_jobs; event parent-exit; tsum_finish "$rc"' EXIT
signalled() { /bin/bash -c 'kill -TERM "$BASHPID"'; }
master_build_job_start signalled signalled
if master_build_jobs_wait; then exit 99; fi
`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(events(f), ['parent-exit']);
  assert.equal(notes(f)['job.signalled.rc'], '143');
});

test('parent TERM exit drains its workers before EXIT cleanup', async (t) => {
  const f = fixture(t);
  const child = spawn('/bin/bash', ['-Eeuo', 'pipefail', '-c', `${prelude(f)}
trap 'exit 143' TERM
trap 'rc=$?; reap_master_build_jobs; event cleanup; exit "$rc"' EXIT
task() { event started; sleep .2; event done; }
master_build_job_start slow task
while :; do sleep .05; done
`], { env: f.env, stdio: 'ignore' });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  for (let i = 0; i < 200 && !existsSync(f.env.EVENTS); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(existsSync(f.env.EVENTS));
  child.kill('SIGTERM');
  assert.equal(await exited, 143);
  assert.deepEqual(events(f), ['started', 'done', 'cleanup']);
});

// Execute the real build's entire C/D + Box section with fake gate executables.
// No real gate, database, runtime/frontend build, release or shared lock is run.
function wireFixture(f, failure = '') {
  const runner = `#!/bin/bash
set -eu
id="\${TMPDIR##*/}"
case "$*" in
  *check-v5-box-success-recovery.ts*) id=C.box-success-recovery ;;
  *check-v5-box-continuation.ts*) id=C.box-continuation ;;
  *check-v5-box-incident-proofs.ts*) id=C.box-incident-proofs ;;
  *check-v5-ccb-mcp-availability.ts*) id=C.ccb-mcp ;;
esac
printf 'start %s %s %s\\n' "$id" "$PWD" "$TMPDIR" >>"$EVENTS"
touch "$EVENTS.started-$id"
if [[ "$id" == C.session-rootfix || "$id" == C.watch-gate || "$id" == D ]]; then
  until [[ -f "$EVENTS.started-C.session-rootfix" && -f "$EVENTS.started-C.watch-gate" && -f "$EVENTS.started-D" ]]; do sleep .01; done
fi
if [[ "$id" == ${q(failure || 'never')} ]]; then echo '[gate-failure] fixture failed'; exit 17; fi
case "$id" in
  D) mkdir -p packages/web-react/dist; echo '<meta name="oc-build" content="0123456789abcdef">' >packages/web-react/dist/index.html ;;
  C.architecture) echo '{}' >"$TMPDIR/architecture.json" ;;
esac
printf 'end %s\\n' "$id" >>"$EVENTS"
`;
  for (const name of ['npx', 'node', 'bash', 'npm']) {
    const path = join(f.dir, 'bin', name);
    writeFileSync(path, runner);
    chmodSync(path, 0o755);
  }
  return `
staging=${q(join(f.dir, 'staging'))}
full_sha=${q('a'.repeat(40))}
MASTER_GATE_DB_URL='fixture-private-database'
MASTER_GATE_LOAD_SCALE=1
WEB_DIST_REUSE_RECORD=.web-dist-reuse.json
master_web_dist_key() { :; }
write_web_dist_reuse_record() { event web-record; }
master_note_architecture() { test -s "$1"; event architecture-read; }
master_gate_wait_host_idle() { event "idle $1"; }
master_gate_db_create() { event db-create; }
master_gate_db_drop() { event db-drop; }
master_gate_retryable() { shift; "$@"; }
cleanup_master_gate_tmpdir() { event tmp-cleanup; }
cleanup_master_staging() { reap_master_build_jobs; event cleanup; }
die() { echo "$*" >&2; exit 73; }
# Runtime waits until a C job starts: overlap is proven without elapsed-time assumptions.
(until [[ -f "$EVENTS.started-C.session-rootfix" ]]; do sleep .01; done; event runtime-done) & rt=$!
await_runtime_release_bg() { wait "$rt"; event runtime-awaited; }
run_gates() {
${gates}
event "seal $MASTER_FRONTEND_MODE"
}
run_gates
`;
}

test('production wiring: all 15 C gates + D run pinned; C/D overlap; Box waits for every job and runtime', (t) => {
  const f = fixture(t);
  const r = run(f, wireFixture(f));
  assert.equal(r.status, 0, r.stderr);
  const lines = events(f);
  const starts = lines.filter((l) => l.startsWith('start '));
  const ids = starts.map((l) => l.split(' ')[1]);
  const expected = ['session-rootfix', 'watch-gate', 'cursor-sand', 'delegate-billing', 'callback-ws',
    'cron-submit', 'prompt-privacy', 'system-approval', 'system-executor', 'host-log-policy', 'architecture',
    'box-success-recovery', 'box-continuation', 'box-incident-proofs', 'ccb-mcp'].map((id) => `C.${id}`);
  assert.deepEqual([...ids].sort(), [...expected, 'D'].sort());
  const firstEnd = lines.findIndex((l) => l.startsWith('end '));
  assert.equal(lines.slice(0, firstEnd).filter((l) => l.startsWith('start ')).length, 3);
  const awaited = lines.indexOf('runtime-awaited');
  const box = lines.findIndex((l) => l.startsWith('start C.box-success-recovery '));
  assert.ok(awaited < box && lines.indexOf('idle box-gates') > awaited);
  for (const id of expected.filter((id) => !id.startsWith('C.box-') && id !== 'C.ccb-mcp').concat('D')) {
    assert.ok(lines.indexOf(`end ${id}`) < awaited, id);
  }
  let active = 0;
  for (const line of lines) {
    if (line.startsWith('start ')) {
      const [, id, cwd, temp] = line.split(' ');
      assert.equal(cwd, join(f.dir, 'staging'));
      active++;
      assert.ok(active <= (id.startsWith('C.box-') || id === 'C.ccb-mcp' ? 1 : 3));
      assert.ok(temp.startsWith(join(f.dir, 'tmp')));
      if (!id.startsWith('C.box-') && id !== 'C.ccb-mcp') assert.equal(temp, join(f.dir, 'tmp', id));
    }
    if (line.startsWith('end ')) active--;
  }
  assert.equal(active, 0);
  assert.ok(lines.indexOf('db-drop') < lines.findIndex((l) => l.startsWith('start C.ccb-mcp ')));
  assert.equal(lines.at(-1), 'seal built');
  for (const id of ids.filter((id) => !id.startsWith('C.box-') && id !== 'C.ccb-mcp')) {
    assert.equal(notes(f)[`job.${id}.rc`], '0', id);
    assert.ok(existsSync(notes(f)[`job.${id}.log`]), id);
  }
});

for (const failure of ['C.session-rootfix', 'D', 'C.architecture']) {
  test(`production wiring: ${failure} failure blocks Box and seal, preserving failure log`, (t) => {
    const f = fixture(t);
    const r = run(f, wireFixture(f, failure));
    assert.equal(r.status, 73, r.stderr);
    const lines = events(f);
    assert.ok(!lines.some((l) => l.startsWith('start C.box-') || l.startsWith('seal ')), lines.join('\n'));
    assert.match(readFileSync(notes(f)[`job.${failure}.log`], 'utf8'), /fixture failed/);
    assert.equal(notes(f)[`job.${failure}.rc`], '1');
    assert.equal(lines.at(-1), 'cleanup');
  });
}
