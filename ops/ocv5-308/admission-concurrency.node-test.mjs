import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, openSync, closeSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { Client } = createRequire(import.meta.url)('pg');
const dsn = 'postgresql://test:test@127.0.0.1:55432/openclaude_test';
const lockKey = 'openclaude:v5:production-mutation-admission:v1';
assert.equal(process.getuid(), 0, 'requires actual root; never skip or fake the env/holder');
const q = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const report = [];
function record(value) {
  report.push(value);
  if (process.env.OC_ADMISSION_REPORT) writeFileSync(process.env.OC_ADMISSION_REPORT, JSON.stringify(report, null, 2));
}
async function until(predicate, timeout = 6000, label = 'condition') {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.fail(label + ' did not become true within ' + timeout + 'ms');
}
function processIdentity(pid) {
  try {
    const fields = readFileSync('/proc/' + pid + '/stat', 'utf8').split(') ').at(-1).split(' ');
    return { state: fields[0], start: fields[19] };
  } catch { return null; }
}
function live(pid, start) {
  const p = processIdentity(pid);
  return p && p.start === start && !['Z', 'X', 'x'].includes(p.state);
}
function killExact(pid, start) {
  assert.ok(live(pid, start), 'must prove exact live holder identity before signalling');
  process.kill(pid, 'SIGKILL');
}
function descendants(parent) {
  const rows = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const f = readFileSync('/proc/' + entry + '/stat', 'utf8').split(') ').at(-1).split(' ');
      rows.push({ pid: Number(entry), ppid: Number(f[1]), pgid: Number(f[2]), sid: Number(f[3]), start: f[19], state: f[0], command: readFileSync('/proc/' + entry + '/cmdline', 'utf8').split('\0')[0] });
    } catch {}
  }
  const known = new Set([parent]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of rows) if (known.has(p.ppid) && !known.has(p.pid)) { known.add(p.pid); changed = true; }
  }
  return rows.filter(p => p.pid !== parent && known.has(p.pid));
}
function hasLockFd(pid, dev, ino) {
  try {
    return readdirSync('/proc/' + pid + '/fd').some(fd => {
      try { const s = statSync('/proc/' + pid + '/fd/' + fd); return s.dev === dev && s.ino === ino; } catch { return false; }
    });
  } catch { return false; }
}
function fixture(changes = {}, controls = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'v5-admission-race-'));
  const bin = path.join(dir, 'bin'); mkdirSync(bin);
  const lock = path.join(dir, 'mutation.lock');
  const proof = lock + '.admission-nonce';
  const envFile = path.join(dir, 'v5.env');
  const values = { DATABASE_URL: dsn, MODEL_AUTHORITY_DEPLOY_DATABASE_URL: dsn, MODEL_CATALOG_ADMIN_DATABASE_URL: dsn, OC_EGRESS_SECRET: 'e'.repeat(32), ...changes };
  writeFileSync(envFile, Object.entries(values).map(([k, v]) => k + '=' + q(v)).join('\n') + '\n', { mode: 0o600 });
  const holders = path.join(dir, 'holders');
  const stages = path.join(dir, 'real-program-stages');
  const python = spawnSync('bash', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout.trim();
  const psql = spawnSync('bash', ['-c', 'command -v psql'], { encoding: 'utf8' }).stdout.trim();
  assert.ok(path.isAbsolute(python) && path.isAbsolute(psql));
  // Pure observers: exact real argv/stdin/stdout/stderr/exit; never fake PG or parser results.
  writeFileSync(path.join(bin, 'python3'), '#!/bin/bash\n' + q(python) + ' "$@"\nrc=$?\nif [[ "$#" == 4 && "$1" == - ]]; then printf "parser rc=%s\\n" "$rc" >>' + q(stages) + '; fi\nexit "$rc"\n', { mode: 0o755 });
  writeFileSync(path.join(bin, 'psql'), '#!/bin/bash\nerr=$(mktemp)\n' + q(psql) + ' "$@" 2>"$err"\nrc=$?\ncategory=other\n[[ "$rc" != 0 ]] || category=connected\ngrep -q "Connection refused" "$err" && category=refused\nprintf "psql rc=%s category=%s\\n" "$rc" "$category" >>' + q(stages) + '\ncat "$err" >&2\nrm -f "$err"\nexit "$rc"\n', { mode: 0o755 });
  writeFileSync(path.join(bin, 'ssh'), "#!/bin/bash\nwhile [[ \"${1:-}\" == -o ]]; do shift 2; done\n[[ \"$1\" == offline-admission ]] || exit 99\nshift\nif [[ \"$1\" == bash && \"$2\" == -s ]]; then exec \"$@\"; fi\nprintf \"%s\\n\" \"$BASHPID\" >>\"$OC_TEST_HOLDERS\"\nremote=\"$1\"\nactual_kind=unknown\n[[ \"$remote\" != *'write_meta()'* ]] || actual_kind=deploy\n[[ \"$remote\" != *'cleanup_proof()'* ]] || actual_kind=manual\n[[ \"$actual_kind\" == \"$OC_TEST_ADMISSION_KIND\" ]] || exit 96\ndelivery=0\nif [[ \"$actual_kind\" == deploy && \"${OC_ADMISSION_BARRIER_RED:-0}\" == 1 ]]; then\n  original=\"$OC_TEST_HELPER_ORIGINAL_B64\"\n  [[ \"$remote\" == *\"$original\"* ]] || exit 97\n  remote=\"${remote/\"$original\"/\"$OC_TEST_HELPER_COPY_B64\"}\"\n  [[ \"$remote\" != *\"$original\"* ]] || exit 97\n  delivery=1\nfi\nexpected=\"$OC_TEST_HELPER_COPY_B64\"\n[[ \"$remote\" == *\"$expected\"* ]] || exit 98\nprefix=\"${remote%%\"$expected\"*}\"\nconsumed=\"${remote:${#prefix}:${#expected}}\"\nwithout=\"${remote/\"$expected\"/}\"\n[[ \"$without\" != *\"$expected\"* ]] || exit 98\nactual_sha=\"$(printf %s \"$consumed\" | base64 -d | sha256sum | cut -d ' ' -f1)\"\nprintf '{\"actualKind\":\"%s\",\"base64Matches\":1,\"deliveryTransformCount\":%s,\"actualConsumedHelperSha\":\"%s\"}\\n' \"$actual_kind\" \"$delivery\" \"$actual_sha\" >>\"$OC_TEST_PAYLOAD_REPORT\"\nexec bash -c \"$remote\" 2> >(tee -a \"$OC_TEST_PHASE\" >&2)\n", { mode: 0o755 });
  if (controls.nonceWriteFailure) {
    const transportPath = path.join(bin, 'ssh');
    let transport = readFileSync(transportPath, 'utf8');
    const needle = 'exec bash -c "$remote" 2> >(tee -a "$OC_TEST_PHASE" >&2)';
    assert.equal(transport.split(needle).length - 1, 1);
    const gate = [
      'call="v5_mutation_admission "',
      '[[ "$remote" == *"$call"* ]] || exit 94',
      'tail="${remote#*"$call"}"',
      '[[ "$tail" != *"$call"* ]] || exit 94',
      `gate='printf "%s\\n" "$BASHPID" >"$OC_TEST_PRINTF_READY"`,
      'while [[ ! -e "$OC_TEST_PRINTF_GATE" ]]; do sleep 0.01; done',
      `'`,
      'remote="${remote/"$call"/"$gate$call"}"',
      needle,
    ].join('\n');
    transport = transport.replace(needle, gate);
    writeFileSync(transportPath, transport, { mode:0o755 });
    const syntax = spawnSync('bash', ['-n', transportPath], { encoding:'utf8' }); assert.equal(syntax.status,0,syntax.stderr);
  }
  if (controls.roleFailureLateReturn) {
    const program = '#!/bin/bash\nif [[ "$1" == "$OC_TEST_ADMIN_DSN" ]]; then printf "%s\\n" "$BASHPID" >"$OC_TEST_ADMIN_WRAPPER"; fi\nerr=$(mktemp)\n' + q(psql) + ' "$@" 2>"$err"\nrc=$?\ncategory=other\n[[ "$rc" != 0 ]] || category=connected\ngrep -q "password authentication failed" "$err" && category=authentication\nprintf "psql rc=%s category=%s\\n" "$rc" "$category" >>' + q(stages) + '\ncat "$err" >&2\nrm -f "$err"\nif [[ "$1" == "$OC_TEST_ADMIN_DSN" && "$rc" == 0 ]]; then printf "%s\\n" "$BASHPID" >"$OC_TEST_ADMIN_SUCCESS"; while [[ ! -f "$OC_TEST_ADMIN_GO" ]]; do sleep 0.01; done; fi\nquery="${!#}"\nif [[ "$query" == BEGIN* && "$rc" == 0 ]]; then printf "%s\\n" "$BASHPID" >"$OC_TEST_PRIMARY_READY"; while [[ ! -f "$OC_TEST_PRIMARY_GO" ]]; do sleep 0.01; done; fi\nexit "$rc"\n';
    writeFileSync(path.join(bin,'psql'),program,{mode:0o755});
    const syntax=spawnSync('bash',['-n',path.join(bin,'psql')],{encoding:'utf8'});assert.equal(syntax.status,0,syntax.stderr);
  }
  const helperSource = readFileSync(path.join(root, 'scripts/lib/v5-mutation-admission.sh'));
  let helper = helperSource, transformCount = 0;
  if (process.env.OC_ADMISSION_BARRIER_RED === '1') {
    const text = helperSource.toString();
    const matches = text.match(/SELECT pg_advisory_xact_lock\(hashtextextended\([^\n]*?production-mutation-admission:v1[^\n]*?,0\)\);/g) || [];
    assert.equal(matches.length, 1, 'negative must consume exactly the real shared lock SQL');
    helper = Buffer.from(text.replace(matches[0], ''));
    transformCount = 1;
  }
  record({ fixture: path.basename(dir), sourceHelperSha: sha(helperSource), copiedHelperSha: sha(helper), transformCount });
  mkdirSync(path.join(dir, 'lib'));
  writeFileSync(path.join(dir, 'lib/v5-mutation-admission.sh'), helper, { mode: 0o600 });
  assert.equal(sha(readFileSync(path.join(dir, 'lib/v5-mutation-admission.sh'))), sha(helper));
  let manual = readFileSync(path.join(root, 'scripts/with-production-mutation-lease.sh'), 'utf8');
  for (const [needle, replacement] of [['PRODUCTION_MUTATION_LOCK="/run/openclaude-v5/production-mutation.lock"', 'PRODUCTION_MUTATION_LOCK=' + q(lock)], ['V5_ENV="/etc/openclaude/commercial-v5.env"', 'V5_ENV=' + q(envFile)]]) {
    assert.equal(manual.split(needle).length - 1, 1, 'exact fixture replacement must bind');
    manual = manual.replace(needle, replacement);
  }
  const wrapper = path.join(dir, 'with-production-mutation-lease.sh'); writeFileSync(wrapper, manual, { mode: 0o755 });
  const children = [];
  function start(kind, name, ttl = 60) {
    const effect = path.join(dir, name + '.effect');
    const release = path.join(dir, name + '.release');
    const command = 'cat ' + q(proof + '.db') + ' >' + q(effect + '.tmp') + '\nmv -f ' + q(effect + '.tmp') + ' ' + q(effect) + '\nwhile [[ ! -f ' + q(release) + ' ]]; do sleep 0.05; done';
    const script = kind === 'manual'
      ? 'exec bash ' + q(wrapper) + ' bash -c ' + q(command)
      : 'V5_DEPLOY_SOURCE_ONLY=1 source scripts/deploy-v5.sh\nV5_ENV=' + q(envFile) + '\nset -e\ntrap \'release_production_mutation_lease >/dev/null 2>&1 || true\' EXIT\nacquire_production_mutation_lease 5\n' + command;
    const log = path.join(dir, name + '.log'); const fd = openSync(log, 'w');
    const child = spawn('bash', ['-c', script], { cwd: root, detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, PATH: bin + ':' + process.env.PATH, KL_HOST: 'offline-admission', ALLOW_ANY_BRANCH: '1', OC_V5_PRODUCTION_MUTATION_LOCK: lock, OC_V5_MUTATION_LEASE_TTL_SECONDS: String(ttl), OC_TEST_HOLDERS: holders, OC_TEST_PHASE: path.join(dir, 'phase.log'), OC_TEST_ADMISSION_KIND: kind, OC_TEST_HELPER_ORIGINAL_B64: helperSource.toString('base64'), OC_TEST_HELPER_COPY_B64: helper.toString('base64'), OC_TEST_PAYLOAD_REPORT: path.join(dir, 'actual-payload.jsonl'), OC_TEST_PRINTF_READY: path.join(dir, 'printf-ready'), OC_TEST_PRINTF_GATE: path.join(dir, 'printf-go'), OC_TEST_PRIMARY_READY: path.join(dir, 'primary-complete'), OC_TEST_PRIMARY_GO: path.join(dir, 'primary-go'), OC_TEST_ADMIN_DSN: values.MODEL_CATALOG_ADMIN_DATABASE_URL, OC_TEST_ADMIN_WRAPPER: path.join(dir, 'admin-wrapper-pid'), OC_TEST_ADMIN_SUCCESS: path.join(dir, 'admin-success'), OC_TEST_ADMIN_GO: path.join(dir, 'admin-return-go') } });
    closeSync(fd); children.push(child);
    return { child, effect, release, log, kind, name };
  }
  async function cleanup() {
    const payloadReport = path.join(dir, 'actual-payload.jsonl');
    if (existsSync(payloadReport)) {
      const payloads = readFileSync(payloadReport, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      assert.ok(payloads.length > 0);
      for (const payload of payloads) {
        assert.equal(payload.base64Matches, 1);
        assert.equal(payload.actualConsumedHelperSha, sha(helper));
        assert.equal(payload.deliveryTransformCount, process.env.OC_ADMISSION_BARRIER_RED === '1' && payload.actualKind === 'deploy' ? 1 : 0);
      }
      record({ fixture: path.basename(dir), actualPayloads: payloads });
    }
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }
    const pids = existsSync(holders) ? readFileSync(holders, 'utf8').trim().split(/\s+/).map(Number) : [];
    for (const pid of pids) {
      const id = processIdentity(pid);
      if (id && hasLockFd(pid, statSync(lock).dev, statSync(lock).ino)) killExact(pid, id.start);
    }
    await until(() => spawnSync('flock', ['-n', lock, 'true']).status === 0, 6000, 'cleanup lock release');
    rmSync(dir, { recursive: true, force: true });
  }
  return { dir, lock, proof, holders, start, cleanup };
}
async function connect(name) {
  const client = new Client({ connectionString: dsn, application_name: name });
  await client.connect();
  return client;
}
async function blocker(client) {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [lockKey]);
  return Number((await client.query('SELECT pg_backend_pid() pid')).rows[0].pid);
}
async function blockedBy(observer, pid) {
  const rows = (await observer.query("SELECT pid, pg_blocking_pids(pid) blockers FROM pg_stat_activity WHERE datname=current_database() AND pid<>$1 AND query LIKE '%production-mutation-admission:v1%' AND wait_event_type='Lock'", [pid])).rows;
  return rows.find(row => row.blockers.includes(pid));
}
async function exited(child, timeout = 6000) {
  return until(() => child.exitCode !== null || child.signalCode !== null, timeout, 'official entry exit');
}
for (const [oldKind, nextKind] of [['manual', 'deploy'], ['deploy', 'manual']]) {
  test('real ' + oldKind + ' holder death cannot admit ' + nextKind + ' effects before old PG COMMIT', async () => {
    const fx = fixture(); const oldTxn = await connect('g21-old-' + oldKind); const observer = await connect('g21-observer'); const listener = await connect('g21-notify');
    const channel = 'g21_' + randomBytes(8).toString('hex'); const notices = [];
    listener.on('notification', n => notices.push(n)); await listener.query('LISTEN ' + channel);
    try {
      const owner = fx.start(oldKind, 'old');
      await until(() => existsSync(owner.effect), 6000, 'old official effect');
      const oldProof = JSON.parse(readFileSync(owner.effect, 'utf8'));
      const oldPid = await blocker(oldTxn);
      await oldTxn.query('SELECT pg_notify($1,$2)', [channel, 'committed-old']);
      assert.equal(notices.length, 0, 'notification must not be visible before commit');
      killExact(oldProof.holderPid, oldProof.holderStart);
      await until(() => spawnSync('flock', ['-n', fx.lock, 'true']).status === 0, 6000, 'dead holder OS lease released');
      const next = fx.start(nextKind, 'next');
      await until(() => { try { return readFileSync(fx.proof, 'utf8').trim() !== oldProof.nonce; } catch { return false; } }, 6000, 'successor nonce rotation');
      const observed = await until(async () => {
        if (existsSync(next.effect)) return { earlyEffect: true };
        const waiting = await blockedBy(observer, oldPid);
        return waiting ? { waiting } : false;
      }, 6000, 'actual successor block or forbidden early effects');
      const earlyEffect = existsSync(next.effect);
      record({ scenario: oldKind + '->' + nextKind + '-before-commit', effectBeforeCommit: earlyEffect, oldTransactionStillOpen: true, observedBlock: observed.waiting || null });
      assert.equal(earlyEffect, false, 'successor must have zero effects while old transaction owns common lock');
      assert.ok(observed.waiting, 'must prove actual successor backend was blocked by old txn');
      const waiting = observed.waiting;
      const staleManual = fx.lock + '.manual-holder';
      if (oldKind === 'manual') assert.equal(readFileSync(staleManual, 'utf8').trim(), oldProof.nonce, 'SIGKILL leaves genuine stale legacy manual nonce');
      await oldTxn.query('COMMIT');
      await until(() => notices.some(n => n.payload === 'committed-old'), 6000, 'real server commit notification');
      await until(() => existsSync(next.effect), 6000, 'successor effects after old commit');
      const nextProof = JSON.parse(readFileSync(next.effect, 'utf8'));
      assert.notEqual(nextProof.nonce, oldProof.nonce);
      assert.equal(nextProof.nonce, readFileSync(fx.proof, 'utf8').trim());
      record({ scenario: oldKind + '->' + nextKind, oldBackendPid: oldPid, successorBackendPid: waiting.pid, blockedBy: waiting.blockers, oldNonce: oldProof.nonce, nextNonce: nextProof.nonce, effectBeforeCommit: false, serverCommitNotification: true, effectAfterCommit: true });
      writeFileSync(next.release, ''); await exited(next.child);
    } finally { await oldTxn.query('ROLLBACK').catch(() => {}); await Promise.all([oldTxn.end(), observer.end(), listener.end()]); await fx.cleanup(); }
  });
}
test('acquisition SIGKILL has no helper fd9 inheritance, no effects, and bounded backend exit', async () => {
  const fx = fixture(); const held = await connect('g21-blocker-kill'); const observer = await connect('g21-observer-kill');
  try {
    const pid = await blocker(held); const owner = fx.start('deploy', 'blocked');
    const waiting = await until(() => blockedBy(observer, pid), 6000, 'real acquiring backend');
    const holder = Number(readFileSync(fx.holders, 'utf8').trim().split(/\s+/).at(-1));
    const identity = processIdentity(holder); assert.ok(identity);
    const lockStat = statSync(fx.lock); assert.equal(hasLockFd(holder, lockStat.dev, lockStat.ino), true);
    const allChildren = descendants(holder);
    const leaders = allChildren.filter(p => p.sid === p.pid && p.pgid === p.pid && path.basename(p.command) === 'timeout');
    assert.equal(leaders.length, 1, 'must identify actual setsid timeout leader by PID/SID/PGID/command');
    const children = allChildren.filter(p => p.sid === leaders[0].sid);
    assert.ok(children.some(p => path.basename(p.command) === 'psql'), 'must include the real blocked psql child');
    assert.ok(children.length > 0, 'must observe actual helper child tree');
    for (const p of children) assert.equal(hasLockFd(p.pid, lockStat.dev, lockStat.ino), false, 'acquisition child inherited actual flock inode');
    killExact(holder, identity.start);
    await until(() => spawnSync('flock', ['-n', fx.lock, 'true']).status === 0, 6000, 'SIGKILL lock recoverability');
    await exited(owner.child);
    assert.equal(existsSync(owner.effect), false);
    await until(async () => (await observer.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1', [waiting.pid])).rowCount === 0, 22000, 'actual helper backend bounded exit');
    for (const p of children) await until(() => !live(p.pid, p.start), 22000, 'observed helper child exit');
    record({ scenario: 'acquisition-SIGKILL', backendPid: waiting.pid, descendants: children.map(({ pid, start, pgid, sid, command }) => ({ pid, start, pgid, sid, command: path.basename(command) })), childLockFdCount: 0, effects: false, lockRecovered: true, backendGone: true });
  } finally { await held.query('ROLLBACK').catch(() => {}); await Promise.all([held.end(), observer.end()]); await fx.cleanup(); }
});
test('real blocked admission TTL rejects before command startup and cannot authorize late effects', async () => {
  const fx = fixture(); const held = await connect('g21-blocker-ttl'); const observer = await connect('g21-observer-ttl');
  try {
    const pid = await blocker(held); const owner = fx.start('manual', 'ttl', 5);
    const waiting = await until(() => blockedBy(observer, pid), 2500, 'actual TTL-blocked backend');
    await exited(owner.child, 8000);
    assert.equal(existsSync(owner.effect), false);
    assert.notEqual(owner.child.exitCode, 0, readFileSync(owner.log, 'utf8'));
    await held.query('ROLLBACK');
    await until(async () => (await observer.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1', [waiting.pid])).rowCount === 0, 6000, 'TTL backend exit');
    assert.equal(existsSync(owner.effect), false, 'releasing PG blocker must not revive expired entry');
    assert.equal(spawnSync('flock', ['-n', fx.lock, 'true']).status, 0);
    record({ scenario: 'acquisition-TTL', ttlSeconds: 5, effects: false, backendGone: true, noLateEffects: true });
  } finally { await held.query('ROLLBACK').catch(() => {}); await Promise.all([held.end(), observer.end()]); await fx.cleanup(); }
});
for (const [name, changes, obstruction] of [
  ['different database identity', { MODEL_CATALOG_ADMIN_DATABASE_URL: 'postgresql://test:test@127.0.0.1:55432/postgres' }, false],
  ['unavailable explicit endpoint', { MODEL_AUTHORITY_DEPLOY_DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/openclaude_test', DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/openclaude_test', MODEL_CATALOG_ADMIN_DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/openclaude_test' }, false],
  ['nonce destination directory rejected by final现场 comparison', {}, true],
]) {
  test('actual ' + name + ' rejects with zero effects and recoverable OS lock', async () => {
    const fx = fixture(changes);
    try {
      if (obstruction) mkdirSync(fx.proof);
      let independentIdentity = null, independentConnectError = null;
      if (name === 'different database identity') {
        const identitySql = 'SELECT system_identifier::text cluster_id, current_database() database, (SELECT oid::text FROM pg_database WHERE datname=current_database()) database_oid FROM pg_control_system()';
        const a = new Client({ connectionString: dsn });
        const b = new Client({ connectionString: changes.MODEL_CATALOG_ADMIN_DATABASE_URL });
        try {
          await a.connect(); await b.connect();
          const original = (await a.query(identitySql)).rows[0];
          const alternative = (await b.query(identitySql)).rows[0];
          assert.equal(original.cluster_id, alternative.cluster_id);
          assert.notEqual(original.database, alternative.database);
          assert.notEqual(original.database_oid, alternative.database_oid);
          independentIdentity = { original, alternative, bothActuallyReadable: true };
        } finally { await Promise.all([a.end(), b.end()]); }
      }
      if (name === 'unavailable explicit endpoint') {
        const rejected = new Client({ connectionString: changes.DATABASE_URL, connectionTimeoutMillis: 2000 });
        try { await rejected.connect(); assert.fail('target socket unexpectedly accepted connection'); }
        catch (error) { assert.equal(error.code, 'ECONNREFUSED'); independentConnectError = error.code; }
        finally { await rejected.end(); }
      }
      const owner = fx.start('deploy', 'negative'); await exited(owner.child, 10000);
      assert.notEqual(owner.child.exitCode, 0, readFileSync(owner.log, 'utf8'));
      assert.equal(existsSync(owner.effect), false);
      assert.equal(existsSync(fx.proof + '.db'), false, 'no admission authorization proof may be published');
      assert.equal(spawnSync('flock', ['-n', fx.lock, 'true']).status, 0);
      const phase = existsSync(path.join(fx.dir, 'phase.log')) ? readFileSync(path.join(fx.dir, 'phase.log'), 'utf8') : '';
      if (!obstruction) assert.match(phase, /admission: PG barrier\/identity failed/);
      const stages = existsSync(path.join(fx.dir, 'real-program-stages')) ? readFileSync(path.join(fx.dir, 'real-program-stages'), 'utf8') : '';
      assert.match(stages, /parser rc=0/);
      if (name === 'different database identity') {
        assert.equal((stages.match(/psql rc=0 category=connected/g) || []).length, 3, 'all real role identities must have been readable before mismatch');
      }
      if (name === 'unavailable explicit endpoint') assert.match(stages, /psql rc=2 category=refused/);
      if (obstruction) assert.ok(statSync(fx.proof).isDirectory(), 'failure is final nonce-read comparison, not an atomic mv failure');
      record({ scenario: name, effects: false, admissionProofPublished: false, lockRecovered: true, phase, stages, independentIdentity, independentConnectError, nonceDirectoryComparison: obstruction });
    } finally { await fx.cleanup(); }
  });
}

test('actual nonce printf EISDIR while real fd9 is held rejects before any effects', async () => {
  const fx = fixture({}, {nonceWriteFailure:true});
  try {
    const owner = fx.start('deploy','actual-printf-failure');
    const holder = await until(()=>existsSync(path.join(fx.dir,'printf-ready')) && Number(readFileSync(path.join(fx.dir,'printf-ready'),'utf8').trim()),6000,'actual helper-call gate');
    const identity=processIdentity(holder);assert.ok(identity);assert.ok(live(holder,identity.start));
    const lockStat=statSync(fx.lock);assert.equal(hasLockFd(holder,lockStat.dev,lockStat.ino),true,'exact actual remote holder must own fd9 before injecting EISDIR');
    assert.notEqual(spawnSync('flock',['-n',fx.lock,'true']).status,0,'actual flock must remain held at gate');
    const target=fx.proof+'.tmp.'+holder;mkdirSync(target);assert.ok(statSync(target).isDirectory());
    assert.equal(existsSync(owner.effect),false);writeFileSync(path.join(fx.dir,'printf-go'),'');
    await exited(owner.child,10000);assert.notEqual(owner.child.exitCode,0);
    const phase=readFileSync(path.join(fx.dir,'phase.log'),'utf8');
    assert.ok(phase.includes(target),phase);assert.match(phase,/Is a directory/);
    assert.ok(statSync(target).isDirectory(),'must be actual exact printf destination, not final nonce directory compare');
    assert.equal(existsSync(fx.proof),false);assert.equal(existsSync(fx.proof+'.db'),false);assert.equal(existsSync(owner.effect),false);
    assert.equal(spawnSync('flock',['-n',fx.lock,'true']).status,0);
    record({scenario:'real-nonce-printf-EISDIR',holder,holderStart:identity.start,gateCallTransformCount:1,fd9HeldAtGate:true,tmpDirectory:target,printfError:true,noncePublished:false,proofPublished:false,effects:false,lockRecovered:true});
  } finally { await fx.cleanup(); }
});

test('one real role authentication failure cannot abandon its successfully queried sibling whose actual probe return is delayed', {timeout:11000}, async () => {
  const started=Date.now();
  const bad='postgresql://test:wrong-test-password@127.0.0.1:55432/openclaude_test';
  const admin=dsn+'?application_name=ocv5-admission-late-'+randomBytes(6).toString('hex');
  const preflight=new Client({connectionString:bad,connectionTimeoutMillis:2000});
  try { await preflight.connect();assert.fail('test PG host auth unexpectedly trusts bad password'); }
  catch(error) { assert.equal(error.code,'28P01','actual bad credential must be independently rejected'); }
  finally { await preflight.end(); }
  const fx=fixture({DATABASE_URL:bad,MODEL_CATALOG_ADMIN_DATABASE_URL:admin},{roleFailureLateReturn:true});
  try {
    const owner=fx.start('manual','role-failure-late-return',5);
    const primary=await until(()=>existsSync(path.join(fx.dir,'primary-complete')) && Number(readFileSync(path.join(fx.dir,'primary-complete'),'utf8').trim()),2000,'actual primary COMMIT and successful psql before readonly probes');
    assert.ok(processIdentity(primary));writeFileSync(path.join(fx.dir,'primary-go'),'');
    const wrapper=await until(()=>existsSync(path.join(fx.dir,'admin-success')) && Number(readFileSync(path.join(fx.dir,'admin-success'),'utf8').trim()),2000,'real original admin identity query success before delaying return');
    const wrapperIdentity=processIdentity(wrapper);assert.ok(wrapperIdentity);assert.ok(live(wrapper,wrapperIdentity.start));
    assert.equal(Number(readFileSync(path.join(fx.dir,'admin-wrapper-pid'),'utf8').trim()),wrapper,'same exact wrapper must have called real psql and then gated its return');
    await until(()=>/psql rc=2 category=authentication/.test(readFileSync(path.join(fx.dir,'real-program-stages'),'utf8')),1500,'actual sibling role auth failure');
    const stages=readFileSync(path.join(fx.dir,'real-program-stages'),'utf8');assert.equal((stages.match(/psql rc=0 category=connected/g)||[]).length,2,'primary and original admin identity calls must both actually succeed');
    const holder=Number(readFileSync(fx.holders,'utf8').trim().split(/\s+/).at(-1));const holderIdentity=processIdentity(holder);assert.ok(holderIdentity);assert.ok(live(holder,holderIdentity.start));
    const children=descendants(holder);const leaders=children.filter(p=>p.sid===p.pid && p.pgid===p.pid && path.basename(p.command)==='timeout');assert.equal(leaders.length,1,'must retain the actual supervised helper after first role error');
    const delayed=children.find(p=>p.pid===wrapper && p.start===wrapperIdentity.start);assert.ok(delayed);assert.equal(delayed.sid,leaders[0].sid);assert.equal(delayed.pgid,leaders[0].pgid);
    const helperTree=children.filter(p=>p.sid===leaders[0].sid);const lockStat=statSync(fx.lock);for(const p of helperTree)assert.equal(hasLockFd(p.pid,lockStat.dev,lockStat.ino),false,'every exact probe descendant must stay outside fd9');
    const probeDir=readdirSync(fx.dir).find(name=>name.startsWith('mutation.lock.admission-nonce.probe.'));assert.ok(probeDir);
    const actualAdminIdentity=JSON.parse(readFileSync(path.join(fx.dir,probeDir,'admin.identity'),'utf8'));assert.equal(actualAdminIdentity.inRecovery,false);assert.equal(actualAdminIdentity.database,'openclaude_test');
    assert.equal(existsSync(owner.effect),false);assert.equal(existsSync(fx.proof+'.db'),false);
    await exited(owner.child,6000);assert.notEqual(owner.child.exitCode,0);for(const p of helperTree)await until(()=>!live(p.pid,p.start),6000,'actual delayed probe group gone under original timeout');
    assert.equal(existsSync(owner.effect),false);assert.equal(existsSync(fx.proof+'.db'),false);assert.equal(spawnSync('flock',['-n',fx.lock,'true']).status,0);
    writeFileSync(path.join(fx.dir,'admin-return-go'),'');await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(existsSync(owner.effect),false);assert.equal(existsSync(fx.proof+'.db'),false,'late successful return must not revive expired authorization');
    const durationMs=Date.now()-started;assert.ok(durationMs<=8000,'must complete within original TTL5 +3s observation tolerance');
    record({scenario:'parallel-auth-error-and-real-query-success-late-return',durationMs,ttlSeconds:5,actualAuthError:true,actualPrimaryCommitBeforeReadonly:true,actualAdminIdentity,wrapperPid:wrapper,wrapperStart:wrapperIdentity.start,wrapperSid:delayed.sid,wrapperPgid:delayed.pgid,helperWaitAliveAfterActualAuthError:true,fd9Inheritance:0,allExactProbeChildrenGone:true,noLateProof:true,noEffects:true,notClaimedBlockedPgBackend:true});
  } finally { await fx.cleanup(); }
});
