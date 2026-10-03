import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = readFileSync(path.join(root, 'scripts/with-production-mutation-lease.sh'), 'utf8');
const sha = text => createHash('sha256').update(text).digest('hex');
const reports = [];
function functions(text) {
  return ['process_state_start', 'same_live_process', 'same_supervised_process'].map(name => {
    const match = text.match(new RegExp(name + '\\(\\) \\{[^\\n]*\\n[\\s\\S]*?\\n\\}'));
    assert.ok(match, 'must execute actual function source ' + name);
    return match[0];
  }).join('\n');
}
let actualFunctions = functions(source);
const sourceFunctionSha = sha(actualFunctions);
let transformCount = 0;
if (process.env.OC_V5_PROCESS_IDENTITY_READ_RED === '1') {
  const needle = "read -r -d '' raw";
  assert.equal(actualFunctions.split(needle).length - 1, 1);
  actualFunctions = actualFunctions.replace(needle, 'read -r raw');
  transformCount = 1;
}
function kernelOracle(state, start) {
  return { state, start, parseRc: 0, liveRc: ['Z', 'X', 'x'].includes(state) ? 1 : 0, supervisedRc: ['Z', 'X', 'x', 'T', 't'].includes(state) ? 1 : 0 };
}
function stat(pid) {
  const parts = readFileSync('/proc/' + pid + '/stat', 'utf8').split(') ').at(-1).split(' ');
  return { state: parts[0], start: parts[19] };
}
function probe(fns, pid, start) {
  const out = spawnSync('bash', ['-c', fns + '\nset +e\nprocess_state_start ' + pid + '\nprintf "PARSE_RC=%s\\n" "$?"\nsame_live_process ' + pid + ' ' + start + '\nprintf "LIVE_RC=%s\\n" "$?"\nsame_supervised_process ' + pid + ' ' + start + '\nprintf "SUPERVISED_RC=%s\\n" "$?"\n'], { encoding: 'utf8', timeout: 2000 });
  assert.equal(out.status, 0, out.stderr);
  const identity = out.stdout.match(/^([A-Za-z]) ([0-9]+)$/m);
  return { state: identity?.[1] || null, start: identity?.[2] || null, parseRc: Number(out.stdout.match(/PARSE_RC=(\d+)/)[1]), liveRc: Number(out.stdout.match(/LIVE_RC=(\d+)/)[1]), supervisedRc: Number(out.stdout.match(/SUPERVISED_RC=(\d+)/)[1]) };
}
async function until(predicate, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.fail('actual process state did not settle');
}
async function named(name, zombie = false) {
  const program = 'import ctypes,os,sys,json\nctypes.CDLL(None).prctl(15,sys.argv[1].encode(),0,0,0)\n' + (zombie ? 'pid=os.fork()\nif pid==0: os._exit(0)\n' : 'pid=os.getpid()\n') + 'print(json.dumps({"pid":pid}),flush=True)\nsys.stdin.buffer.read()\n' + (zombie ? 'os.waitpid(pid,0)\n' : '');
  const child = spawn('python3', ['-c', program, name], { stdio: ['pipe', 'pipe', 'pipe'] });
  const ended = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  let output = '', error = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { error += data; });
  await until(() => output.includes('\n') || child.exitCode !== null);
  assert.equal(child.exitCode, null, error);
  const pid = JSON.parse(output.split('\n')[0]).pid;
  await until(() => { try { return stat(pid).state === (zombie ? 'Z' : 'S'); } catch { return false; } });
  return { child, pid, ended, cleanup: async () => { try { process.kill(pid, 'SIGCONT'); } catch {} child.stdin.end(); await ended; } };
}
function record(value) {
  reports.push(value);
  if (process.env.OC_PROC_REPORT) writeFileSync(process.env.OC_PROC_REPORT, JSON.stringify({ actualSourceSha: sha(source), sourceFunctionSha, consumedFunctionSha: sha(actualFunctions), transformCount, cases: reports }, null, 2));
}
for (const name of ['lease-probe', 'lease probe', 'lease) probe', 'lease\nprobe']) {
  test('whole actual proc record matches independent kernel oracle for comm ' + JSON.stringify(name), async () => {
    const fx = await named(name);
    try {
      const real = stat(fx.pid), previous = kernelOracle(real.state, real.start), next = probe(actualFunctions, fx.pid, real.start);
      assert.deepEqual(next, previous);
      assert.equal(next.state, 'S'); assert.equal(next.start, real.start); assert.equal(next.parseRc, 0); assert.equal(next.liveRc, 0); assert.equal(next.supervisedRc, 0);
      assert.equal(probe(actualFunctions, fx.pid, '1').liveRc, 1, 'fresh reads must reject a mismatched starttime');
      record({ name, pid: fx.pid, kernel: real, previous, next, wrongStartRejected: true });
    } finally { await fx.cleanup(); }
  });
}
test('actual STOP is live but not supervised, with unchanged starttime', async () => {
  const fx = await named('lease\n) probe');
  try {
    const start = stat(fx.pid).start;
    process.kill(fx.pid, 'SIGSTOP'); await until(() => stat(fx.pid).state === 'T');
    const previous = kernelOracle('T', start), next = probe(actualFunctions, fx.pid, start);
    assert.deepEqual(next, previous); assert.equal(next.state, 'T'); assert.equal(next.start, start); assert.equal(next.liveRc, 0); assert.equal(next.supervisedRc, 1);
    record({ scenario: 'actual-STOP', pid: fx.pid, previous, next });
  } finally { await fx.cleanup(); }
});
test('actual unreaped zombie is rejected by live/supervised checks', async () => {
  const fx = await named('lease-zombie', true);
  try {
    const real = stat(fx.pid), previous = kernelOracle(real.state, real.start), next = probe(actualFunctions, fx.pid, real.start);
    assert.deepEqual(next, previous); assert.equal(next.state, 'Z'); assert.equal(next.liveRc, 1); assert.equal(next.supervisedRc, 1);
    record({ scenario: 'actual-zombie', pid: fx.pid, previous, next });
  } finally { await fx.cleanup(); }
});
test('missing proc record is fail-closed', () => {
  const pid = 2147483647; assert.equal(existsSync('/proc/' + pid + '/stat'), false);
  const previous = { state: null, start: null, parseRc: 1, liveRc: 1, supervisedRc: 1 }, next = probe(actualFunctions, pid, '1');
  assert.deepEqual(next, previous); assert.equal(next.parseRc, 1); assert.equal(next.liveRc, 1); assert.equal(next.supervisedRc, 1); assert.equal(next.state, null);
  record({ scenario: 'missing-PID', previous, next });
});

test('same shell direct output stays fresh across live, missing and STOP, with no extra stdout', async () => {
  const fx = await named('lease\n) probe');
  try {
    const real = stat(fx.pid);
    const program = actualFunctions + `
state=old; start=old
process_state_start ${fx.pid} state start
printf 'LIVE_RC=%s STATE=%s START=%s\\n' "$?" "$state" "$start"
process_state_start 2147483647 state start
printf 'MISSING_RC=%s STATE=%s START=%s\\n' "$?" "$state" "$start"
kill -STOP ${fx.pid}
for i in {1..200}; do process_state_start ${fx.pid} state start || exit 2; [[ "$state" == T ]] && break; sleep 0.01; done
printf 'STOP_STATE=%s START=%s\\n' "$state" "$start"
same_live_process ${fx.pid} 1; printf 'WRONG_START_RC=%s\\n' "$?"
process_state_start ${fx.pid}
kill -CONT ${fx.pid}
`;
    const out = spawnSync('bash', ['-c', program], { encoding:'utf8', timeout:5000 });
    assert.equal(out.status,0,out.stderr);
    assert.equal(out.stdout, `LIVE_RC=0 STATE=S START=${real.start}\nMISSING_RC=1 STATE= START=\nSTOP_STATE=T START=${real.start}\nWRONG_START_RC=1\nT ${real.start}\n`,'direct calls must not emit stdout or retain stale output after a missing PID');
    record({scenario:'same-shell-direct-live-missing-STOP',pid:fx.pid,start:real.start,output:out.stdout,noExtraStdout:true,missingClearedBothOutputs:true});
  } finally { await fx.cleanup(); }
});
