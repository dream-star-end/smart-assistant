import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { Pool } from "pg";
import { LOSSLESS_TURN_TAPE_VERSION } from "@openclaude/protocol";
import {
  _prepareLosslessTurnTapeOutsideLocks,
  _stagePreparedLosslessTurnRecords,
} from "../db/pgSessionsBackend.js";

const USER_ID = "c:1";
const SESSION_ID = "webnulldump1";
const TURN_KEY = "a".repeat(64);
const TAPE_ID = "tape-nul-original";
const CREATED_AT = 1_783_944_000_000;

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalTurn() {
  return {
    sessionId: SESSION_ID,
    agentId: "main",
    turnIndex: 1,
    clientMessageId: "m-user-nul_1",
    status: "completed" as const,
    turnKey: TURN_KEY,
    text: "done",
    createdAt: CREATED_AT,
    tools: [{
      toolUseId: "tool-sqlite",
      blockId: "tool-sqlite",
      toolName: "Read",
      inputJson: { file: "db" },
      inputPreview: "db",
      output: "SQLite format 3\u0000page",
      isError: false,
      durationMs: 1,
      ts: CREATED_AT,
    }],
  };
}

function headerRow(part: Buffer, tapeSha: string) {
  return {
    agent_id: "main",
    turn_index: 1,
    status: "completed",
    turn_key: TURN_KEY,
    tape_sha256: tapeSha,
    total_bytes: String(part.length),
    part_count: 1,
    created_at: String(CREATED_AT),
    waive_reason: null,
    finalized_at: null,
    record_storage_format: 2,
  };
}

function fakePool(part: Buffer, tapeSha: string, inserts: Array<{ payload: Buffer; contentSha256: string }>): Pool {
  const query = async (sql: string, params: unknown[] = []) => {
    if (/^BEGIN/i.test(sql) || sql === "COMMIT" || sql === "ROLLBACK" || sql.startsWith("SET LOCAL")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM client_session_turn_tapes")) {
      return { rows: [headerRow(part, tapeSha)] };
    }
    if (sql.includes("FROM client_session_turn_tape_parts")) {
      return { rows: [{ part_sha256: sha256(part), payload: part }] };
    }
    if (sql.includes("INSERT INTO client_session_turn_tape_records")) {
      const contentSha256 = String(params[7]);
      const payload = Buffer.from(params[8] as Buffer);
      inserts.push({ payload, contentSha256 });
      return {
        rows: [{
          msg_id: params[3],
          ordinal: params[4],
          role: params[5],
          ts: String(params[6]),
          content_sha256: contentSha256,
          payload,
          visible_payload: params[9],
          visible_content_sha256: params[10],
          model_sidecar_complete: false,
        }],
        rowCount: 1,
      };
    }
    if (/^\s*SELECT/i.test(sql) || sql.includes("WITH ")) return { rows: [] };
    return { rows: [], rowCount: 1 };
  };
  const client = { query, release() {} };
  return { query, connect: async () => client } as unknown as Pool;
}

test("materializing a part with \\u0000 keeps original record BYTEA and hash", async () => {
  const part = Buffer.from(JSON.stringify(canonicalTurn()), "utf8");
  assert.equal(part.includes(0), false);
  assert.ok(part.includes(Buffer.from("\\u0000", "utf8")));
  const tapeSha = sha256(part);
  const inserts: Array<{ payload: Buffer; contentSha256: string }> = [];
  const pool = fakePool(part, tapeSha, inserts);
  const request = {
    protocolVersion: LOSSLESS_TURN_TAPE_VERSION,
    action: "finalize" as const,
    sessionId: SESSION_ID,
    agentId: "main",
    turnIndex: 1,
    status: "completed" as const,
    turnKey: TURN_KEY,
    tapeId: TAPE_ID,
    tapeSha256: tapeSha,
    totalBytes: part.length,
    partCount: 1,
    createdAt: CREATED_AT,
  };
  const prepared = await _prepareLosslessTurnTapeOutsideLocks(pool, USER_ID, request, 2);
  assert.ok(prepared);
  const tool = prepared.turn.records.find((record) => record.role === "tool");
  assert.ok(tool);
  assert.ok(tool.payloadBytes.includes(Buffer.from("\\u0000", "utf8")));
  assert.equal(tool.payloadSha256, sha256(tool.payloadBytes));
  const parsedOriginal = JSON.parse(tool.payloadBytes.toString("utf8")) as { output?: string };
  assert.equal(parsedOriginal.output?.includes("\u0000"), true);

  const visible = prepared.visible[prepared.turn.records.indexOf(tool)]!;
  assert.equal(visible.bytes.includes(Buffer.from("\\u0000", "utf8")), false);
  assert.equal(visible.bytes.includes(0), false);

  await _stagePreparedLosslessTurnRecords(pool, USER_ID, request, prepared);
  const written = inserts.find((row) => row.payload.equals(tool.payloadBytes));
  assert.ok(written, "record INSERT must persist the part-derived original payload");
  assert.equal(written.contentSha256, tool.payloadSha256);
  assert.equal(written.contentSha256, sha256(tool.payloadBytes));
});
