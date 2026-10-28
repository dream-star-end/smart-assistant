import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "pg";
import { readContainerLinkReplay } from "../ws/containerLinkHello.js";
import { renewContainerLinkLease } from "../ws/containerLinkStore.js";
import type { TurnDispatchRow } from "../dispatch/turnDispatchStore.js";
import { getTestDatabaseUrlForTempTables } from "./helpers/db.js";
import { WebSocket, WebSocketServer } from "ws";
import type { Pool } from "pg";
import { createUserChatBridge, type UserChatBridgeDeps } from "../ws/userChatBridge.js";
import { resolveContainerLinkEndpoint } from "../ws/containerLinkEndpoint.js";
import { recordContainerLinkGap, scanContainerLinkCarriers } from "../ws/containerLinkRecoveryStore.js";
import { createLogger } from "../logging/logger.js";

const restoredDispatch = "22222222-2222-4222-8222-222222222222";
const restoredKey = `dispatch:${restoredDispatch}:1`;
const restoredSessionKey = "agent:main:webchat:dm:restored";
async function recoveryFixture(): Promise<Client> {
  const client = new Client({ connectionString: getTestDatabaseUrlForTempTables(), connectionTimeoutMillis: 1500 });
  await client.connect();
  await client.query(`CREATE TEMP TABLE client_sessions(id text PRIMARY KEY,user_id text,deleted_at timestamptz);
    CREATE TEMP TABLE compute_hosts(id uuid,name text);
    CREATE TEMP TABLE agent_containers(id bigint PRIMARY KEY,user_id bigint,state text,runtime_channel text,
      runtime_kind text,bound_ip inet,port int,host_uuid uuid,container_internal_id text);
    CREATE TEMP TABLE turn_dispatches(dispatch_id uuid PRIMARY KEY,user_id bigint,session_id text,client_message_id text,
      agent_id text,model text,request_hash text,billing_request_id text,attempt_no int,status text,outcome text,
      failure_code text,conflict_reason text,resolution text,resolved_at timestamptz,client_notified boolean,
      owner_id text,lease_epoch bigint,lease_until timestamptz,anchor_seq bigint,admitted_at timestamptz DEFAULT now(),
      accepted_at timestamptz,terminal_at timestamptz,last_attempt_at timestamptz,visible_head jsonb,visible_at bigint,
      producer_fenced_at timestamptz,shutdown_ctx jsonb,agent_container_id bigint,runtime_kind text,trace_id text);
    CREATE TEMP TABLE client_session_live_streams(stream_key text PRIMARY KEY,user_id text,session_id text,
      client_message_id text,dispatch_id uuid,attempt_no int,agent_container_id bigint,source text,
      projection_source text DEFAULT 'live',provenance jsonb DEFAULT '{}',updated_at timestamptz DEFAULT now());
    CREATE TEMP TABLE client_session_live_frames(stream_key text,source text,agent_container_id bigint,session_key text,
      frame_seq bigint,payload bytea,UNIQUE(agent_container_id,session_key,frame_seq));
    INSERT INTO client_sessions VALUES ('restored','c:42',NULL);
    INSERT INTO agent_containers VALUES (7,42,'active','v5','docker','127.0.0.1',0,NULL,'existing-container');
    INSERT INTO turn_dispatches(dispatch_id,user_id,session_id,client_message_id,agent_id,attempt_no,status,
      lease_epoch,lease_until,agent_container_id) VALUES ('${restoredDispatch}',42,'restored','turn','main',1,'accepted',2,NOW()-interval '1 minute',7);`);
  return client;
}
async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error("recovery condition timed out");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function replayFrame(seq: number): Record<string, unknown> {
  return { type: "outbound.message", sessionKey: restoredSessionKey, frameSeq: seq,
    peer: { id: "restored", kind: "dm" }, clientMessageId: "turn", isFinal: false,
    blocks: [{ kind: "text", text: `restored-${seq}` }] };
}
async function recoveryRig(client: Client, receive: (ws: WebSocket, frame: Record<string, any>) => void, extra: Partial<UserChatBridgeDeps> = {}) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>(resolve => server.once("listening", resolve));
  const sockets: WebSocket[] = [];
  server.on("connection", socket => {
    sockets.push(socket);
    socket.on("message", data => receive(socket, JSON.parse(String(data))));
  });
  await client.query("UPDATE agent_containers SET port=$1", [(server.address() as { port: number }).port]);
  const persisted: number[] = [];
  const events: string[] = [];
  let activity = 0;
  const bridge = createUserChatBridge({
    jwtSecret: "rebuild-only-fixture-secret-32-bytes",
    logger: createLogger({ out: line => events.push(line) }),
    // Real PG and low-priority shared hosts cannot promise a 60ms liveness window.
    containerLinkEnabled: true, containerLinkHeartbeatMs: 500,
    containerLinkRecovery: { spacingMs: 1, retryMs: 1, maxAttempts: 3 },
    resolveContainerEndpoint: async () => { throw new Error("recovery must never provision"); },
    resolveContainerLinkEndpoint: (uid, cid) => resolveContainerLinkEndpoint(client, "v5", uid, cid),
    pgPool: client as unknown as Pool,
    preCheckRedis: {} as UserChatBridgeDeps["preCheckRedis"],
    pricing: {} as UserChatBridgeDeps["pricing"],
    markContainerActivity: () => { activity++; }, activityKeepaliveIntervalMs: 5,
    persistOutboundFrame: async input => {
      persisted.push(input.frameSeq);
      await client.query(`INSERT INTO client_session_live_streams(stream_key,user_id,session_id,agent_container_id,source)
        VALUES ($1,'c:42','restored',7,'gateway') ON CONFLICT DO NOTHING`, [restoredKey]);
      await client.query(`INSERT INTO client_session_live_frames VALUES ($1,'gateway',7,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [restoredKey, input.sessionKey, input.frameSeq, Buffer.from(JSON.stringify(input.payload))]);
    },
    ...extra,
  });
  return { bridge, sockets, persisted, events, activity: () => activity,
    stop: async () => { await bridge.shutdown(); for (const socket of sockets) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

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


test("ContainerLink replay cursor is scoped to the persisted user, container and session", async () => {
  const client = new Client({ connectionString: getTestDatabaseUrlForTempTables(), connectionTimeoutMillis: 1500 });
  await client.connect();
  try {
    await client.query(`CREATE TEMP TABLE client_session_live_streams (stream_key text, user_id text, session_id text);
      CREATE TEMP TABLE client_session_live_frames (stream_key text, source text, agent_container_id bigint, session_key text, frame_seq bigint);
      CREATE TEMP TABLE turn_dispatches (user_id bigint, agent_container_id bigint, session_id text, client_message_id text, status text, terminal_at timestamptz, admitted_at timestamptz)`);
    await client.query(`INSERT INTO client_session_live_streams VALUES ('mine','c:42','s'),('other','c:43','s');
      INSERT INTO client_session_live_frames VALUES ('mine','gateway',7,'agent:main:webchat:dm:s',12),
        ('other','gateway',7,'agent:main:webchat:dm:s',99),('mine','gateway',8,'agent:main:webchat:dm:s',88);
      INSERT INTO turn_dispatches VALUES (42,7,'s','open-turn','accepted',NULL,NOW()),
        (42,7,'s','done-turn','terminal',NOW(),NOW()),(43,7,'s','other-turn','accepted',NULL,NOW())`);
    assert.deepEqual(await readContainerLinkReplay(client, 42n, 7, 's', 'agent:main:webchat:dm:s'), {
      afterSeq: 12, activeMessageIds: ['open-turn'],
    });
    assert.deepEqual(await readContainerLinkReplay(client, 42n, 7, 'new-session', 'agent:main:webchat:dm:new-session'), {
      afterSeq: 0, activeMessageIds: [],
    });
  } finally { await client.end(); }
});

test("startup rebuild without browser replays PG cursor and renews accepted; transport close replays once", async () => {
  const client = await recoveryFixture();
  const hellos: number[] = [];
  const rig = await recoveryRig(client, (socket, frame) => {
    if (frame.type !== "inbound.hello") return;
    const after = frame.peers[0].lastFrameSeq;
    hellos.push(after);
    socket.send(JSON.stringify(replayFrame(after + 1)));
  });
  try {
    await rig.bridge.rebuildContainerLinks!();
    await eventually(() => rig.persisted.length === 1);
    await eventually(async () => (await client.query("SELECT lease_until > NOW() AS renewed FROM turn_dispatches")).rows[0].renewed);
    assert.deepEqual(hellos, [0]);
    assert.equal(rig.bridge.containerLinkSnapshots!().length, 1, rig.events.join("\n"));
    assert.equal(rig.bridge.containerLinkSnapshots!()[0]!.subscribers, 0);
    assert.equal(rig.activity(), 0);
    rig.sockets[0]!.terminate();
    await eventually(() => rig.persisted.length === 2);
    assert.deepEqual(hellos, [0, 1]);
    assert.deepEqual(rig.persisted, [1, 2]);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM client_session_live_frames")).rows[0].n, 2);
    assert.equal(rig.sockets.filter(ws => ws.readyState === WebSocket.OPEN).length, 1);
  } finally { await rig.stop(); await client.end(); }
});

test("startup ring miss persists a scoped gap with no fabricated frames or cursor advance", async () => {
  const client = await recoveryFixture();
  const gap = { type: "outbound.resume_failed", sessionKey: restoredSessionKey, peer: { id: "restored" }, from: 0, to: 900, reason: "too_old" };
  const rig = await recoveryRig(client, (socket, frame) => {
    if (frame.type === "inbound.hello") socket.send(JSON.stringify(gap));
  });
  try {
    await rig.bridge.rebuildContainerLinks!();
    await eventually(async () => (await client.query("SELECT provenance FROM client_session_live_streams")).rows[0]?.provenance.containerLinkGap !== undefined);
    const stored = (await client.query("SELECT provenance FROM client_session_live_streams")).rows[0].provenance;
    assert.deepEqual(stored.containerLinkGap, { reason: "sequence_gap", afterSeq: 0, beforeSeq: 901 });
    assert.equal(await recordContainerLinkGap(client, 42n, 7, gap), 0, "duplicate gap is idempotent");
    assert.equal(await recordContainerLinkGap(client, 43n, 7, gap), 0, "tenant fence");
    assert.equal(await recordContainerLinkGap(client, 42n, 8, gap), 0, "carrier fence");
    assert.deepEqual(rig.persisted, []);
    assert.equal((await readContainerLinkReplay(client, 42n, 7, "restored", restoredSessionKey)).afterSeq, 0);
  } finally { await rig.stop(); await client.end(); }
});

test("vanished container is neither provisioned nor retried and restored admitted lease still expires", async () => {
  const client = await recoveryFixture();
  let hellos = 0;
  let lookups = 0;
  const rig = await recoveryRig(client, (_socket, frame) => { if (frame.type === "inbound.hello") hellos++; }, {
    resolveContainerLinkEndpoint: async (uid, cid) => { lookups++; return resolveContainerLinkEndpoint(client, "v5", uid, cid); },
  });
  try {
    await client.query("UPDATE turn_dispatches SET status='admitted'");
    await rig.bridge.rebuildContainerLinks!();
    await eventually(() => hellos === 1);
    await eventually(() => rig.events.filter(line => JSON.parse(line).msg === "container-link: heartbeat").length >= 2);
    assert.equal((await client.query("SELECT lease_until < NOW() AS expired FROM turn_dispatches")).rows[0].expired, true);
    await client.query("UPDATE agent_containers SET state='vanished'");
    rig.sockets[0]!.terminate();
    await eventually(() => lookups === 2);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(lookups, 2);
    assert.equal(rig.sockets.length, 1);
    assert.deepEqual(await scanContainerLinkCarriers(client, "v5", null), []);
  } finally { await rig.stop(); await client.end(); }
});

test("shutdown fences late endpoint lookup during startup and reconnect", async () => {
  for (const reconnect of [false, true]) {
    const client = await recoveryFixture();
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let lookups = 0;
    const rig = await recoveryRig(client, () => {}, {
      resolveContainerLinkEndpoint: async (uid, cid) => {
        lookups++;
        if (lookups === (reconnect ? 2 : 1)) await barrier;
        return resolveContainerLinkEndpoint(client, "v5", uid, cid);
      },
    });
    try {
      const start = rig.bridge.rebuildContainerLinks!();
      if (reconnect) { await start; rig.sockets[0]!.terminate(); }
      await eventually(() => lookups === (reconnect ? 2 : 1));
      const stopping = rig.bridge.shutdown();
      release(); await Promise.all([start, stopping]);
      assert.deepEqual(rig.bridge.containerLinkSnapshots!(), []);
      assert.equal(rig.sockets.length, reconnect ? 1 : 0);
    } finally { release(); await rig.stop(); await client.end(); }
  }
});

test("startup scan keyset pagination is numeric and excludes other runtime channels and deleted sessions", async () => {
  const client = await recoveryFixture();
  try {
    await client.query(`INSERT INTO client_sessions VALUES ('second','c:100',NULL),('deleted','c:99',NOW());
      INSERT INTO agent_containers(id,user_id,state,runtime_channel) VALUES (100,100,'active','v5'),(99,99,'active','v5'),(88,42,'active','v3');
      INSERT INTO turn_dispatches(dispatch_id,user_id,session_id,client_message_id,agent_id,attempt_no,status,agent_container_id)
      VALUES ('33333333-3333-4333-8333-333333333333',100,'second','m','main',1,'admitted',100),
             ('44444444-4444-4444-8444-444444444444',99,'deleted','m','main',1,'accepted',99),
             ('55555555-5555-4555-8555-555555555555',42,'restored','m','main',1,'accepted',88)`);
    assert.deepEqual(await scanContainerLinkCarriers(client, "v5", null), [{ uid: "42", containerId: 7 }, { uid: "100", containerId: 100 }]);
    assert.deepEqual(await scanContainerLinkCarriers(client, "v5", { uid: "42", containerId: 7 }), [{ uid: "100", containerId: 100 }]);
  } finally { await client.end(); }
});
