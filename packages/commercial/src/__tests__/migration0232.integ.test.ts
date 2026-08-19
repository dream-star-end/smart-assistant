/**
 * 0232 agent-group jsonb unicode sanitize.
 *
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/migration0232.integ.test.ts'
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";
const SCHEMA = "oc_migration0232_test";
const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(
  here,
  "../db/migrations/0232_agent_group_jsonb_unicode_sanitize.sql",
);

let pool: Pool;
let pgAvailable = false;

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

before(async () => {
  const probe = new Pool({ connectionString: TEST_DB_URL, max: 1, connectionTimeoutMillis: 1500 });
  try {
    await probe.query("SELECT 1");
    pgAvailable = true;
  } catch {
    if (REQUIRE_TEST_DB) throw new Error("Postgres test fixture required");
  } finally {
    await probe.end().catch(() => undefined);
  }
  if (!pgAvailable) return;

  const admin = new Pool({ connectionString: TEST_DB_URL, max: 1 });
  await admin.query("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public");
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.query(`CREATE SCHEMA ${SCHEMA}`);
  await admin.end();
  pool = new Pool({ connectionString: TEST_DB_URL, max: 2, options: `-c search_path=${SCHEMA}` });
  await pool.query(`
    CREATE TABLE client_session_turn_tapes (
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      tape_id TEXT NOT NULL,
      record_storage_format INTEGER NOT NULL DEFAULT 2,
      PRIMARY KEY(session_id,user_id,tape_id)
    );
    CREATE TABLE client_session_turn_tape_records (
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      tape_id TEXT NOT NULL,
      msg_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      payload BYTEA NOT NULL,
      PRIMARY KEY(session_id,user_id,tape_id,msg_id)
    );

    CREATE OR REPLACE FUNCTION oc_0151_canonicalize_billing_array(value JSONB)
    RETURNS JSONB LANGUAGE SQL IMMUTABLE AS $$
      SELECT COALESCE(
        jsonb_agg(
          (item - 'errorReason') ||
          CASE WHEN item->>'status'='error' THEN jsonb_build_object(
            'terminalCode',
            CASE
              WHEN item->>'terminalCode' IN ('USER_CANCELLED','CODEX_ERROR')
                THEN item->>'terminalCode'
              WHEN item->>'errorReason'='codex turn interrupted'
                THEN 'USER_CANCELLED'
              ELSE 'CODEX_ERROR'
            END
          ) ELSE '{}'::jsonb END
          ORDER BY ordinal
        ),
        '[]'::jsonb
      )
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(value)='array' THEN value ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS entries(item, ordinal)
    $$;

    CREATE OR REPLACE FUNCTION canonicalize_legacy_lossless_agent_group()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      RETURN NEW;
    END $$;
    CREATE TRIGGER trg_canonicalize_legacy_lossless_agent_group
    BEFORE INSERT OR UPDATE OF payload, role ON client_session_turn_tape_records
    FOR EACH ROW EXECUTE FUNCTION canonicalize_legacy_lossless_agent_group();
  `);
  const sql = await readFile(MIGRATION, "utf8");
  await pool.query(sql);
  await pool.query(sql);
});

after(async () => {
  if (!pgAvailable) return;
  await pool.end();
  const admin = new Pool({ connectionString: TEST_DB_URL, max: 1 });
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.end();
});

function maybe(name: string, fn: () => Promise<void>): void {
  test(name, async (t) => {
    if (!pgAvailable) return t.skip("Postgres unavailable");
    await fn();
  });
}

async function seedTape(tapeId: string, format = 2): Promise<void> {
  await pool.query(
    `INSERT INTO client_session_turn_tapes(session_id,user_id,tape_id,record_storage_format)
     VALUES ('session-0232','c:1',$1,$2)`,
    [tapeId, format],
  );
}

describe("0232_agent_group_jsonb_unicode_sanitize", () => {
  maybe("sanitize_json_text_for_jsonb matches the odd/even backslash spec", async () => {
    const cases: Array<[string, string]> = [
      ['{"a":"\\u0000"}', '{"a":"\\ufffd"}'],
      ['{"a":"\\\\u0000"}', '{"a":"\\\\u0000"}'],
      ['{"a":"\\\\\\u0000"}', '{"a":"\\\\\\ufffd"}'],
      ['"\\uD800"', '"\\ufffd"'],
      ['"\\udc00"', '"\\ufffd"'],
      ['"\\uD800\\uDC00"', '"\\uD800\\uDC00"'],
      ['"\\\\uD800"', '"\\\\uD800"'],
      ['"\\uD800\\uD800"', '"\\ufffd\\ufffd"'],
    ];
    for (const [input, expected] of cases) {
      const row = (
        await pool.query<{ out: string }>(
          "SELECT sanitize_json_text_for_jsonb($1) AS out",
          [input],
        )
      ).rows[0]!;
      assert.equal(row.out, expected, input);
    }
  });

  maybe("inserts agent-group payload containing \\u0000 without rewriting BYTEA/hash", async () => {
    const tapeId = "tape-nul";
    await seedTape(tapeId);
    const raw = Buffer.from('{"goal":"SQLite format 3\\u0000page","runId":"r1"}', "utf8");
    const inserted = (
      await pool.query<{ payload: Buffer; content_sha256: string }>(
        `INSERT INTO client_session_turn_tape_records(
           session_id,user_id,tape_id,msg_id,role,content_sha256,payload
         ) VALUES ('session-0232','c:1',$1,'group','agent-group',$2,$3)
         RETURNING payload,content_sha256`,
        [tapeId, sha256(raw), raw],
      )
    ).rows[0]!;
    assert.deepEqual(inserted.payload, raw);
    assert.equal(inserted.content_sha256, sha256(raw));
  });

  maybe("EXCEPTION fallback inserts illegal JSON instead of failing", async () => {
    const tapeId = "tape-invalid";
    await seedTape(tapeId);
    const raw = Buffer.from('{"goal":', "utf8");
    const inserted = (
      await pool.query<{ payload: Buffer; content_sha256: string }>(
        `INSERT INTO client_session_turn_tape_records(
           session_id,user_id,tape_id,msg_id,role,content_sha256,payload
         ) VALUES ('session-0232','c:1',$1,'group','agent-group',$2,$3)
         RETURNING payload,content_sha256`,
        [tapeId, sha256(raw), raw],
      )
    ).rows[0]!;
    assert.deepEqual(inserted.payload, raw);
    assert.equal(inserted.content_sha256, sha256(raw));
  });

  maybe("still scrubs a legacy billing array when JSON is legal", async () => {
    const tapeId = "tape-legacy";
    await seedTape(tapeId);
    const raw = Buffer.from(
      '{"engineBillings":[{"requestId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","status":"error","errorReason":"DO_NOT_KEEP"}],"runId":"legacy"}',
      "utf8",
    );
    await pool.query(
      `INSERT INTO client_session_turn_tape_records(
         session_id,user_id,tape_id,msg_id,role,content_sha256,payload
       ) VALUES ('session-0232','c:1',$1,'group','agent-group',$2,$3)`,
      [tapeId, sha256(raw), raw],
    );
    const row = (
      await pool.query<{
        body: Record<string, unknown>;
        content_sha256: string;
        actual_sha256: string;
      }>(
        `SELECT convert_from(payload,'UTF8')::jsonb AS body,content_sha256,
                encode(public.digest(payload,'sha256'),'hex') AS actual_sha256
           FROM client_session_turn_tape_records
          WHERE session_id='session-0232' AND user_id='c:1' AND tape_id=$1`,
        [tapeId],
      )
    ).rows[0]!;
    const billings = row.body.engineBillings as Array<Record<string, unknown>>;
    assert.equal(billings[0]!.terminalCode, "CODEX_ERROR");
    assert.equal("errorReason" in billings[0]!, false);
    assert.equal(row.content_sha256, row.actual_sha256);
  });

  maybe("format-3 tapes skip canonicalize even with a legacy billing array", async () => {
    const tapeId = "tape-fmt3";
    await seedTape(tapeId, 3);
    const raw = Buffer.from(
      '{"engineBillings":[{"requestId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","status":"error","errorReason":"KEEP_ME"}],"runId":"fmt3"}',
      "utf8",
    );
    const inserted = (
      await pool.query<{ payload: Buffer }>(
        `INSERT INTO client_session_turn_tape_records(
           session_id,user_id,tape_id,msg_id,role,content_sha256,payload
         ) VALUES ('session-0232','c:1',$1,'group','agent-group',$2,$3)
         RETURNING payload`,
        [tapeId, sha256(raw), raw],
      )
    ).rows[0]!;
    assert.deepEqual(inserted.payload, raw);
  });
});
