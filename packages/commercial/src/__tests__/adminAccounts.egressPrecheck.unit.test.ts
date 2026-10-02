import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { CLAUDE_EGRESS_OCCUPIED_SQL } from "../admin/accounts.js";

describe("claude 一号一代理预检 SQL", () => {
  test("只统计 active Claude，与 idx_claude_accounts_egress_proxy_uniq 一致", () => {
    assert.match(CLAUDE_EGRESS_OCCUPIED_SQL, /provider\s*=\s*'claude'/);
    assert.match(CLAUDE_EGRESS_OCCUPIED_SQL, /status\s*=\s*'active'/);
    assert.match(CLAUDE_EGRESS_OCCUPIED_SQL, /egress_proxy_id\s*=\s*\$1::bigint/);
    assert.doesNotMatch(
      CLAUDE_EGRESS_OCCUPIED_SQL.replace(/status\s*=\s*'active'/, ""),
      /status/,
    );
  });
});
