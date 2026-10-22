// OCV5-575: commercial box-gpt-6-astra-pro (ChatGPT Web Pro on the shared Box) for uid 1 and uid 4 only,
// never billed, sharing the personal edition's single Chrome profile. The Box exec endpoint side of this
// (OC_BOX_EXEC_TARGET_UIDS) is covered in http/proxy/boxInteractiveMasterGate.test.ts.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";

import { boxGptWebContainerEnv, isBoxGptWebAllowedUser } from "../cursor/access.js";

const COMMERCIAL = { OC_BOX_GPT_WEB_ALLOWED_UIDS: "1,4" };

describe("OCV5-575 box-gpt-6-astra-pro allowlist", () => {
  test("commercial allows uid 1 and uid 4 only; unset keeps the personal owner 3", () => {
    for (const uid of [1, 4, "1", 4n]) assert.equal(isBoxGptWebAllowedUser(uid, COMMERCIAL), true, String(uid));
    for (const uid of [2, 3, 35, 247, 267, 765, null, undefined]) {
      assert.equal(isBoxGptWebAllowedUser(uid, COMMERCIAL), false, String(uid));
    }
    assert.equal(isBoxGptWebAllowedUser(3, {}), true);
    assert.equal(isBoxGptWebAllowedUser(1, {}), false);
    assert.equal(isBoxGptWebAllowedUser(1, { OC_BOX_GPT_WEB_ALLOWED_UIDS: "all" }), false);
  });

  test("every container gets the capability flag, 1 only for an allowed uid", () => {
    assert.equal(boxGptWebContainerEnv(1, COMMERCIAL), "OC_BOX_GPT_WEB_ALLOWED=1");
    assert.equal(boxGptWebContainerEnv(4, COMMERCIAL), "OC_BOX_GPT_WEB_ALLOWED=1");
    for (const uid of [3, 247, 765]) assert.equal(boxGptWebContainerEnv(uid, COMMERCIAL), "OC_BOX_GPT_WEB_ALLOWED=0");
    assert.equal(boxGptWebContainerEnv(3, {}), "OC_BOX_GPT_WEB_ALLOWED=1");
  });

  test("the supervisor writes the flag for every new container", async () => {
    const source = await readFile(new URL("../agent-sandbox/v3supervisor.ts", import.meta.url), "utf8");
    assert.match(source, /env\.push\(boxGptWebContainerEnv\(uid\)\);/);
  });

  test("master gates (catalog, pricing, authz, grants, chat bridge) use the allowlist, not uid 3", async () => {
    for (const file of ["../billing/modelCatalog.ts", "../billing/pricing.ts", "../billing/authzModels.ts",
      "../admin/modelGrants.ts", "../ws/userChatBridge.ts"]) {
      const source = await readFile(new URL(file, import.meta.url), "utf8");
      assert.match(source, /isBoxGptWebAllowedUser\(/, file);
      assert.doesNotMatch(source, /isBoxGptWebOwnerUid/, file);
    }
  });
});

describe("OCV5-575 box-gpt-6-astra-pro is never billed", () => {
  test("no Cursor audit row, no balance requirement, no credit budget", async () => {
    const source = await readFile(new URL("../ws/userChatBridge.ts", import.meta.url), "utf8");
    assert.match(source, /const cursorBilled = !isBoxGptWebModel\(modelCapture\);/);
    assert.match(source, /if \(cursorBilled\) cursorSpendable = await readTotalSpendableBalance\(uid\);/);
    assert.match(source, /if \(cursorSpendable !== null && cursorSpendable <= 0n\) \{/);
    assert.match(source, /if \(!isBoxGptWebModel\(modelCapture\)\) \{\n\s+await deps\.pgPool\.query\(\n\s+`INSERT INTO cursor_external_usage_audit/);
  });

  test("0318 stages a hidden, free row granted to uid 1 and uid 4 only", async () => {
    const sql = await readFile(new URL("../db/migrations/0318_commercial_box_gpt_6_astra_pro.sql", import.meta.url), "utf8");
    assert.match(sql, /^-- order-dependency: 0317_commercial_muse_media\n/);
    assert.match(sql, /SELECT 'box-gpt-6-astra-pro', 'GPT-6-Astra-Pro', 0, 0, 0, 0, multiplier, FALSE, 19, 'hidden',/);
    assert.match(sql, /AND user_id NOT IN \(1, 4\);/);
    assert.match(sql, /WHERE u\.id IN \(1, 4\)/);
    assert.match(sql, /'staged'/);
    assert.doesNotMatch(sql, /user_id\s*(=|<>)\s*3\b|\bIN \([^)]*\b3\b[^)]*\)/, "commercial uid 3 is never granted or singled out");
  });
});
