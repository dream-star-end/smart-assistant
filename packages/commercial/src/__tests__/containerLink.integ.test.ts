import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "pg";
import { readContainerLinkReplay } from "../ws/containerLinkHello.js";
import { renewContainerLinkLease } from "../ws/containerLinkStore.js";
import { DISPATCH_NO_RECEIPT_MAX_AGE_MS, heartbeatLease, touchDispatchLeaseOnLiveFrame, type TurnDispatchRow } from "../dispatch/turnDispatchStore.js";
import { getTestDatabaseUrlForTempTables } from "./helpers/db.js";
import { WebSocket, WebSocketServer } from "ws";
import type { Pool } from "pg";
import { createUserChatBridge, type UserChatBridgeDeps } from "../ws/userChatBridge.js";
import { resolveContainerLinkEndpoint } from "../ws/containerLinkEndpoint.js";
import { recordContainerLinkGap, scanContainerLinkCarriers } from "../ws/containerLinkRecoveryStore.js";
import { createLogger } from "../logging/logger.js";
import { resetDesktopTunnelRegistryForTest } from "../ws/desktopTunnelRegistry.js";
import type { DesktopMuxSession } from "../ws/desktopMux.js";
import { admitDurableControl, releaseTurnControlForRetry, type DurableControlInput } from "../dispatch/turnControlStore.js";
import { forwardRecoveryUnderRootFence, type ClaimedRecoveryJob } from "../dispatch/turnRecoveryStore.js";

const restoredDispatch = "22222222-2222-4222-8222-222222222222";
const restoredKey = `dispatch:${restoredDispatch}:1`;
const restoredSessionKey = "agent:main:webchat:dm:restored";
const fixturePools = new WeakMap<Client, Pool>();

/** Temp tables belong to one PG session. Serialize pool queries and whole
 * borrowed transactions so bridge timers cannot enter an admission's BEGIN. */
function installFixturePool(client: Client): Pool {
  const query = client.query.bind(client);
  let tail = Promise.resolve();
  const acquire = async () => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    return release;
  };
  const pool = {
    async query(sql: string, params?: unknown[]) {
      const release = await acquire();
      try { return await query(sql, params); } finally { release(); }
    },
    async connect() {
      const release = await acquire();
      let released = false;
      return { query, release() { if (!released) { released = true; release(); } } };
    },
  } as unknown as Pool;
  client.query = pool.query.bind(pool) as Client["query"];
  fixturePools.set(client, pool);
  return pool;
}

async function recoveryFixture(): Promise<Client> {
  const url = getTestDatabaseUrlForTempTables();
  assert.match(new URL(url).pathname, /_test$/);
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 1500 });
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
    CREATE TEMP TABLE turn_control_requests(control_id text PRIMARY KEY,user_id bigint,session_id text,
      root_client_message_id text,kind text,request_id text,payload_json jsonb,status text DEFAULT 'pending',
      lease_owner text,lease_epoch bigint DEFAULT 0,lease_until timestamptz,delivery_attempt int DEFAULT 0,
      next_attempt_at timestamptz DEFAULT now(),error_code text,created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),applied_at timestamptz,terminal_at timestamptz);
    CREATE TEMP TABLE turn_permission_requests(user_id bigint,request_id text,session_id text,client_message_id text,
      tool_use_id text,tool_name text,input_sha256 text,input_json jsonb,ask_payload_json jsonb,
      status text DEFAULT 'pending',expires_at timestamptz,response_control_id text,response_json jsonb,
      created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),PRIMARY KEY(user_id,request_id));
    CREATE TEMP TABLE turn_recovery_jobs(job_id uuid PRIMARY KEY,user_id bigint,session_id text,
      root_client_message_id text,source_client_message_id text,source_turn_key text,error_code text,
      recovery_mode text,semantic_recovery_attempt int,transport_wait_attempt int DEFAULT 0,request_json jsonb,
      tape_sha256 text,status text DEFAULT 'queued',lease_owner text,lease_epoch bigint DEFAULT 0,
      lease_until timestamptz,next_attempt_at timestamptz DEFAULT now(),pause_reason text,dispatch_id uuid,
      dispatch_attempt_no int,terminal_outcome text,container_receipt_at timestamptz,
      created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
    INSERT INTO client_sessions VALUES ('restored','c:42',NULL);
    INSERT INTO agent_containers VALUES (7,42,'active','v5','docker','127.0.0.1',0,NULL,'existing-container');
    INSERT INTO turn_dispatches(dispatch_id,user_id,session_id,client_message_id,agent_id,attempt_no,status,
      lease_epoch,lease_until,agent_container_id) VALUES ('${restoredDispatch}',42,'restored','turn','main',1,'accepted',2,NOW()-interval '1 minute',7);`);
  installFixturePool(client);
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
    pgPool: fixturePools.get(client)!,
    preCheckRedis: {} as UserChatBridgeDeps["preCheckRedis"],
    pricing: {} as UserChatBridgeDeps["pricing"],
    markContainerActivity: () => { activity++; }, activityKeepaliveIntervalMs: 5,
    persistOutboundFrame: async input => {
      await client.query(`INSERT INTO client_session_live_streams(stream_key,user_id,session_id,agent_container_id,source)
        VALUES ($1,'c:42','restored',7,'gateway') ON CONFLICT DO NOTHING`, [restoredKey]);
      await client.query(`INSERT INTO client_session_live_frames VALUES ($1,'gateway',7,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [restoredKey, input.sessionKey, input.frameSeq, Buffer.from(JSON.stringify(input.payload))]);
      persisted.push(input.frameSeq);
    },
    ...extra,
  });
  return { bridge, sockets, persisted, events, url: `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws`, activity: () => activity,
    stop: async () => { await bridge.shutdown(); for (const socket of sockets) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

function controlInput(controlId: string, kind: DurableControlInput["kind"] = "stop", clientMessageId = "turn"): DurableControlInput {
  const requestId = kind === "permission" ? `permission-${controlId}` : undefined;
  return {
    controlId, userId: 42n, sessionId: "restored", rootClientMessageId: clientMessageId, kind, requestId,
    payload: { type: kind === "stop" ? "inbound.control.stop" : "inbound.permission_response",
      controlId, channel: "webchat", peer: { id: "restored", kind: "dm" }, agentId: "main",
      clientMessageId, ...(requestId ? { requestId, behavior: "allow" } : {}) },
  };
}

async function admitFixtureControl(client: Client, input: DurableControlInput) {
  if (input.kind === "permission") {
    await client.query(`INSERT INTO turn_permission_requests(user_id,request_id,session_id,client_message_id,
      tool_name,input_sha256,input_json,expires_at) VALUES (42,$1,'restored',$2,'AskUserQuestion',$3,'{}',NOW()+interval '1 hour')`,
    [input.requestId, input.rootClientMessageId, "a".repeat(64)]);
  }
  return admitDurableControl(fixturePools.get(client)!, input);
}

function receiveControls(received: string[]) {
  return (socket: WebSocket, frame: Record<string, any>) => {
    if (frame.type !== "inbound.control.stop" && frame.type !== "inbound.permission_response") return;
    received.push(frame.controlId);
    socket.send(JSON.stringify({ type: "outbound.control.receipt", controlId: frame.controlId,
      controlKind: frame.type === "inbound.control.stop" ? "stop" : "permission",
      status: frame.type === "inbound.control.stop" ? "terminal" : "applied", peer: frame.peer }));
  };
}

const recoveryChildDispatch = "66666666-6666-4666-8666-666666666666";
const recoveryJobId = "77777777-7777-4777-8777-777777777777";
async function seedRecoveryChild(client: Client): Promise<ClaimedRecoveryJob> {
  await client.query(`INSERT INTO turn_dispatches(dispatch_id,user_id,session_id,client_message_id,agent_id,
    attempt_no,status,owner_id,lease_epoch,lease_until,agent_container_id)
    VALUES ($1,42,'restored','recovery-child','main',1,'admitted','physical-owner',3,NOW()+interval '1 minute',7)`,
  [recoveryChildDispatch]);
  await client.query(`INSERT INTO turn_recovery_jobs(job_id,user_id,session_id,root_client_message_id,source_client_message_id,
      source_turn_key,error_code,recovery_mode,semantic_recovery_attempt,request_json,tape_sha256,
      status,lease_owner,lease_epoch,lease_until,dispatch_id,dispatch_attempt_no)
    VALUES ($2,42,'restored','turn','turn',$3,'upstream_timeout','replay',1,
      '{"clientMessageId":"recovery-child"}',$3,'leased','recovery-owner',2,NOW()+interval '1 minute',$1,1)`,
  [recoveryChildDispatch, recoveryJobId, "a".repeat(64)]);
  return { jobId: recoveryJobId, userId: 42n, sessionId: "restored", rootClientMessageId: "turn",
    sourceClientMessageId: "turn", sourceTurnKey: "a".repeat(64), errorCode: "upstream_timeout",
    recoveryMode: "replay", semanticRecoveryAttempt: 1, transportWaitAttempt: 0,
    request: { clientMessageId: "recovery-child" }, leaseOwner: "recovery-owner", leaseEpoch: 2 };
}

function recoveryForwardInput(job: ClaimedRecoveryJob) {
  return { job, dispatchId: recoveryChildDispatch, dispatchAttemptNo: 1,
    dispatchOwner: "physical-owner", dispatchLeaseEpoch: 3 };
}

test("ContainerLink renews admitted/accepted only, fenced by user/carrier/attempt/epoch/terminal", async () => {
  const url = getTestDatabaseUrlForTempTables();
  assert.match(new URL(url).pathname, /_test$/);
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 1500 });
  await client.connect();
  try {
    await client.query(`CREATE TEMP TABLE client_sessions (id text PRIMARY KEY, user_id text, deleted_at timestamptz);
      INSERT INTO client_sessions VALUES ('lease-session', 'c:42', NULL);
      CREATE TEMP TABLE turn_dispatches (
      dispatch_id uuid PRIMARY KEY, user_id bigint, agent_container_id bigint,
      attempt_no int, lease_epoch bigint, status text, terminal_at timestamptz,
      lease_until timestamptz, last_attempt_at timestamptz,
      session_id text DEFAULT 'lease-session', admitted_at timestamptz DEFAULT NOW())`);
    const dispatchId = "11111111-1111-4111-8111-111111111111";
    await client.query(`INSERT INTO turn_dispatches(dispatch_id,user_id,agent_container_id,attempt_no,lease_epoch,status)
      VALUES ($1, 42, 7, 2, 3, 'admitted')`, [dispatchId]);
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

test("dispatch lease renewal bounds unreceipted attempts and stops for deleted or missing sessions", async () => {
  const url = getTestDatabaseUrlForTempTables();
  assert.match(new URL(url).pathname, /_test$/);
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 1500 });
  await client.connect();
  const dispatchId = "11111111-1111-4111-8111-111111111111";
  try {
    await client.query(`CREATE TEMP TABLE client_sessions(id text PRIMARY KEY,user_id text,deleted_at timestamptz);
      INSERT INTO client_sessions VALUES ('lease-session','c:42',NULL);
      CREATE TEMP TABLE turn_dispatches(dispatch_id uuid PRIMARY KEY,user_id bigint,session_id text,
        client_message_id text,agent_container_id bigint,attempt_no int,lease_epoch bigint,owner_id text,
        status text,terminal_at timestamptz,lease_until timestamptz,last_attempt_at timestamptz,admitted_at timestamptz);
      INSERT INTO turn_dispatches VALUES ('${dispatchId}',42,'lease-session','lease-message',7,2,3,'lease-owner',
        'admitted',NULL,NULL,NULL,NOW());`);
    const row = { dispatchId, attemptNo: 2, leaseEpoch: 3 };
    const renewals = [
      { name: "bridge", accepts: false, renew: () => heartbeatLease(client, { dispatchId, ownerId: "lease-owner", leaseEpoch: 3 }) },
      { name: "live frame", accepts: true, renew: () => touchDispatchLeaseOnLiveFrame(client, {
        userId: 42n, sessionId: "lease-session", clientMessageId: "lease-message",
      }) },
      { name: "physical link", accepts: true, renew: () => renewContainerLinkLease(client, 42n, 7, row) },
    ];
    for (const renewal of renewals) {
      await client.query(`UPDATE turn_dispatches SET status='admitted', lease_until=NULL,
        admitted_at=NOW()-($1::bigint * INTERVAL '1 millisecond')`, [DISPATCH_NO_RECEIPT_MAX_AGE_MS - 10_000]);
      assert.equal(await renewal.renew(), true, `${renewal.name}: admit remains live within receipt grace`);
      const capped = await client.query("SELECT EXTRACT(EPOCH FROM lease_until-admitted_at)*1000 AS age FROM turn_dispatches");
      assert.equal(Number(capped.rows[0].age), DISPATCH_NO_RECEIPT_MAX_AGE_MS, `${renewal.name}: last renewal cannot extend delivery grace`);

      await client.query(`UPDATE turn_dispatches SET lease_until=NULL,
        admitted_at=NOW()-($1::bigint * INTERVAL '1 millisecond')`, [DISPATCH_NO_RECEIPT_MAX_AGE_MS + 1_000]);
      assert.equal(await renewal.renew(), false, `${renewal.name}: stale admit cannot renew forever`);
      assert.equal((await client.query("SELECT lease_until FROM turn_dispatches")).rows[0].lease_until, null);

      await client.query("UPDATE turn_dispatches SET status='accepted', lease_until=NULL");
      assert.equal(await renewal.renew(), renewal.accepts, `${renewal.name}: accepted turn retains its existing renewal semantics`);
      if (renewal.accepts) {
        assert.equal((await client.query("SELECT lease_until>NOW() AS renewed FROM turn_dispatches")).rows[0].renewed, true);
      }
      for (const status of ["admitted", "accepted"]) {
        await client.query("UPDATE turn_dispatches SET status=$1, admitted_at=NOW(), lease_until=NULL", [status]);
        await client.query("UPDATE client_sessions SET deleted_at=NOW()");
        assert.equal(await renewal.renew(), false, `${renewal.name}: ${status} deleted session stops renewing`);
        await client.query("UPDATE client_sessions SET deleted_at=NULL, user_id='c:43'");
        assert.equal(await renewal.renew(), false, `${renewal.name}: ${status} foreign session cannot renew`);
        await client.query("DELETE FROM client_sessions");
        assert.equal(await renewal.renew(), false, `${renewal.name}: ${status} missing session stops renewing`);
        await client.query("INSERT INTO client_sessions VALUES ('lease-session','c:42',NULL)");
      }
    }
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

test("desktop cold-start and tunnel re-registration wait without spending the five reconnect attempts", async () => {
  const client = await recoveryFixture();
  const registry = resetDesktopTunnelRegistryForTest();
  let lookups = 0;
  let provisioned = 0;
  const hellos: number[] = [];
  const rig = await recoveryRig(client, (socket, frame) => {
    if (frame.type !== "inbound.hello") return;
    hellos.push(frame.peers[0].lastFrameSeq);
    socket.send(JSON.stringify(replayFrame(frame.peers[0].lastFrameSeq + 1)));
  }, {
    containerLinkRecovery: { spacingMs: 1, retryMs: 1, maxAttempts: 5 },
    resolveContainerEndpoint: async () => { provisioned++; throw new Error("must not provision"); },
    resolveContainerLinkEndpoint: async (uid, cid) => { lookups++; return resolveContainerLinkEndpoint(client, "v5", uid, cid); },
  });
  const outcomes = () => rig.events.map(line => JSON.parse(line)).filter(event => event.msg === "container-link: reconnect");
  const registerTunnel = () => registry.attach(7, { mux: {
    openWs: (path: string) => { assert.equal(path, "/ws"); return new WebSocket(rig.url); },
    close: () => { for (const socket of rig.sockets) socket.terminate(); },
  } as unknown as DesktopMuxSession }, { deviceId: "delayed-desktop", uid: 42, expiresAt: new Date(Date.now() + 60_000) });
  try {
    await client.query("UPDATE agent_containers SET runtime_kind='desktop',bound_ip=NULL,port=NULL");
    await rig.bridge.rebuildContainerLinks!();
    await eventually(() => lookups >= 8);
    assert.equal(rig.sockets.length, 0);
    assert.deepEqual(outcomes(), []);
    await registerTunnel();
    await eventually(() => rig.persisted.length === 1);
    assert.equal(outcomes().filter(event => event.outcome === "attempt").length, 1);
    assert.equal(rig.bridge.containerLinkSnapshots!()[0]!.subscribers, 0);
    assert.equal(rig.activity(), 0);

    const beforeDrop = lookups;
    registry.drop(7, "test reconnect");
    await eventually(() => lookups >= beforeDrop + 8);
    assert.equal(outcomes().filter(event => event.outcome === "attempt").length, 1);
    await registerTunnel();
    await eventually(() => rig.persisted.length === 2);
    assert.deepEqual(hellos, [0, 1]);
    for (let expected = 3; expected <= 5; expected++) {
      rig.sockets.at(-1)!.terminate();
      await eventually(() => rig.persisted.length === expected);
    }
    rig.sockets.at(-1)!.terminate();
    await eventually(() => outcomes().some(event => event.outcome === "exhausted"));
    assert.deepEqual(hellos, [0, 1, 2, 3, 4]);
    assert.deepEqual(rig.persisted, [1, 2, 3, 4, 5]);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM client_session_live_frames")).rows[0].n, 5);
    assert.equal(rig.sockets.length, 5);
    assert.equal(outcomes().filter(event => event.outcome === "attempt").length, 5);
    assert.equal(outcomes().filter(event => event.outcome === "vanished").length, 0);
    assert.equal(provisioned, 0);
  } finally { await rig.stop(); registry.dropAll(); await client.end(); }
});

test("desktop waiting for a tunnel stops when the exact PG carrier is no longer active", async () => {
  const client = await recoveryFixture();
  const registry = resetDesktopTunnelRegistryForTest();
  let lookups = 0;
  const rig = await recoveryRig(client, () => {}, {
    resolveContainerLinkEndpoint: async (uid, cid) => { lookups++; return resolveContainerLinkEndpoint(client, "v5", uid, cid); },
  });
  try {
    await client.query("UPDATE agent_containers SET runtime_kind='desktop'");
    assert.equal(await resolveContainerLinkEndpoint(client, "v5", 43n, 7), null);
    assert.equal(await resolveContainerLinkEndpoint(client, "v3", 42n, 7), null);
    assert.equal(await resolveContainerLinkEndpoint(client, "v5", 42n, 8), null);
    await rig.bridge.rebuildContainerLinks!();
    await eventually(() => lookups >= 8);
    await client.query("UPDATE agent_containers SET state='vanished'");
    await eventually(() => rig.events.some(line => JSON.parse(line).outcome === "vanished"));
    const stoppedAt = lookups;
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(lookups, stoppedAt);
    assert.equal(rig.sockets.length, 0);
    assert.equal(await resolveContainerLinkEndpoint(client, "v5", 42n, 7), null);
  } finally { await rig.stop(); registry.dropAll(); await client.end(); }
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

test("browser-free rebuilt link delivers durable Stop and permission once and commits runtime receipts", async () => {
  const client = await recoveryFixture();
  const received: string[] = [];
  await admitFixtureControl(client, controlInput("offline-permission", "permission"));
  await admitFixtureControl(client, controlInput("offline-stop"));
  const rig = await recoveryRig(client, receiveControls(received));
  try {
    await Promise.all([rig.bridge.rebuildContainerLinks!(), rig.bridge.rebuildContainerLinks!()]);
    await eventually(async () => (await client.query(`SELECT count(*)::int AS n FROM turn_control_requests
      WHERE (control_id='offline-stop' AND status='terminal')
         OR (control_id='offline-permission' AND status='applied')`)).rows[0].n === 2);
    await new Promise(resolve => setTimeout(resolve, 2100));
    assert.deepEqual(received.sort(), ["offline-permission", "offline-stop"]);
    assert.equal(rig.sockets.length, 1, rig.events.join("\n"));
    assert.equal(rig.bridge.containerLinkSnapshots!()[0]!.subscribers, 0);
    assert.equal(rig.bridge.registry.total(), 0);
    assert.equal(rig.activity(), 0);
    const rows = (await client.query("SELECT control_id,delivery_attempt FROM turn_control_requests ORDER BY control_id")).rows;
    assert.deepEqual(rows, [{ control_id: "offline-permission", delivery_attempt: 1 },
      { control_id: "offline-stop", delivery_attempt: 1 }]);
    assert.equal((await client.query("SELECT status,response_control_id FROM turn_permission_requests")).rows[0].status, "responded");
  } finally { await rig.stop(); await client.end(); }
});

test("due controls with no dispatch wake one link, reclaim expired leases and survive a Master restart without resend", async () => {
  const client = await recoveryFixture();
  await client.query("DELETE FROM turn_dispatches");
  for (const id of ["control-only-pending", "control-only-expired", "control-only-future"]) {
    await admitFixtureControl(client, controlInput(id));
  }
  await client.query(`UPDATE turn_control_requests SET status='leased',lease_owner='previous-master',
    lease_epoch=4,delivery_attempt=2,lease_until=CASE WHEN control_id='control-only-expired'
      THEN NOW()-interval '1 minute' ELSE NOW()+interval '10 minutes' END
    WHERE control_id IN ('control-only-expired','control-only-future')`);
  const received: string[] = [];
  let rig = await recoveryRig(client, receiveControls(received));
  try {
    // No startup dispatch carrier exists: only the control scan can dial.
    await Promise.all([rig.bridge.rebuildContainerLinks!(), rig.bridge.rebuildContainerLinks!()]);
    await eventually(async () => (await client.query("SELECT count(*)::int AS n FROM turn_control_requests WHERE status='terminal'")).rows[0].n === 2);
    assert.deepEqual([...received].sort(), ["control-only-expired", "control-only-pending"]);
    assert.equal(rig.sockets.length, 1, rig.events.join("\n"));
    assert.equal(rig.bridge.containerLinkSnapshots!()[0]!.subscribers, 0);
    assert.equal(rig.bridge.registry.total(), 0);
    assert.equal(rig.activity(), 0);
    assert.deepEqual((await client.query(`SELECT control_id,status,lease_epoch::int,delivery_attempt
      FROM turn_control_requests ORDER BY control_id`)).rows, [
      { control_id: "control-only-expired", status: "terminal", lease_epoch: 5, delivery_attempt: 3 },
      { control_id: "control-only-future", status: "leased", lease_epoch: 4, delivery_attempt: 2 },
      { control_id: "control-only-pending", status: "terminal", lease_epoch: 1, delivery_attempt: 1 },
    ]);
    assert.equal(await releaseTurnControlForRetry(fixturePools.get(client)!, {
      controlId: "control-only-expired", leaseOwner: "previous-master", leaseEpoch: 4, deliveryAttempt: 2,
    }), false, "old Master cannot release a taken-over control");
    await rig.stop();
    rig = await recoveryRig(client, receiveControls(received));
    await rig.bridge.rebuildContainerLinks!();
    await new Promise(resolve => setTimeout(resolve, 2100));
    assert.deepEqual([...received].sort(), ["control-only-expired", "control-only-pending"]);
    assert.equal(rig.sockets.length, 0, "settled controls and unexpired leases cannot wake a new link");
    assert.equal((await client.query("SELECT count(*)::int AS n FROM turn_dispatches")).rows[0].n, 0);
  } finally { await rig.stop(); await client.end(); }
});

test("Stop admission and exact-root recovery cancellation roll back together and fence later physical forward", async () => {
  const client = await recoveryFixture();
  const pool = fixturePools.get(client)!;
  try {
    const job = await seedRecoveryChild(client);
    await client.query(`INSERT INTO turn_permission_requests(user_id,request_id,session_id,client_message_id,status,expires_at)
      VALUES (42,'root-prompt','restored','turn','pending',NOW()+interval '1 hour'),
             (42,'child-prompt','restored','recovery-child','pending',NOW()+interval '1 hour'),
             (42,'ask-user:detached','restored','turn','pending',NOW()+interval '1 hour'),
             (42,'unrelated-prompt','restored','unrelated','pending',NOW()+interval '1 hour');
      INSERT INTO turn_recovery_jobs(job_id,user_id,session_id,root_client_message_id,status,request_json,semantic_recovery_attempt)
      VALUES ('88888888-8888-4888-8888-888888888888',42,'restored','unrelated','queued','{}',1);
      CREATE FUNCTION pg_temp.reject_control_cancel() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN RAISE EXCEPTION 'fixture recovery cancellation failure'; END $$;
      CREATE TRIGGER reject_control_cancel BEFORE UPDATE ON turn_recovery_jobs
        FOR EACH ROW WHEN (NEW.status='cancelled') EXECUTE FUNCTION pg_temp.reject_control_cancel()`);
    const input = controlInput("transactional-stop");
    await assert.rejects(admitDurableControl(pool, input), /fixture recovery cancellation failure/);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM turn_control_requests")).rows[0].n, 0);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM turn_permission_requests WHERE status='pending'")).rows[0].n, 4);
    assert.equal((await client.query("SELECT status FROM turn_recovery_jobs WHERE job_id=$1", [recoveryJobId])).rows[0].status, "leased");
    assert.equal((await client.query("SELECT status FROM turn_dispatches WHERE dispatch_id=$1", [recoveryChildDispatch])).rows[0].status, "admitted");
    await client.query("DROP TRIGGER reject_control_cancel ON turn_recovery_jobs");
    assert.equal((await admitDurableControl(pool, input)).status, "pending");
    assert.deepEqual((await client.query("SELECT root_client_message_id,status FROM turn_recovery_jobs ORDER BY root_client_message_id")).rows,
      [{ root_client_message_id: "turn", status: "cancelled" }, { root_client_message_id: "unrelated", status: "queued" }]);
    assert.deepEqual((await client.query("SELECT request_id,status FROM turn_permission_requests ORDER BY request_id")).rows, [
      { request_id: "ask-user:detached", status: "pending" }, { request_id: "child-prompt", status: "cancelled" },
      { request_id: "root-prompt", status: "cancelled" }, { request_id: "unrelated-prompt", status: "pending" },
    ]);
    assert.deepEqual((await client.query("SELECT status,outcome,failure_code FROM turn_dispatches WHERE dispatch_id=$1", [recoveryChildDispatch])).rows[0],
      { status: "terminal", outcome: "not_accepted", failure_code: "USER_CANCELLED" });
    let forwarded = false;
    assert.equal(await forwardRecoveryUnderRootFence(pool, recoveryForwardInput(job), () => { forwarded = true; return true; }), false);
    assert.equal(forwarded, false, "committed Stop forbids the recovery's physical enqueue");
  } finally { await client.end(); }
});

test("recovery forward that wins the root fence keeps its dispatch live for a physical Stop even when the root ended", async () => {
  const client = await recoveryFixture();
  const pool = fixturePools.get(client)!;
  try {
    const job = await seedRecoveryChild(client);
    await client.query("UPDATE turn_dispatches SET status='terminal',terminal_at=NOW(),outcome='completed' WHERE dispatch_id=$1", [restoredDispatch]);
    let forwards = 0;
    assert.equal(await forwardRecoveryUnderRootFence(pool, recoveryForwardInput(job), () => { forwards++; return true; }), true);
    assert.equal(forwards, 1);
    assert.equal((await client.query("SELECT status FROM turn_recovery_jobs WHERE job_id=$1", [recoveryJobId])).rows[0].status, "sent");
    const result = await admitDurableControl(pool, controlInput("stop-sent-recovery"));
    assert.equal(result.status, "pending", "a terminal parent cannot suppress Stop for its sent recovery child");
    assert.equal((await client.query("SELECT status,error_code FROM turn_control_requests")).rows[0].error_code, null);
    assert.equal((await client.query("SELECT status FROM turn_recovery_jobs WHERE job_id=$1", [recoveryJobId])).rows[0].status, "cancelled");
    assert.deepEqual((await client.query("SELECT status,outcome,terminal_at FROM turn_dispatches WHERE dispatch_id=$1", [recoveryChildDispatch])).rows[0],
      { status: "admitted", outcome: null, terminal_at: null });
  } finally { await client.end(); }
});

test("exact terminal Stop persists and replays the truthful ended reason without becoming due for delivery", async () => {
  const client = await recoveryFixture();
  const pool = fixturePools.get(client)!;
  try {
    await client.query("UPDATE turn_dispatches SET status='terminal',terminal_at=NOW(),outcome='completed'");
    const input = controlInput("already-ended-stop");
    assert.deepEqual(await admitDurableControl(pool, input), { inserted: true, status: "terminal", errorCode: "TURN_ALREADY_ENDED" });
    assert.deepEqual(await admitDurableControl(pool, input), { inserted: false, status: "terminal", errorCode: "TURN_ALREADY_ENDED" });
    assert.deepEqual((await client.query("SELECT status,error_code,delivery_attempt FROM turn_control_requests")).rows[0],
      { status: "terminal", error_code: "TURN_ALREADY_ENDED", delivery_attempt: 0 });
    const received: string[] = [];
    const rig = await recoveryRig(client, receiveControls(received));
    try {
      await rig.bridge.rebuildContainerLinks!();
      await new Promise(resolve => setTimeout(resolve, 1100));
      assert.deepEqual(received, []);
      assert.equal(rig.sockets.length, 0);
    } finally { await rig.stop(); }
  } finally { await client.end(); }
});

test("control routing selects the exact user/session/turn carrier and leaves ambiguous or unauthorized controls unclaimed", async () => {
  const client = await recoveryFixture();
  const pool = fixturePools.get(client)!;
  await client.query(`INSERT INTO client_sessions VALUES
      ('ambiguous','c:42',NULL),('wrong-channel','c:42',NULL),
      ('deleted-control','c:42',NOW()),('foreign-control','c:43',NULL),('other-session','c:42',NULL);
    INSERT INTO agent_containers(id,user_id,state,runtime_channel,runtime_kind)
      VALUES (8,42,'active','v5','desktop'),(9,42,'active','v3','docker');
    INSERT INTO turn_dispatches(dispatch_id,user_id,session_id,client_message_id,agent_id,attempt_no,status,agent_container_id,admitted_at)
      VALUES ('a1111111-1111-4111-8111-111111111111',42,'restored','newer-other-turn','main',1,'terminal',8,NOW()+interval '1 minute'),
             ('a2222222-2222-4222-8222-222222222222',43,'restored','turn','main',1,'terminal',8,NOW()+interval '2 minutes'),
             ('a3333333-3333-4333-8333-333333333333',42,'other-session','turn','main',1,'terminal',8,NOW()+interval '3 minutes'),
             ('a4444444-4444-4444-8444-444444444444',42,'wrong-channel','turn','main',1,'accepted',9,NOW()),
             ('a5555555-5555-4555-8555-555555555555',42,'deleted-control','turn','main',1,'accepted',7,NOW()),
             ('a6666666-6666-4666-8666-666666666666',42,'foreign-control','turn','main',1,'accepted',7,NOW())`);
  await admitDurableControl(pool, controlInput("routing-exact"));
  for (const [id, sessionId] of [
    ["routing-ambiguous", "ambiguous"], ["routing-channel", "wrong-channel"],
    ["routing-deleted", "deleted-control"], ["routing-foreign", "foreign-control"],
  ] as const) {
    const input = controlInput(id);
    input.sessionId = sessionId;
    input.payload.peer = { id: sessionId, kind: "dm" };
    await admitDurableControl(pool, input);
  }
  const received: string[] = [];
  const lookups: number[] = [];
  const rig = await recoveryRig(client, receiveControls(received), {
    resolveContainerLinkEndpoint: async (uid, cid) => {
      lookups.push(cid);
      return resolveContainerLinkEndpoint(client, "v5", uid, cid);
    },
  });
  try {
    // Let only the durable-control timer discover work. An ambiguous prompt
    // has no dispatch and must never guess between the docker and desktop.
    await eventually(async () => (await client.query("SELECT status FROM turn_control_requests WHERE control_id='routing-exact'")).rows[0].status === "terminal");
    await new Promise(resolve => setTimeout(resolve, 2100));
    assert.deepEqual(received, ["routing-exact"]);
    assert.deepEqual(lookups, [7], rig.events.join("\n"));
    assert.equal(rig.sockets.length, 1);
    assert.deepEqual(rig.bridge.containerLinkSnapshots!().map(link => ({ uid: link.uid, containerId: link.containerId, subscribers: link.subscribers })),
      [{ uid: "42", containerId: 7, subscribers: 0 }]);
    assert.deepEqual((await client.query(`SELECT control_id,status,delivery_attempt FROM turn_control_requests
      WHERE control_id<>'routing-exact' ORDER BY control_id`)).rows, [
      { control_id: "routing-ambiguous", status: "pending", delivery_attempt: 0 },
      { control_id: "routing-channel", status: "pending", delivery_attempt: 0 },
      { control_id: "routing-deleted", status: "pending", delivery_attempt: 0 },
      { control_id: "routing-foreign", status: "pending", delivery_attempt: 0 },
    ]);
    assert.equal(rig.bridge.registry.total(), 0);
    assert.equal(rig.activity(), 0);
  } finally { await rig.stop(); await client.end(); }
});
