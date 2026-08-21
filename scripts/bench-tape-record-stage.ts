/**
 * Standalone timing for _stagePreparedLosslessTurnRecords.
 * Creates an isolated schema, stages N physical records, prints wall time.
 */
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { LOSSLESS_TURN_TAPE_VERSION } from "@openclaude/protocol";
import { _stagePreparedLosslessTurnRecords } from "../packages/commercial/src/db/pgSessionsBackend.ts";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const SCHEMA = "oc_bench_tape_stage";
const RECORD_COUNT = Number(process.env.BENCH_RECORD_COUNT ?? 3316);
const USER_ID = "c:1";
const SESSION_ID = "sess-bench-matgap";
const TAPE_ID = "a".repeat(64);
const TURN_KEY = "b".repeat(64);
const TAPE_SHA = "c".repeat(64);
const CREATED_AT = 1_700_000_000_000;

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function main(): Promise<void> {
  const admin = new Pool({ connectionString: TEST_DB_URL, max: 1 });
  await admin.query("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public");
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.query(`CREATE SCHEMA ${SCHEMA}`);
  await admin.end();

  const pool = new Pool({
    connectionString: TEST_DB_URL,
    max: 4,
    options: `-c search_path=${SCHEMA}`,
  });
  await pool.query(`
    CREATE TABLE client_session_turn_tapes (
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      tape_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      turn_index INTEGER NOT NULL,
      status TEXT NOT NULL,
      turn_key TEXT NOT NULL,
      tape_sha256 TEXT NOT NULL,
      total_bytes BIGINT NOT NULL,
      part_count INTEGER NOT NULL,
      created_at BIGINT NOT NULL,
      waive_reason TEXT,
      finalized_at BIGINT,
      record_storage_format INTEGER NOT NULL DEFAULT 2,
      PRIMARY KEY (session_id, user_id, tape_id)
    );
    CREATE TABLE client_session_turn_tape_records (
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      tape_id TEXT NOT NULL,
      msg_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      role TEXT NOT NULL,
      ts BIGINT NOT NULL,
      content_sha256 TEXT NOT NULL,
      payload BYTEA NOT NULL,
      visible_payload BYTEA,
      visible_content_sha256 TEXT,
      model_sidecar_complete BOOLEAN,
      PRIMARY KEY (session_id, user_id, tape_id, msg_id),
      UNIQUE (session_id, user_id, tape_id, ordinal)
    );
    CREATE TABLE client_session_turn_tape_model_records (
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      tape_id TEXT NOT NULL,
      physical_ordinal INTEGER NOT NULL,
      logical_ordinal INTEGER NOT NULL,
      msg_id TEXT NOT NULL,
      role TEXT NOT NULL,
      semantic_text TEXT NOT NULL,
      token_estimate INTEGER NOT NULL,
      ts BIGINT,
      client_message_id TEXT,
      PRIMARY KEY (session_id, user_id, tape_id, physical_ordinal, logical_ordinal)
    );
  `);

  const records = [];
  const visible = [];
  let recordPayloadBytes = 0;
  for (let i = 0; i < RECORD_COUNT; i++) {
    const payloadObj = {
      id: `r-${i}`,
      role: "runtime-event",
      text: `evt-${i}`,
      ts: CREATED_AT + i,
      _runtimeEvent: { type: "bench", index: i },
    };
    const payloadBytes = Buffer.from(JSON.stringify(payloadObj), "utf8");
    const payloadSha256 = sha256(payloadBytes);
    recordPayloadBytes += payloadBytes.length;
    records.push({
      id: `r-${i}`,
      role: "runtime-event",
      ts: CREATED_AT + i,
      payload: payloadObj,
      payloadBytes,
      payloadSha256,
    });
    visible.push({
      bytes: payloadBytes,
      contentSha256: payloadSha256,
      msgId: `r-${i}`,
      role: "runtime-event",
      modelRecords: [],
    });
  }

  const request = {
    protocolVersion: LOSSLESS_TURN_TAPE_VERSION,
    action: "finalize" as const,
    sessionId: SESSION_ID,
    agentId: "main",
    turnIndex: 1,
    status: "completed" as const,
    turnKey: TURN_KEY,
    tapeId: TAPE_ID,
    tapeSha256: TAPE_SHA,
    totalBytes: recordPayloadBytes,
    partCount: 1,
    createdAt: CREATED_AT,
  };

  await pool.query(
    `INSERT INTO client_session_turn_tapes
       (session_id,user_id,tape_id,agent_id,turn_index,status,turn_key,tape_sha256,
        total_bytes,part_count,created_at,record_storage_format)
     VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8,1,$9,2)`,
    [SESSION_ID, USER_ID, TAPE_ID, "main", "completed", TURN_KEY, TAPE_SHA, recordPayloadBytes, CREATED_AT],
  );

  const prepared = {
    turn: {
      payload: {},
      records,
      logicalRecordCount: RECORD_COUNT,
      logicalRecordIds: records.map((r) => r.id),
      billingAnchorId: "srv-bench-t1",
      engineBillings: [],
    },
    visible,
    partManifest: [{ partIndex: 0, partSha256: TAPE_SHA, payloadBytes: recordPayloadBytes }],
    recordPayloadBytes,
    recordStorageFormat: 2 as const,
  };

  const t0 = performance.now();
  await _stagePreparedLosslessTurnRecords(pool, USER_ID, request, prepared as never);
  const firstMs = performance.now() - t0;

  const count1 = Number(
    (await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM client_session_turn_tape_records WHERE tape_id=$1",
      [TAPE_ID],
    )).rows[0]?.n ?? "0",
  );
  const orderOk = (
    await pool.query<{ ok: boolean }>(
      `SELECT NOT EXISTS (
         SELECT 1 FROM (
           SELECT ordinal, row_number() OVER (ORDER BY ordinal) - 1 AS expected
             FROM client_session_turn_tape_records WHERE tape_id=$1
         ) q WHERE ordinal <> expected
       ) AS ok`,
      [TAPE_ID],
    )
  ).rows[0]?.ok;

  const t1 = performance.now();
  await _stagePreparedLosslessTurnRecords(pool, USER_ID, request, prepared as never);
  const secondMs = performance.now() - t1;
  const count2 = Number(
    (await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM client_session_turn_tape_records WHERE tape_id=$1",
      [TAPE_ID],
    )).rows[0]?.n ?? "0",
  );

  console.log(JSON.stringify({
    recordCount: RECORD_COUNT,
    firstStageMs: Math.round(firstMs),
    firstStageSec: Number((firstMs / 1000).toFixed(3)),
    secondStageMs: Math.round(secondMs),
    secondStageSec: Number((secondMs / 1000).toFixed(3)),
    rowsAfterFirst: count1,
    rowsAfterSecond: count2,
    orderPreserved: orderOk === true,
    idempotent: count1 === RECORD_COUNT && count2 === RECORD_COUNT,
  }, null, 2));

  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.end();
  if (count1 !== RECORD_COUNT || count2 !== RECORD_COUNT || orderOk !== true) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
