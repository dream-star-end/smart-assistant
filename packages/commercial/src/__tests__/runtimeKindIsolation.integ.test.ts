/**
 * runtime_kind isolation: desktop rows must not leak into docker readers.
 *
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/runtimeKindIsolation.integ.test.ts'
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { selectStaleRows } from "../agent-sandbox/v3idleSweep.js";
import { findActiveByHostAndBoundIp } from "../compute-pool/queries.js";
import { getPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { getRuntimeChannel } from "../runtimeChannel.js";
import { useDedicatedTestDatabase } from "./helpers/db.js";

const db = useDedicatedTestDatabase("runtime_kind_isolation_test");
const HASH32 = "00".repeat(32);

async function insertUser(email: string): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO users(email, password_hash) VALUES ($1, 'x') RETURNING id::text`,
    [email],
  );
  return r.rows[0]!.id;
}

async function insertHost(name: string): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO compute_hosts(
       name, host, ssh_port, ssh_user, agent_port,
       ssh_password_nonce, ssh_password_ct,
       agent_psk_nonce, agent_psk_ct,
       max_containers, bridge_cidr, status
     ) VALUES (
       $1, '10.0.0.1', 22, 'root', 9443,
       '\\x01'::bytea, '\\x01'::bytea,
       '\\x01'::bytea, '\\x01'::bytea,
       50, '172.30.99.0/24', 'ready'
     ) RETURNING id::text`,
    [name],
  );
  return r.rows[0]!.id;
}

describe("runtime_kind isolation", () => {
  test("findActiveByHostAndBoundIp ignores desktop row with bound_ip NULL", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    const uid = await insertUser(`rk-ip-${Date.now()}@t.local`);
    const hostId = await insertHost(`rk-host-${Date.now()}`);
    const channel = getRuntimeChannel();
    const docker = await query<{ id: string }>(
      `INSERT INTO agent_containers(
         user_id, host_uuid, bound_ip, secret_hash, state, runtime_channel, runtime_kind
       ) VALUES ($1, $2::uuid, '172.30.99.10', decode($3,'hex'), 'active', $4, 'docker')
       RETURNING id::text`,
      [uid, hostId, HASH32, channel],
    );
    await query(
      `INSERT INTO agent_containers(
         user_id, secret_hash, state, runtime_channel, runtime_kind, bound_ip, host_uuid
       ) VALUES ($1, decode($2,'hex'), 'active', $3, 'desktop', NULL, NULL)`,
      [uid, HASH32, channel],
    );
    const hit = await findActiveByHostAndBoundIp(hostId, "172.30.99.10");
    assert.ok(hit);
    assert.equal(String(hit!.id), docker.rows[0]!.id);
    const miss = await findActiveByHostAndBoundIp(hostId, "172.30.99.11");
    assert.equal(miss, null);
  });

  test("idleSweep stale SELECT does not include desktop rows", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    const uid = await insertUser(`rk-idle-${Date.now()}@t.local`);
    const channel = getRuntimeChannel();
    const staleDocker = await query<{ id: string }>(
      `INSERT INTO agent_containers(
         user_id, secret_hash, state, runtime_channel, runtime_kind, last_ws_activity
       ) VALUES ($1, decode($2,'hex'), 'active', $3, 'docker', NOW() - INTERVAL '2 hours')
       RETURNING id::text`,
      [uid, HASH32, channel],
    );
    const staleDesktop = await query<{ id: string }>(
      `INSERT INTO agent_containers(
         user_id, secret_hash, state, runtime_channel, runtime_kind, last_ws_activity
       ) VALUES ($1, decode($2,'hex'), 'active', $3, 'desktop', NOW() - INTERVAL '2 hours')
       RETURNING id::text`,
      [uid, HASH32, channel],
    );
    const stale = await selectStaleRows(getPool(), 30, 100);
    const ids = new Set(stale.map((r) => String(r.id)));
    assert.equal(ids.has(staleDocker.rows[0]!.id), true);
    assert.equal(ids.has(staleDesktop.rows[0]!.id), false);
  });
});
