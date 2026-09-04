import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { query } from "../db/queries.js";
import { useDedicatedTestDatabase } from "./helpers/db.js";

const db = useDedicatedTestDatabase("desktop_gen_0259_test");

describe("0259 session_secret_generation", () => {
  test("column exists NOT NULL default 0 on existing rows", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    const col = await query<{ column_default: string | null; is_nullable: string }>(
      `SELECT column_default, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'agent_containers' AND column_name = 'session_secret_generation'`,
    );
    assert.equal(col.rows.length, 1);
    assert.equal(col.rows[0]!.is_nullable, "NO");
    assert.match(String(col.rows[0]!.column_default), /0/);
  });
});
