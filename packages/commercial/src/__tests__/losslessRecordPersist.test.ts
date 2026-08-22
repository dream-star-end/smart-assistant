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
    agentGroups: [{
      runId: "run-nul-1",
      agentId: "child",
      goal: "inspect SQLite format 3\u0000page",
      completedAt: CREATED_AT,
      status: "ok" as const,
      resultSummary: "SQLite format 3\u0000page",
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

function fakePool(
  part: Buffer,
  tapeSha: string,
  inserts: Array<{ role: string; payload: Buffer; contentSha256: string }>,
  sqls: string[],
): Pool {
  const query = async (sql: string, params: unknown[] = []) => {
    sqls.push(sql);
    if (sql.includes("session_replication_role")) {
      throw Object.assign(new Error("permission denied to set parameter \"session_replication_role\""), {
        code: "42501",
      });
    }
    if (/^BEGIN/i.test(sql) || sql === "COMMIT" || sql === "ROLLBACK" || sql.startsWith("SET LOCAL")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM client_session_turn_tapes")) {
      return { rows: [headerRow(part, tapeSha)] };
    }
    if (sql.includes("FROM client_session_turn_tape_parts")) {
      if (sql.includes("octet_length(payload)")) {
        return {
          rows: [{
            part_index: 0,
            part_sha256: sha256(part),
            payload_bytes: String(part.length),
          }],
        };
      }
      return { rows: [{ part_sha256: sha256(part), payload: part }] };
    }
    if (sql.includes("INSERT INTO client_session_turn_tape_records")) {
      const msgIds = Array.isArray(params[3]) ? params[3] as string[] : [String(params[3])];
      const ordinals = Array.isArray(params[4]) ? params[4] as number[] : [Number(params[4])];
      const roles = Array.isArray(params[5]) ? params[5] as string[] : [String(params[5])];
      const tss = Array.isArray(params[6]) ? params[6] as Array<string | number> : [params[6] as string | number];
      const shas = Array.isArray(params[7]) ? params[7] as string[] : [String(params[7])];
      const payloads = Array.isArray(params[8]) ? params[8] as Buffer[] : [Buffer.from(params[8] as Buffer)];
      const visibles = Array.isArray(params[9]) ? params[9] as Buffer[] : [params[9] as Buffer];
      const visibleShas = Array.isArray(params[10]) ? params[10] as string[] : [String(params[10])];
      const rows = msgIds.map((msgId, index) => {
        const payload = Buffer.from(payloads[index]!);
        const contentSha256 = String(shas[index]);
        inserts.push({ role: String(roles[index]), payload, contentSha256 });
        return {
          msg_id: msgId,
          ordinal: Number(ordinals[index]),
          role: String(roles[index]),
          ts: String(tss[index]),
          content_sha256: contentSha256,
          payload,
          visible_payload: visibles[index],
          visible_content_sha256: visibleShas[index],
          model_sidecar_complete: false,
        };
      });
      return { rows, rowCount: rows.length };
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
  const inserts: Array<{ role: string; payload: Buffer; contentSha256: string }> = [];
  const sqls: string[] = [];
  const pool = fakePool(part, tapeSha, inserts, sqls);
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

  const group = prepared.turn.records.find((record) => record.role === "agent-group");
  assert.ok(group);
  assert.ok(group.payloadBytes.includes(Buffer.from("\\u0000", "utf8")));
  assert.equal(group.payloadSha256, sha256(group.payloadBytes));
  const parsedGroup = JSON.parse(group.payloadBytes.toString("utf8")) as {
    _delegateGoal?: string;
    resultSummary?: string;
  };
  assert.equal(parsedGroup._delegateGoal?.includes("\u0000"), true);

  const visible = prepared.visible[prepared.turn.records.indexOf(tool)]!;
  assert.ok(visible.bytes.includes(Buffer.from("\\u0000", "utf8")), "visible BYTEA keeps JSON \\u0000 escapes");
  assert.equal(visible.bytes.includes(0), false);
  const visibleGroup = prepared.visible[prepared.turn.records.indexOf(group)]!;
  assert.ok(visibleGroup.bytes.includes(Buffer.from("\\u0000", "utf8")));

  await _stagePreparedLosslessTurnRecords(pool, USER_ID, request, prepared);
  assert.equal(sqls.some((sql) => sql.includes("session_replication_role")), false);
  assert.equal(sqls.some((sql) => sql.includes("INSERT INTO client_session_turn_tape_records") && sql.includes("unnest(")), true);

  const writtenTool = inserts.find((row) => row.payload.equals(tool.payloadBytes));
  assert.ok(writtenTool, "record INSERT must persist the part-derived original tool payload");
  assert.equal(writtenTool.contentSha256, tool.payloadSha256);
  assert.equal(writtenTool.contentSha256, sha256(tool.payloadBytes));

  const writtenGroup = inserts.find((row) => row.role === "agent-group");
  assert.ok(writtenGroup, "agent-group record INSERT must succeed");
  assert.ok(writtenGroup.payload.equals(group.payloadBytes), "agent-group payload BYTEA must match parts");
  assert.equal(writtenGroup.contentSha256, group.payloadSha256);
  assert.equal(writtenGroup.contentSha256, sha256(group.payloadBytes));
});
