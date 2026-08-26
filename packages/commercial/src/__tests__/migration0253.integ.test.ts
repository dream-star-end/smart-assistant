/**
 * 0253 active Claude proxy uniqueness convergence.
 *
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/migration0253.integ.test.ts'
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { generatePersona } from "../account-pool/persona.js";
import { query } from "../db/queries.js";
import { resetAndMigrateBefore, useDedicatedTestDatabase } from "./helpers/db.js";

const db = useDedicatedTestDatabase("active_claude_proxy_0253_test");
const here = path.dirname(fileURLToPath(import.meta.url));
const migration0250Path = path.resolve(
  here,
  "../db/migrations/0250_ccb_egress_region_one_proxy.sql",
);
const migration0253Path = path.resolve(
  here,
  "../db/migrations/0253_active_claude_proxy_uniqueness.sql",
);
const metadataPath = path.resolve(here, "../../../../deploy/v5/release-metadata.json");

async function addClaudeAccount(
  label: string,
  status: "active" | "disabled",
  proxyId: string,
): Promise<void> {
  await query(
    `INSERT INTO claude_accounts(
       provider,label,plan,status,
       oauth_token_enc,oauth_nonce,
       egress_proxy,egress_proxy_id,
       runtime_channel,persona
     ) VALUES (
       'claude',$1,'max',$2,
       decode('00','hex'),decode('000000000000000000000000','hex'),
       NULL,$3::bigint,
       'v5',$4::jsonb
     )`,
    [label, status, proxyId, JSON.stringify(generatePersona())],
  );
}

describe("0250/0253 active Claude proxy uniqueness", () => {
  test("allows disabled history but rejects two active accounts on one proxy", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    await resetAndMigrateBefore("0250");

    const proxy = await query<{ id: string }>(
      `INSERT INTO egress_proxies(label,url_enc,url_nonce,status)
       VALUES ('shared-history',decode('00','hex'),decode('000000000000000000000000','hex'),'active')
       RETURNING id::text`,
    );
    const proxyId = proxy.rows[0]!.id;
    await addClaudeAccount("disabled-a", "disabled", proxyId);
    await addClaudeAccount("disabled-b", "disabled", proxyId);
    await addClaudeAccount("active-a", "active", proxyId);

    await query(await readFile(migration0250Path, "utf8"));
    await addClaudeAccount("disabled-c", "disabled", proxyId);
    await assert.rejects(
      addClaudeAccount("active-b", "active", proxyId),
      /duplicate key value violates unique constraint/,
    );

    await query(await readFile(migration0253Path, "utf8"));
    const index = await query<{ def: string }>(
      `SELECT pg_get_indexdef(indexrelid) AS def
         FROM pg_index
        WHERE indexrelid='idx_claude_accounts_egress_proxy_uniq'::regclass`,
    );
    assert.match(index.rows[0]?.def ?? "", /status = 'active'/);

    const counts = await query<{ status: string; count: string }>(
      `SELECT status,count(*)::text
         FROM claude_accounts
        WHERE provider='claude' AND egress_proxy_id=$1::bigint
        GROUP BY status ORDER BY status`,
      [proxyId],
    );
    assert.deepEqual(counts.rows, [
      { status: "active", count: "1" },
      { status: "disabled", count: "3" },
    ]);

    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
      requiredMigrations: string[];
    };
    assert.ok(metadata.requiredMigrations.includes("0253_active_claude_proxy_uniqueness"));
  });
});
