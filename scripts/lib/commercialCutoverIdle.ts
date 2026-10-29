import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { BoxDurableJournal } from '../../packages/commercial/src/http/proxy/boxDurableJournal.js';

// Same run states as BoxDurableJournal admission. Settlement alone does not close a tool chain.
export const ACTIVE_BOX_STATES = ['reserved', 'starting', 'running', 'unknown', 'handoff', 'resuming', 'linked'];
export const IDLE_COUNTS_SQL = `SELECT
  (SELECT count(*)::int FROM turn_dispatches WHERE status IN ('admitted','accepted','rejecting')) AS dispatches,
  (SELECT count(*)::int FROM muse_media_jobs WHERE status IN ('queued','running')) AS muse,
  (SELECT count(*)::int FROM media_generation_jobs WHERE status IN ('dispatching','running','reconnecting')) AS media,
  (SELECT count(*)::int FROM studio_tasks WHERE status='leased') AS studio`;
export const IDLE_JOURNAL_SQL = `SELECT request_id,user_id::text,container_id::text,state,ctx
  FROM request_finalize_journal
  WHERE state IN ('inflight','finalizing') OR ctx->>'boxState'=ANY($1::text[])`;

type Row = { request_id: string; user_id: string; container_id: string; state: string; ctx: Record<string, unknown> };
type Counts = { dispatches: number; muse: number; media: number; studio: number };
type Stats = { started_at: string; total_current: number };
type Deps = {
  pool: Pick<pg.Pool, 'query'>;
  journal: Pick<BoxDurableJournal, 'readIdleProof'>;
  stats: () => Promise<Stats>;
};
function validStats(s: Stats) {
  assert.ok(s && typeof s.started_at === 'string' && s.started_at.length > 0);
  assert.ok(Number.isSafeInteger(s.total_current) && s.total_current >= 0);
}
export async function readIdleSnapshot({ pool, journal, stats }: Deps) {
  const before = await stats(); validStats(before);
  const counts = (await pool.query<Counts>(IDLE_COUNTS_SQL)).rows;
  assert.equal(counts.length, 1);
  for (const key of ['dispatches', 'muse', 'media', 'studio'] as const) {
    assert.ok(Number.isSafeInteger(counts[0]![key]) && counts[0]![key] >= 0, `invalid ${key} count`);
  }
  const rows = (await pool.query<Row>(IDLE_JOURNAL_SQL, [ACTIVE_BOX_STATES])).rows;
  let unresolved = 0, neverLaunched = 0;
  for (const row of rows) {
    const ctx = row.ctx;
    // A durable prestart stop is the only unsettled row that can be proved never launched.
    if (!ctx || ctx.boxState !== 'prestart_stopped'
      || ['boxLaunchPermit', 'boxOwnerRequestId', 'boxResumeRequestId'].some(k => Object.hasOwn(ctx, k))) {
      unresolved++; continue;
    }
    const proof = await journal.readIdleProof({ uid: BigInt(row.user_id), containerId: BigInt(row.container_id),
      sessionId: String(ctx.boxSessionId), turnKey: String(ctx.boxTurnKey) });
    if (proof.status === 'failed' && proof.requestIds.length === 1 && proof.requestIds[0] === row.request_id) neverLaunched++;
    else unresolved++;
  }
  const after = await stats(); validStats(after);
  assert.equal(after.started_at, before.started_at, 'egress changed during snapshot');
  return { at: new Date().toISOString(), ...counts[0]!, unresolved, neverLaunched,
    httpBefore: before.total_current, httpAfter: after.total_current,
    free: Object.values(counts[0]!).every(n => n === 0) && unresolved === 0
      && before.total_current === 0 && after.total_current === 0 };
}

// Fixed production policy: two snapshots 15s apart, bounded wait, no force/allow-inflight switch.
export async function waitForIdle(read: () => Promise<{ free: boolean }>,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now: () => number = Date.now) {
  const deadline = now() + 600_000;
  let quiet = 0;
  while (now() <= deadline) {
    const snapshot = await read();
    console.log(JSON.stringify(snapshot));
    assert.equal(typeof snapshot.free, 'boolean', 'invalid idle snapshot');
    quiet = snapshot.free ? quiet + 1 : 0;
    if (quiet === 2 && now() <= deadline) return;
    await sleep(15_000);
  }
  throw new Error('commercial cutover idle timeout; live activation refused');
}

// Legacy units may have an npx MainPID. The listener must be that process or its
// verified descendant, and must itself execute from the expected immutable release.
export function verifyListeners(listeners: string, mainPid: number, expectedCwd: string,
  processInfo: (pid: number) => { parent: number; cwd: string }) {
  assert.ok(listeners.trim(), 'missing egress listener');
  const pids = new Set<number>();
  for (const line of listeners.trim().split('\n')) {
    const matches = [...line.matchAll(/pid=([0-9]+),/g)];
    assert.ok(matches.length > 0, 'listener owner missing');
    let serving = 0;
    for (const match of matches) {
      const listenerPid = Number(match[1]);
      // Socket activation retains a copy in PID1. It is not the serving worker;
      // every socket must still have a verified worker from this exact unit.
      if (listenerPid === 1 && line.includes('"systemd",pid=1,')) continue;
      assert.equal(processInfo(listenerPid).cwd, expectedCwd);
      let pid = listenerPid;
      const seen = new Set<number>();
      while (pid !== mainPid) {
        assert.ok(pid > 1 && !seen.has(pid), 'listener outside serving unit');
        seen.add(pid); pid = processInfo(pid).parent;
      }
      pids.add(listenerPid); serving++;
    }
    assert.ok(serving > 0, 'socket has no serving worker');
  }
  return [...pids].sort((a, b) => a - b).join(',');
}

async function main() {
  const [expectedMaster, expectedEgress] = process.argv.slice(2);
  const release = /^\/opt\/openclaude\/openclaude-v5-releases\/rel-[a-f0-9]+-[0-9]{8}-[0-9]{6}$/;
  assert.ok(expectedMaster && release.test(expectedMaster));
  assert.ok(expectedEgress && release.test(expectedEgress));
  assert.ok(process.env.DATABASE_URL, 'missing database configuration');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL,
    options: '-c default_transaction_read_only=on', max: 2, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
  const props = (unit: string) => Object.fromEntries(execFileSync('systemctl',
    ['show', unit, '-p', 'ActiveState,SubState,MainPID'], { encoding: 'utf8', timeout: 5000 }).trim().split('\n').map(x => x.split('=')));
  const running = (unit: string, expected: string) => {
    const p = props(unit);
    assert.equal(p.ActiveState, 'active'); assert.equal(p.SubState, 'running');
    assert.ok(Number(p.MainPID) > 0);
    assert.equal(readlinkSync(`/proc/${p.MainPID}/cwd`), expected);
    return Number(p.MainPID);
  };
  const identity = async () => {
    const { rows } = await pool.query('SELECT phase,active_slot,active_release,candidate_slot,candidate_release FROM deploy_state WHERE singleton=true');
    assert.equal(rows.length, 1);
    const s = rows[0]; assert.equal(s.phase, 'stable');
    assert.equal(s.candidate_slot, null); assert.equal(s.candidate_release, null);
    assert.equal(s.active_release, expectedMaster);
    assert.ok(s.active_slot === 'A' || s.active_slot === 'B');
    const master = running(s.active_slot === 'A' ? 'openclaude-v5.service' : 'openclaude-v5-b.service', expectedMaster!);
    const units = ['openclaude-v5-egress.service', 'openclaude-v5-egress@A.service', 'openclaude-v5-egress@B.service'];
    const active = units.filter(unit => {
      const p = props(unit);
      assert.ok(!['activating', 'deactivating', 'reloading'].includes(p.ActiveState));
      return p.ActiveState === 'active';
    });
    assert.equal(active.length, 1);
    const egress = running(active[0]!, expectedEgress!);
    const listeners = execFileSync('ss', ['-Hltnp', 'sport = :18892'], { encoding: 'utf8', timeout: 5000 }).trim();
    const listenerPids = verifyListeners(listeners, egress, expectedEgress!, pid => {
      const parent = readFileSync(`/proc/${pid}/status`, 'utf8').match(/^PPid:\s+([0-9]+)$/m);
      assert.ok(parent, 'missing process parent');
      return { parent: Number(parent[1]), cwd: readlinkSync(`/proc/${pid}/cwd`) };
    });
    return `${master}:${egress}:${listenerPids}:${s.active_slot}`;
  };
  try {
    assert.equal((await pool.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only, 'on');
    const initial = await identity();
    const stats = async () => {
      const response = await fetch('http://172.31.0.1:18892/internal/v5/egress-stats', { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      const body = await response.json() as { ok: boolean; role: string; inflight: Stats };
      assert.equal(body.ok, true); assert.equal(body.role, 'egress');
      return body.inflight;
    };
    const journal = new BoxDurableJournal(pool);
    await waitForIdle(async () => {
      assert.equal(await identity(), initial, 'serving identity changed');
      const snapshot = await readIdleSnapshot({ pool, journal, stats });
      assert.equal(await identity(), initial, 'serving identity changed');
      return snapshot;
    });
  } finally { await pool.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('commercial idle proof unavailable or busy; refusing activation'); process.exitCode = 1; });
}
