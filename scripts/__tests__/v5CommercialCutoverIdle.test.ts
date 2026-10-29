import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ACTIVE_BOX_STATES, IDLE_COUNTS_SQL, IDLE_JOURNAL_SQL, readIdleSnapshot, waitForIdle, verifyListeners } from '../lib/commercialCutoverIdle.js';

const zero = { dispatches: 0, muse: 0, media: 0, studio: 0 };
const row = { request_id: 'stopped', user_id: '4', container_id: '1', state: 'inflight',
  ctx: { boxState: 'prestart_stopped', boxSessionId: 's', boxTurnKey: 'a'.repeat(64) } };
function fixture(options: { counts?: unknown; rows?: unknown[]; http?: number; proof?: unknown; stats?: unknown } = {}) {
  return {
    pool: { query: async (sql: string, values?: unknown[]) => {
      if (sql === IDLE_COUNTS_SQL) return { rows: [options.counts ?? zero] };
      assert.equal(sql, IDLE_JOURNAL_SQL); assert.deepEqual(values, [ACTIVE_BOX_STATES]);
      return { rows: options.rows ?? [] };
    } },
    journal: { readIdleProof: async () => options.proof ?? { status: 'failed', requestIds: ['stopped'] } },
    stats: async () => options.stats ?? { started_at: 'same', total_current: options.http ?? 0 },
  } as unknown as Parameters<typeof readIdleSnapshot>[0];
}

test('commercial idle blocks each actual work surface and malformed counters', async () => {
  assert.equal((await readIdleSnapshot(fixture())).free, true);
  for (const key of Object.keys(zero)) {
    assert.equal((await readIdleSnapshot(fixture({ counts: { ...zero, [key]: 1 } }))).free, false);
    await assert.rejects(readIdleSnapshot(fixture({ counts: { ...zero, [key]: '0' } })));
  }
  assert.equal((await readIdleSnapshot(fixture({ http: 1 }))).free, false);
  await assert.rejects(readIdleSnapshot(fixture({ stats: {} })));
  const broken = fixture(); broken.pool.query = async () => { throw new Error('unavailable'); };
  await assert.rejects(readIdleSnapshot(broken));
});

test('settled billing does not make an active Box tool chain idle', async () => {
  for (const state of ['committed', 'aborted', 'inflight']) {
    for (const boxState of ACTIVE_BOX_STATES) {
      assert.equal((await readIdleSnapshot(fixture({ rows: [{ ...row, state, ctx: { ...row.ctx, boxState } }] }))).free, false);
    }
  }
  // The selector has no settlement filter around active Box states.
  assert.match(IDLE_JOURNAL_SQL, /state IN \('inflight','finalizing'\) OR ctx->>'boxState'=ANY\(\$1::text\[\]\)/);
});

test('only an exact authoritative never-launched failed proof excludes an unsettled row', async () => {
  assert.equal((await readIdleSnapshot(fixture({ rows: [row] }))).neverLaunched, 1);
  for (const proof of [{ status: 'pending' }, { status: 'not_found' },
    { status: 'failed', requestIds: ['different'] }, { status: 'failed', requestIds: ['stopped', 'other'] }]) {
    assert.equal((await readIdleSnapshot(fixture({ rows: [row], proof }))).free, false);
  }
  for (const field of ['boxLaunchPermit', 'boxOwnerRequestId', 'boxResumeRequestId']) {
    assert.equal((await readIdleSnapshot(fixture({ rows: [{ ...row, ctx: { ...row.ctx, [field]: null } }] }))).free, false);
  }
  assert.equal((await readIdleSnapshot(fixture({ rows: [{ ...row, ctx: {} }] }))).free, false);
});

test('two fresh idle snapshots are required after work that starts during the build', async () => {
  let time = 0, reads = 0;
  const samples = [false, true, false, true, true];
  await waitForIdle(async () => ({ free: samples[reads++]! }), async ms => { time += ms; }, () => time);
  assert.equal(reads, 5); assert.equal(time, 60_000);
  let activated = false;
  time = 0;
  await assert.rejects(async () => {
    await waitForIdle(async () => ({ free: false }), async ms => { time += ms; }, () => time);
    activated = true;
  }, /timeout/);
  assert.equal(activated, false);
  await assert.rejects(waitForIdle(async () => { throw new Error('read failed'); }));
});

test('official ordinary deploy checks after all builds and before live activation', () => {
  const source = readFileSync(new URL('../deploy-v5.sh', import.meta.url), 'utf8');
  const deploy = source.slice(source.indexOf('\ndeploy() {'), source.indexOf('\n}', source.indexOf('\ndeploy() {')));
  const guard = deploy.indexOf('commercial_wait_for_cutover_idle "$kp_previous_release"');
  assert.ok(guard > deploy.indexOf('build_release ||'));
  assert.ok(guard > deploy.indexOf('build_runtime_release ||'));
  assert.ok(guard > deploy.indexOf('sync_assets_to_pool "$BUILT_RELEASE"'));
  assert.ok(guard < deploy.indexOf('begin_planned_maintenance deploy'));
  assert.ok(guard < deploy.indexOf('if activate_runtime_tuple'));
  assert.ok(guard < deploy.indexOf('if ! activate_release'));
  const wrapper = readFileSync(new URL('../lib/v5-commercial-cutover-idle.sh', import.meta.url), 'utf8');
  assert.match(wrapper, /assert_mutation_lease_alive 'commercial-idle-before'/);
  assert.match(wrapper, /assert_mutation_lease_alive 'commercial-idle-after'/);
  assert.doesNotMatch(wrapper, /allow-inflight|systemctl|kill /);
});

test('legacy npx egress accepts only its actual listening descendant and exact source', () => {
  const tree = new Map([[12, { parent: 1, cwd: '/release' }], [13, { parent: 12, cwd: '/release' }],
    [20, { parent: 1, cwd: '/release' }], [21, { parent: 12, cwd: '/other' }]]);
  const info = (pid: number) => { const p = tree.get(pid); assert.ok(p); return p; };
  assert.equal(verifyListeners('users:(("node",pid=13,fd=4))', 12, '/release', info), '13');
  assert.equal(verifyListeners('users:(("node",pid=12,fd=4))', 12, '/release', info), '12');
  for (const text of ['', 'no owner', 'pid=20,', 'pid=21,']) {
    assert.throws(() => verifyListeners(text, 12, '/release', info));
  }
});

test('ordinary direct activation rechecks idle after its own asset synchronization', () => {
  const source = readFileSync(new URL('../deploy-v5.sh', import.meta.url), 'utf8');
  const activate = source.match(/^activate_release\(\) \{[\s\S]*?^\}/m)![0];
  const guard = activate.indexOf('commercial_wait_for_cutover_idle "$prev"');
  assert.ok(guard > activate.indexOf('sync_assets_to_pool "$reldir"'));
  assert.ok(guard < activate.indexOf('prepare_direct_turn_timeline_activation'));
  assert.ok(guard < activate.indexOf('systemctl restart'));
  assert.match(source, /if ! activate_release "\$BUILT_RELEASE" --wait-user-idle; then/);
});
