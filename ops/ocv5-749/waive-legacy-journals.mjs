/** OCV5-749: one-off, explicitly authorized seven-request waiver. Not a recovery policy.
 * No SSH, no receipt invention, no binding/capacity/ledger/Redis/balance writes.
 * Host CLI: node --import tsx ops/ocv5-749/waive-legacy-journals.mjs --capture FILE
 * then --apply FILE SHA256. Both require the pinned selfhost DB and root host.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, constants, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';

export const OPID = 'OCV5-749-seven-legacy-waiver-20261113';
export const AUDIT_KEY = 'ocv5_749_manual_waiver';
const ERROR = 'USER_AUTHORIZED_HISTORICAL_WAIVER: usage unknown; remote stop NOT verified';
export const LANES = Object.freeze([
  { operation: '8f24f101-32bf-4e61-be77-bd09b6c0a785', run: 'bd2b27b4-013f-4b41-b70f-d8684408c692', generation: '1', state: 'released', docker: '1ff4d72efbcd6eabc06dc712933ada4994e5fde383c4a9cb9dec32e287ed45df' },
  { operation: 'ce793d1f-a35a-4db7-a66d-c4d52e248c1d', run: '9da25ff9-9a35-4ea3-926e-c338b90a92f7', generation: '7', state: 'released', docker: 'fd32bc87c1bdb4a90f3327cfae97e256c40a928b98165bd792bc7905fc51e7c3' },
  { operation: '80a9a306-a462-4d22-a698-ea24e4287d03', run: '3e8dc557-af93-42db-8188-55db5cefa29f', generation: '1', state: 'running', docker: 'a60299cbc3f039398d12a2f0f199eff7d93c33ac4810f8bda18c840800c4f573' },
]);
export const REQUEST_LANE = Object.freeze({
  c53d94c170655bbc711d409af7e8dfcb: 0,
  d13f1dee5d8fbabdc1245d4fec12b161: 1,
  '2b244ada2f7a6ffe64b343bfdea0f3cf': 1,
  f10d647b9a5759330ad14aa0282a18f4: 1,
  fb39244d2679c5f788574b82a73da193: 1,
  '5b0cf1590ccf327e3fe5f46c011e714e': 1,
  '624917311c4a9f4d3b4de57148c2b1d9': 2,
});
export const IDS = Object.freeze(Object.keys(REQUEST_LANE).sort());
const OPS = LANES.map(x => x.operation).sort();
const canonical = x => x === null || typeof x !== 'object' ? JSON.stringify(x)
  : Array.isArray(x) ? `[${x.map(canonical).join(',')}]`
    : `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${canonical(x[k])}`).join(',')}}`;
export const digest = x => createHash('sha256').update(canonical(x)).digest('hex');

export async function capture(client, lock = false) {
  // Binding first matches placement's ownership boundary. No binding updates here.
  const bindings = (await client.query(`SELECT to_jsonb(b) AS row FROM remote_agent_bindings b
    WHERE operation_id=ANY($1::uuid[]) ORDER BY operation_id ${lock ? 'FOR UPDATE' : ''}`, [OPS])).rows.map(x => x.row);
  const journals = (await client.query(`SELECT to_jsonb(j) AS row FROM request_finalize_journal j
    WHERE request_id=ANY($1::text[]) ORDER BY request_id ${lock ? 'FOR UPDATE' : ''}`, [IDS])).rows.map(x => x.row);
  return { version: 1, opid: OPID, bindings, journals };
}

export function validate(snapshot) {
  assert.equal(snapshot.version, 1); assert.equal(snapshot.opid, OPID);
  assert.deepEqual(snapshot.journals.map(x => x.request_id), IDS);
  assert.deepEqual(snapshot.bindings.map(x => x.operation_id), OPS);
  for (const b of snapshot.bindings) {
    const pin = LANES.find(x => x.operation === b.operation_id);
    assert.equal(String(b.uid), '3'); assert.equal(b.run_id, pin.run);
    assert.equal(String(b.generation), pin.generation); assert.equal(b.docker_id, pin.docker);
    assert.equal(b.state, pin.state); assert.equal(b.engine, 'cc');
    assert.equal(b.backend_kind, 'cc5-interactive-v1'); assert.equal(b.remote_protocol_version, 1);
  }
  for (const j of snapshot.journals) {
    const pin = LANES[REQUEST_LANE[j.request_id]], c = j.ctx.remoteNative, s = c?.scope;
    assert.equal(String(j.user_id), '3'); assert.equal(j.state, 'inflight');
    assert.equal(j.usage_id, null); assert.equal(j.ledger_id, null); assert.equal(j.final_credits, null);
    assert.equal(j.ctx.remoteNativeBillingRecovery, 'cc5-native-v1');
    assert.ok(!Object.hasOwn(j.ctx, 'settlementClaimId') && !Object.hasOwn(j.ctx, AUDIT_KEY));
    assert.equal(c.v, 1); assert.equal(c.requestId, j.request_id);
    assert.equal(c.receipt, null); assert.ok(c.input && c.hostStartAttempted === true);
    assert.ok(c.native === undefined); assert.equal(s.uid, '3');
    assert.equal(s.operationId, pin.operation); assert.equal(s.runId, pin.run); assert.equal(s.dockerId, pin.docker);
    assert.equal(s.backendKind, 'cc5-interactive-v1');
    const b = snapshot.bindings.find(x => x.operation_id === pin.operation);
    assert.equal(s.sessionKey, b.session_key); assert.equal(s.canonicalModel, b.canonical_model_id);
  }
}

export async function noFinancialEffects(client) {
  // Also reject orphan attribution, not just a journal's nullable usage/ledger FK.
  const result = await client.query(`SELECT
    (SELECT COUNT(*) FROM usage_records WHERE user_id=3 AND request_id=ANY($1::text[]))::int AS usage,
    (SELECT COUNT(*) FROM credit_ledger WHERE user_id=3 AND ref_type='request' AND ref_id=ANY($1::text[]))::int AS ledger,
    (SELECT COUNT(*) FROM pending_usage_patches WHERE user_id='c:3' AND request_id=ANY($1::text[]))::int AS pending,
    (SELECT COUNT(*) FROM turn_tape_cost_components WHERE user_id='c:3' AND request_id=ANY($1::text[]))::int AS tape`, [IDS]);
  assert.deepEqual(result.rows[0], { usage: 0, ledger: 0, pending: 0, tape: 0 });
  const extra = await client.query(`SELECT request_id FROM request_finalize_journal
    WHERE ctx#>>'{remoteNative,scope,operationId}'=ANY($1::text[])
      AND NOT(request_id=ANY($2::text[])) AND state IN ('inflight','finalizing')`, [OPS, IDS]);
  assert.equal(extra.rowCount, 0);
}

export function waiverAudit(snapshot) {
  return { operationId: OPID, ticket: 'OCV5-749', authorization: '那就不用管了，默认停止',
    decision: 'manual_exception_waive_unknown_historical_usage', remoteStopVerified: false,
    usageKnown: false, noCharge: true, snapshotSha256: digest(snapshot) };
}

/** persist must durably preserve the full snapshot before the first UPDATE. */
export async function applyWaiver(pool, expected, persist) {
  validate(expected);
  const client = await pool.connect();
  let committing = false;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='10s'; SET LOCAL idle_in_transaction_session_timeout='30s'");
    const current = await capture(client, true);
    assert.deepEqual(current, expected); validate(current);
    await noFinancialEffects(client);
    await persist(current);
    const audit = waiverAudit(expected);
    for (const j of expected.journals) {
      const result = await client.query(`UPDATE request_finalize_journal j
        SET state='aborted', final_credits=0, failure_code='USER_CANCELLED', error_msg=$2,
          ctx=ctx || jsonb_build_object($3::text,$4::jsonb), updated_at=NOW()
        WHERE request_id=$1 AND user_id=3 AND state='inflight' AND to_jsonb(j)=$5::jsonb`,
      [j.request_id, ERROR, AUDIT_KEY, JSON.stringify(audit), JSON.stringify(j)]);
      assert.equal(result.rowCount, 1);
    }
    await noFinancialEffects(client);
    committing = true;
    await client.query('COMMIT');
    return { committed: true };
  } catch (cause) {
    if (!committing) await client.query('ROLLBACK').catch(() => {});
    // Once COMMIT was sent, never issue a compensating write or retry.
    const error = new Error(committing ? 'COMMIT_OUTCOME_UNKNOWN_READBACK_ONLY' : 'WAIVER_REJECTED', { cause });
    error.commitUnknown = committing; throw error;
  } finally { client.release(true); }
}

/** Independently read all expected outcomes. An unchanged read is NOT proof a lost COMMIT has ended. */
export async function readback(client, expected) {
  const actual = await capture(client);
  if (digest(actual) === digest(expected)) return 'unchanged-outcome-not-confirmed';
  try {
    assert.deepEqual(actual.bindings, expected.bindings);
    assert.equal(actual.journals.length, 7);
    for (let i = 0; i < expected.journals.length; i++) {
      const original = expected.journals[i], current = actual.journals[i];
      assert.deepEqual(current, { ...original, state: 'aborted', final_credits: 0,
        failure_code: 'USER_CANCELLED', error_msg: ERROR,
        updated_at: current.updated_at, ctx: { ...original.ctx, [AUDIT_KEY]: waiverAudit(expected) } });
      assert.ok(Date.parse(current.updated_at) >= Date.parse(original.updated_at));
    }
    await noFinancialEffects(client);
    return 'committed-verified';
  } catch { return 'mismatch-or-unknown'; }
}

export function savePrivate(path, value) {
  const bytes = JSON.stringify(value, null, 2) + '\n';
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(parent); } finally { closeSync(parent); }
}

async function cli() {
  assert.equal(process.getuid(), 0, 'host root required');
  const [mode, file, sha] = process.argv.slice(2);
  assert.ok(['--capture', '--apply', '--verify'].includes(mode));
  assert.ok(file && resolve(file).startsWith('/var/lib/docker/volumes/oc-v5-data-u3/_data/generated/OCV5-749-'));
  assert.equal(process.argv.slice(2).length, mode === '--capture' ? 2 : 3);
  const env = readFileSync('/etc/openclaude/commercial-v5-selfhost.env', 'utf8');
  const line = env.split('\n').find(x => x.startsWith('DATABASE_URL=')); assert.ok(line);
  const connectionString = line.slice(13).trim().replace(/^(['"])(.*)\1$/, '$2');
  const url = new URL(connectionString);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname) && url.pathname === '/openclaude_v5_selfhost');
  const pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 3000,
    options: `-c statement_timeout=10000${mode === '--apply' ? '' : ' -c default_transaction_read_only=on'}` });
  try {
    const identity = (await pool.query('SELECT current_database() db,current_schema() schema,NOW() at')).rows[0];
    assert.equal(identity.db, 'openclaude_v5_selfhost'); assert.equal(identity.schema, 'public');
    if (mode === '--capture') {
      const client = await pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const snapshot = await capture(client); validate(snapshot); await noFinancialEffects(client);
        await client.query('COMMIT'); savePrivate(file, snapshot);
        console.log(JSON.stringify({ mode, at: identity.at, snapshot: file, sha256: digest(snapshot), count: 7 }));
      } finally { client.release(true); }
      return;
    }
    const expected = JSON.parse(readFileSync(file, 'utf8')); validate(expected); assert.equal(digest(expected), sha);
    if (mode === '--apply') {
      const { proveRemoteLaneContainerStopped } = await import('../../packages/commercial/src/account-pool/remoteLaneRecovery.ts');
      for (const lane of LANES) await proveRemoteLaneContainerStopped(lane.docker);
      const { execFileSync } = await import('node:child_process');
      const status = JSON.parse(execFileSync('/opt/openclaude/openclaude-v5-selfhost/scripts/agent-remote/drain-remote-v4.sh', ['--status'], { encoding: 'utf8', timeout: 15000 }));
      assert.equal(status.ok, true); assert.equal(status.activeRelayCount, 0); assert.equal(status.registeredRelayCount, 0);
      assert.equal(status.draining, false); assert.equal(status.unsettledJournals, 7);
      try { await applyWaiver(pool, expected, snapshot => savePrivate(`${file}.before-apply.json`, snapshot)); }
      catch (error) {
        if (!error.commitUnknown) throw error;
        console.error('COMMIT_OUTCOME_UNKNOWN: checking independently, NEVER retrying writes');
      }
    }
    const reader = await pool.connect();
    try {
      await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const result = await readback(reader, expected);
      await reader.query('COMMIT');
      console.log(JSON.stringify({ mode, result, remoteStopVerified: false, bindingWrites: 0, chargedCredits: 0 }));
      if (result !== 'committed-verified') process.exitCode = 2;
    } finally { reader.release(true); }
  } finally { await pool.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  cli().catch(error => { console.error(error.message); process.exitCode = 1; });
}
