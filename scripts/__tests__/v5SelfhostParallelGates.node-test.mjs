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
source ${q(join(root, 'scripts/lib/v5-selfhost-gate-receipts.sh'))}
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
await_file() {
  local began="$SECONDS"
  until [[ -f "$1" ]]; do
    (( SECONDS - began < 10 )) || return 1
    sleep .01
  done
}
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

test('a terminated worker shell retains ownership until its surviving command exits', (t) => {
  const f = fixture(t);
  const r = run(f, `
task() {
  /bin/bash -c 'echo descendant-started >>"$EVENTS"; touch "$EVENTS.ready";
    until test -f "$EVENTS.signalled"; do sleep .01; done
    sleep .2; test -d "$TMPDIR"; echo descendant-done >>"$EVENTS"; touch "$EVENTS.done"'
}
before="$-"
master_build_job_start signalled task
[[ "$-" == "$before" ]] || exit 98
until [[ -f "$EVENTS.ready" ]]; do sleep .01; done
worker="\${MASTER_BUILD_JOB_PIDS[0]}"
kill -TERM "$worker"
touch "$EVENTS.signalled"
reap_master_build_jobs
event cleanup
until [[ -f "$EVENTS.done" ]]; do sleep .01; done
[[ "$MASTER_BUILD_JOB_FAILED" == 1 ]]
[[ "\${#MASTER_BUILD_JOB_PIDS[@]}" == 0 ]]
`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(events(f), ['descendant-started', 'descendant-done', 'cleanup']);
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
`], { env: f.env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  for (let i = 0; i < 200 && !existsSync(f.env.EVENTS); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(existsSync(f.env.EVENTS));
  child.kill('SIGTERM');
  assert.equal(await exited, 143, stderr);
  assert.deepEqual(events(f), ['started', 'done', 'cleanup']);
});

test('admission summary keeps the exact budget sample even if load changes immediately', (t) => {
  const f = fixture(t);
  const r = run(f, `
master_gate_load1() { cat "$MASTER_GATE_LOADAVG"; echo 8.00 >"$MASTER_GATE_LOADAVG"; }
echo 0.00 >"$MASTER_GATE_LOADAVG"
task() { event ran; }
master_build_job_start sample task
master_build_jobs_wait
`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(events(f), ['ran']);
  assert.equal(notes(f)['job.sample.load1'], '0.00');
  assert.equal(notes(f)['job.sample.slots'], '3');
  assert.match(notes(f)['job.sample.pgid'], /^[1-9][0-9]*$/);
  assert.equal(notes(f)['job.sample.tmpdir'], join(f.dir, 'tmp/sample'));
});

for (const load of ['8.00', '99.00', 'garbage', '-1', 'NaN']) {
  test(`load ${load}: timeout latches failure and cannot admit after recovery`, (t) => {
    const f = fixture(t, load);
    const r = run(f, `
MASTER_GATE_IDLE_TIMEOUT_S=0
sleep() { event forbidden-sleep; return 1; }
task() { event forbidden; }
if master_build_job_start blocked task; then exit 90; fi
echo '0.00 0 0 1/1 1' >"$MASTER_GATE_LOADAVG"
if master_build_job_start later task; then exit 91; fi
event rejected
`);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(events(f), ['rejected']);
    assert.equal(notes(f)['job.blocked.admissionFailure'], 'admission-timeout');
    // A zero budget forbids retry sleep; sampling itself can cross a wall-clock second.
    assert.match(notes(f)['job.blocked.admissionWaitSec'], /^[0-9]+$/);
    assert.equal(notes(f)['job.blocked.pgid'], undefined);
  });
}

for (const budget of ['return 2', 'echo 99', 'echo invalid']) {
  test(`unverifiable slot budget (${budget}) admits nothing`, (t) => {
    const f = fixture(t);
    const r = run(f, `
master_build_job_limit() { ${budget}; }
MASTER_GATE_IDLE_TIMEOUT_S=0
task() { event forbidden; }
if master_build_job_start blocked task; then exit 90; fi
event rejected
`);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(events(f), ['rejected']);
    assert.equal(notes(f)['job.blocked.admissionFailure'], 'admission-timeout');
  });
}

for (const kind of ['log', 'tmpdir']) {
  test(`${kind} setup failure blocks later admission and drains already admitted work`, (t) => {
    const f = fixture(t);
    const r = run(f, `
task() { event started; await_file "$EVENTS.release"; test -d "$TMPDIR"; event done; }
master_build_job_start owned task
await_file "$EVENTS"
${kind === 'log' ? 'master_gate_attempt_log() { return 1; }' : 'mkdir "$MASTER_GATE_TMPDIR/blocked"'}
if master_build_job_start blocked task; then exit 90; fi
${kind === 'log' ? fn('master_gate_attempt_log') : 'rmdir "$MASTER_GATE_TMPDIR/blocked"'}
if master_build_job_start later task; then touch "$EVENTS.release"; exit 91; fi
touch "$EVENTS.release"
reap_master_build_jobs
event cleanup
`);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(events(f), ['started', 'done', 'cleanup']);
    assert.equal(notes(f)['job.blocked.admissionFailure'], `${kind}-setup`);
    assert.equal(notes(f)['job.owned.rc'], '0');
  });
}

test('rising load drains existing work, lowers new admission to two, then pauses at eight until recovery', (t) => {
  const f = fixture(t);
  const r = run(f, `
master_gate_load1() {
  local load rest
  read -r load rest <"$MASTER_GATE_LOADAVG"
  touch "$EVENTS.sample-$load-\${#MASTER_BUILD_JOB_PIDS[@]}"
  printf '%s' "$load"
}
task() {
  local id="\${TMPDIR##*/}"
  event "start $id"
  touch "$EVENTS.started-$id"
  await_file "$EVENTS.release-$id"
  event "end $id"
}
for id in j0 j1 j2; do master_build_job_start "$id" task; done
for id in j0 j1 j2; do await_file "$EVENTS.started-$id"; done
(
  await_file "$EVENTS.sample-4.00-3"
  touch "$EVENTS.release-j0"
  await_file "$EVENTS.sample-4.00-2"
  test ! -e "$EVENTS.started-j3"
  touch "$EVENTS.release-j1"
  await_file "$EVENTS.started-j3"
  await_file "$EVENTS.sample-8.00-2"
  touch "$EVENTS.release-j2" "$EVENTS.release-j3"
  await_file "$EVENTS.sample-8.00-0"
  test ! -e "$EVENTS.started-j4"
  echo '0.00 0 0 1/1 1' >"$MASTER_GATE_LOADAVG"
  touch "$EVENTS.release-j4"
) & controller=$!
echo '4.00 0 0 1/1 1' >"$MASTER_GATE_LOADAVG"
master_build_job_start j3 task
await_file "$EVENTS.started-j3"
echo '8.00 0 0 1/1 1' >"$MASTER_GATE_LOADAVG"
master_build_job_start j4 task
master_build_jobs_wait
wait "$controller"
event drained
`);
  assert.equal(r.status, 0, r.stderr);
  const lines = events(f);
  assert.ok(lines.indexOf('start j3') > lines.indexOf('end j1'), lines.join('\n'));
  assert.ok(lines.indexOf('start j4') > lines.indexOf('end j2'), lines.join('\n'));
  assert.ok(lines.indexOf('start j4') > lines.indexOf('end j3'), lines.join('\n'));
  for (const id of ['j0', 'j1', 'j2', 'j3', 'j4']) assert.equal(notes(f)[`job.${id}.rc`], '0');
  assert.equal(notes(f)['job.j3.slots'], '2');
  assert.equal(notes(f)['job.j4.slots'], '3');
  assert.equal(lines.at(-1), 'drained');
});

test('private TMPDIRs keep identical filenames isolated until both workers finish', (t) => {
  const f = fixture(t);
  const r = run(f, `
task() {
  local id="\${TMPDIR##*/}" other
  [[ "$id" == a ]] && other=b || other=a
  printf '%s' "$id" >"$TMPDIR/shared-name"
  touch "$EVENTS.ready-$id"
  await_file "$EVENTS.ready-$other"
  [[ "$(cat "$TMPDIR/shared-name")" == "$id" ]]
  [[ "$MASTER_GATE_TMPDIR" == "$TMPDIR" ]]
  event "$id verified"
}
master_build_job_start a task
master_build_job_start b task
master_build_jobs_wait
rm -rf "$MASTER_GATE_TMPDIR"
event cleanup
`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(events(f).slice(0, 2).sort(), ['a verified', 'b verified']);
  assert.equal(events(f).at(-1), 'cleanup');
  assert.notEqual(notes(f)['job.a.tmpdir'], notes(f)['job.b.tmpdir']);
  assert.ok(!existsSync(join(f.dir, 'tmp')));
});

for (const monitor of ['+m', '-m']) {
  test(`successful shell with surviving command and failed ps probe retains TMPDIR (set ${monitor})`, (t) => {
    const f = fixture(t);
    const r = run(f, `
set ${monitor}
before="$-"
ps() {
  if [[ ! -f "$EVENTS.probe-ok" ]]; then
    touch "$EVENTS.probe-failed"
    return 1
  fi
  command ps "$@"
}
task() {
  (
    event descendant-started
    touch "$EVENTS.ready"
    await_file "$EVENTS.release"
    test -d "$TMPDIR"
    event descendant-done
  ) &
  await_file "$EVENTS.ready"
  return 0
}
(
  await_file "$EVENTS.probe-failed"
  test -d "$MASTER_GATE_TMPDIR/survivor"
  event probe-recovered
  touch "$EVENTS.probe-ok" "$EVENTS.release"
) & controller=$!
master_build_job_start survivor task
[[ "$before" == "$-" ]]
master_build_jobs_wait
wait "$controller"
rm -rf "$MASTER_GATE_TMPDIR"
event cleanup
`);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(events(f), ['descendant-started', 'probe-recovered', 'descendant-done', 'cleanup']);
    assert.equal(notes(f)['job.survivor.workerRc'], '0');
    assert.equal(notes(f)['job.survivor.rc'], '0');
    assert.match(notes(f)['job.survivor.drainSec'], /^[0-9]+$/);
    assert.match(r.stderr, /pgid=.*TMPDIR 保留/);
  });
}

// Execute the real build's entire C/D + Box section with fake gate executables.
// No real gate, database, runtime/frontend build, release or shared lock is run.
const receiptPhases = {
  'C.session-rootfix': 'session-unavailable-rootfix', 'C.watch-gate': 'watch-gate',
  'C.delegate-billing': 'delegate-billing-requestid', 'C.callback-ws': 'callback-payload-hash',
  'C.cron-submit': 'cron-submit-boundary', 'C.prompt-privacy': 'prompt-privacy-lifecycle',
  'C.system-approval': 'system-approval-fencing', 'C.system-executor': 'system-executor-fencing',
};

function wireFixture(f, failure = '', receipt = 'miss', badDonor = false) {
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
if [[ ${q(receipt)} != hit && ( "$id" == C.session-rootfix || "$id" == C.watch-gate || "$id" == D ) ]]; then
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
${badDonor ? `master_web_dist_key() { echo ${'a'.repeat(64)}; }
find_web_dist_donor() { echo fixture-donor; }
copy_verified_web_dist() { event donor-rejected; touch "$EVENTS.started-D"; return 1; }` : ''}
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
(until [[ -f "$EVENTS.started-D" ]]; do sleep .01; done; event runtime-done) & rt=$!
await_runtime_release_bg() { wait "$rt"; event runtime-awaited; }
${receipt === 'miss' ? '' : `MASTER_GATE_RECEIPT_IDS=${q(Object.values(receiptPhases).join('\n'))}
MASTER_GATE_RECEIPT_SHA=${q((receipt === 'hit' ? 'a' : 'b').repeat(40))}`}
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

for (const receipt of ['hit', 'wrong-sha']) {
  test(`production wiring: receipt ${receipt} preserves local host gates and parent evidence`, (t) => {
    const f = fixture(t);
    const r = run(f, wireFixture(f, '', receipt));
    assert.equal(r.status, 0, r.stderr);
    const lines = events(f);
    const ids = lines.filter((l) => l.startsWith('start ')).map((l) => l.split(' ')[1]);
    for (const [phase, gate] of Object.entries(receiptPhases)) {
      assert.equal(ids.includes(phase), receipt !== 'hit', phase);
      // Worker-local notes would be lost; final summary proves parent ownership.
      assert.equal(notes(f)[`gateEvidence.${gate}`], receipt === 'hit' ? 'merge-queue-receipt' : 'local');
    }
    const local = ['D', 'C.cursor-sand', 'C.host-log-policy', 'C.architecture'];
    for (const phase of local) assert.ok(ids.includes(phase), phase);
    assert.equal(ids.length, receipt === 'hit' ? 8 : 16);
    const awaited = lines.indexOf('runtime-awaited');
    for (const phase of local) assert.ok(lines.indexOf(`end ${phase}`) < awaited, phase);
    for (const phase of ['C.box-success-recovery', 'C.box-continuation', 'C.box-incident-proofs', 'C.ccb-mcp']) {
      assert.ok(lines.findIndex((l) => l.startsWith(`start ${phase} `)) > awaited, phase);
    }
    assert.equal(lines.at(-1), 'seal built');
  });
}

for (const badDonor of [false, true]) {
  test(`production wiring: receipt hit cannot bypass ${badDonor ? 'donor verification' : 'local gate'} failure`, (t) => {
    const f = fixture(t);
    const r = run(f, wireFixture(f, badDonor ? '' : 'C.architecture', 'hit', badDonor));
    assert.equal(r.status, 73, r.stderr);
    const lines = events(f);
    assert.ok(!lines.some((l) => l.startsWith('start C.box-') || l.startsWith('seal ')), lines.join('\n'));
    if (badDonor) assert.ok(lines.includes('donor-rejected'));
    assert.equal(notes(f)[`job.${badDonor ? 'D' : 'C.architecture'}.rc`], '1');
    assert.equal(lines.at(-1), 'cleanup');
  });
}
