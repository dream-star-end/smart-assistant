import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "pg";
import { renewContainerLinkLease } from "../ws/containerLinkStore.js";
import type { TurnDispatchRow } from "../dispatch/turnDispatchStore.js";
import { getTestDatabaseUrlForTempTables } from "./helpers/db.js";

test("ContainerLink renews admitted/accepted only, fenced by user/carrier/attempt/epoch/terminal", async () => {
  const url = getTestDatabaseUrlForTempTables();
  assert.match(new URL(url).pathname, /_test$/);
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 1500 });
  await client.connect();
  try {
    await client.query(`CREATE TEMP TABLE turn_dispatches (
      dispatch_id uuid PRIMARY KEY, user_id bigint, agent_container_id bigint,
      attempt_no int, lease_epoch bigint, status text, terminal_at timestamptz,
      lease_until timestamptz, last_attempt_at timestamptz)`);
    const dispatchId = "11111111-1111-4111-8111-111111111111";
    await client.query(`INSERT INTO turn_dispatches VALUES ($1, 42, 7, 2, 3, 'admitted', NULL, NULL, NULL)`, [dispatchId]);
    const row = { dispatchId, attemptNo: 2, leaseEpoch: 3 } as TurnDispatchRow;
    for (const status of ["admitted", "accepted"]) {
      await client.query("UPDATE turn_dispatches SET status=$1, lease_until=NULL", [status]);
      assert.equal(await renewContainerLinkLease(client, 42n, 7, row), true);
      const result = await client.query("SELECT lease_until > NOW() AS renewed FROM turn_dispatches");
      assert.equal(result.rows[0].renewed, true);
    }
    assert.equal(await renewContainerLinkLease(client, 43n, 7, row), false);
    assert.equal(await renewContainerLinkLease(client, 42n, 8, row), false);
    assert.equal(await renewContainerLinkLease(client, 42n, 7, { ...row, attemptNo: 1 }), false);
    assert.equal(await renewContainerLinkLease(client, 42n, 7, { ...row, leaseEpoch: 2 }), false);
    for (const status of ["rejecting", "terminal", "manual_reconcile"]) {
      await client.query("UPDATE turn_dispatches SET status=$1, lease_until=NULL", [status]);
      assert.equal(await renewContainerLinkLease(client, 42n, 7, row), false);
    }
    await client.query("UPDATE turn_dispatches SET status='accepted', terminal_at=NOW()");
    assert.equal(await renewContainerLinkLease(client, 42n, 7, row), false);
  } finally { await client.end(); }
});
