/**
 * 0240 last_read_at:list 派生 unread、POST read / read-all / unread-migrate、存量回填、跨 user 隔离。
 *
 * Run: REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/sessionUnread.integ.test.ts'
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, beforeEach, describe, test } from "node:test";
import type { Pool } from "pg";
import type { ClientSession } from "@openclaude/storage";
import { createPgSessionsBackend, type PgSessionsBackend } from "../db/pgSessionsBackend.js";
import { getPool } from "../db/index.js";
import { useDedicatedTestDatabase } from "./helpers/db.js";

const db = useDedicatedTestDatabase("session_unread_0240_test");

let backend: PgSessionsBackend;
let pool: Pool;

const USER_A = "c:41";
const USER_B = "c:42";
const UID_A = 41;
const UID_B = 42;

function mkSession(over: Partial<ClientSession> = {}): ClientSession {
  const now = Date.now();
  return {
    id: over.id ?? "webunread01",
    userId: over.userId ?? USER_A,
    agentId: over.agentId ?? "main",
    title: over.title ?? "未读会话",
    pinned: over.pinned ?? false,
    createdAt: over.createdAt ?? now,
    lastAt: over.lastAt ?? now,
    messages: over.messages ?? [],
    updatedAt: over.updatedAt ?? now,
  };
}

async function insertTerminal(opts: {
  userId: number;
  sessionId: string;
  outcome: "completed" | "interrupted" | "crashed" | "not_accepted" | "executed_error";
  terminalAtMs: number;
  clientMessageId?: string;
}): Promise<void> {
  const dispatchId = randomUUID();
  await pool.query(
    `INSERT INTO turn_dispatches
       (dispatch_id, user_id, session_id, client_message_id, agent_id, request_hash,
        billing_request_id, status, outcome, terminal_at, admitted_at)
     VALUES ($1, $2, $3, $4, 'main', $5, $6, 'terminal', $7, to_timestamp($8 / 1000.0), to_timestamp($8 / 1000.0))`,
    [
      dispatchId,
      opts.userId,
      opts.sessionId,
      opts.clientMessageId ?? `cm-${dispatchId.slice(0, 8)}`,
      "a".repeat(64),
      `bill-${dispatchId}`,
      opts.outcome,
      opts.terminalAtMs,
    ],
  );
}

describe("0240 client_sessions.last_read_at unread", () => {
  before(async () => {
    if (!db.available) return;
    pool = getPool() as unknown as Pool;
    backend = createPgSessionsBackend(pool, { expectedGeneration: 1 });
  });

  beforeEach(async () => {
    if (!db.available) return;
    await pool.query("TRUNCATE turn_dispatches, client_sessions CASCADE");
  });

  test("终态后 list unread=true;POST read 后 false;跨 user 隔离", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    const sid = "webunreada1";
    const terminalAt = Date.now();
    assert.equal(await backend.upsertClientSession(mkSession({ id: sid, userId: USER_A })), "applied");
    await insertTerminal({ userId: UID_A, sessionId: sid, outcome: "completed", terminalAtMs: terminalAt });

    const listed = await backend.listClientSessions(USER_A);
    const row = listed.sessions.find((s) => s.id === sid);
    assert.equal(row?.unread, true);

    const other = await backend.listClientSessions(USER_B);
    assert.equal(other.sessions.find((s) => s.id === sid), undefined);

    const stolen = await backend.markClientSessionRead(USER_B, sid);
    assert.equal(stolen.ok, false);
    assert.equal((await backend.listClientSessions(USER_A)).sessions.find((s) => s.id === sid)?.unread, true);

    const read = await backend.markClientSessionRead(USER_A, sid);
    assert.equal(read.ok, true);
    assert.equal((await backend.listClientSessions(USER_A)).sessions.find((s) => s.id === sid)?.unread, false);
  });

  test("存量回填 last_read_at=last_at 后全部已读", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    const sid = "webunreada2";
    const lastAt = 1_700_000_000_000;
    assert.equal(
      await backend.upsertClientSession(mkSession({ id: sid, userId: USER_A, lastAt, createdAt: lastAt, updatedAt: lastAt })),
      "applied",
    );
    await insertTerminal({
      userId: UID_A,
      sessionId: sid,
      outcome: "crashed",
      terminalAtMs: lastAt - 5_000,
    });
    assert.equal((await backend.listClientSessions(USER_A)).sessions.find((s) => s.id === sid)?.unread, true);
    await pool.query("UPDATE client_sessions SET last_read_at = last_at WHERE last_read_at IS NULL");
    assert.equal((await backend.listClientSessions(USER_A)).sessions.find((s) => s.id === sid)?.unread, false);
  });

  test("unread-migrate 把指定 id 变回未读;read-all 全清;search 带 unread", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    const sid = "webunreada3";
    assert.equal(
      await backend.upsertClientSession(mkSession({ id: sid, userId: USER_A, title: "migrate-me-alpha" })),
      "applied",
    );
    await insertTerminal({
      userId: UID_A,
      sessionId: sid,
      outcome: "interrupted",
      terminalAtMs: Date.now(),
    });
    assert.equal((await backend.markClientSessionRead(USER_A, sid)).ok, true);
    assert.equal((await backend.listClientSessions(USER_A)).sessions.find((s) => s.id === sid)?.unread, false);

    const migrated = await backend.migrateClientSessionsUnread(USER_A, [sid]);
    assert.equal(migrated.ok, true);
    assert.equal((await backend.listClientSessions(USER_A)).sessions.find((s) => s.id === sid)?.unread, true);

    const hits = await backend.searchClientSessions(USER_A, { q: "migrate-me" });
    const hit = hits.results.find((h) => h.sessionId === sid);
    assert.ok(hit);
    assert.equal(hit.unread, true);

    const otherMigrate = await backend.migrateClientSessionsUnread(USER_B, [sid]);
    assert.equal(otherMigrate.ok, true);
    assert.equal(otherMigrate.updated, 0);
    assert.equal((await backend.listClientSessions(USER_A)).sessions.find((s) => s.id === sid)?.unread, true);

    const all = await backend.markAllClientSessionsRead(USER_A);
    assert.ok(all.updated >= 1);
    assert.equal((await backend.listClientSessions(USER_A)).sessions.find((s) => s.id === sid)?.unread, false);
  });
});
