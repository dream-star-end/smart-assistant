import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Pool } from "pg";

import { startGithubWorkspaceSweeper } from "../github/sessionWorkspaces.js";

describe("GitHub workspace lifecycle sweeper", () => {
  test("times out stuck clones and clears only explicitly deleted sessions", async () => {
    const calls: string[] = [];
    let call = 0;
    const pool = {
      async query(sql: string) {
        calls.push(sql);
        call++;
        if (call === 1) return { rows: [], rowCount: 2 };
        if (call === 2) return {
          rows: [
            { session_id: "deleted-session", user_id: "7" },
            { session_id: "not-yet-materialized", user_id: "8" },
          ],
          rowCount: 2,
        };
        return { rows: [], rowCount: 1 };
      },
    } as unknown as Pool;
    const sweeper = startGithubWorkspaceSweeper(pool, undefined, async (refs) => {
      assert.deepEqual(refs.map((ref) => ref.userId), ["c:7", "c:8"]);
      return refs.map((ref) => ({
        ...ref,
        state: ref.sessionId === "deleted-session" ? "deleted" as const : "missing" as const,
      }));
    });
    try {
      assert.deepEqual(await sweeper.runNow(), { timedOut: 2, orphaned: 1 });
    } finally {
      sweeper.stop();
    }

    assert.match(calls[0]!, /status IN \('pending','cloning'\)/);
    assert.match(calls[0]!, /interval '30 minutes'/);
    assert.match(calls[0]!, /error_code='workspace_timeout'/);
    assert.match(calls[0]!, /error_message=NULL/);
    assert.match(calls[1]!, /FROM github_session_workspaces/);
    assert.match(calls[1]!, /LIMIT 500/);
    assert.match(calls[1]!, /updated_at,user_id,session_id/);
    assert.match(calls[2]!, /error_code='session_deleted'/);
    assert.match(calls[2]!, /selection_version=selection_version\+1/);
    assert.match(calls[2]!, /unnest/);
    assert.doesNotMatch(calls[2]!, /NOT EXISTS/, "a not-yet-materialized session is not deletion proof");
  });

  test("keyset cursor reaches a deleted session behind 500 long-lived active rows", async () => {
    let queryCall = 0;
    const old = new Date("2026-01-01T00:00:00.000Z");
    const prefix = Array.from({ length: 500 }, (_, i) => ({
      session_id: `active-${String(i).padStart(3, "0")}`,
      user_id: String(i + 1),
      updated_at: old,
    }));
    const pool = {
      async query() {
        queryCall++;
        if (queryCall === 1 || queryCall === 3) return { rows: [], rowCount: 0 };
        if (queryCall === 2) return { rows: prefix, rowCount: prefix.length };
        if (queryCall === 4) return {
          rows: [{ session_id: "deleted-501", user_id: "999", updated_at: new Date(old.getTime() + 1) }],
          rowCount: 1,
        };
        return { rows: [], rowCount: 1 };
      },
    } as unknown as Pool;
    const sweeper = startGithubWorkspaceSweeper(pool, undefined, async (refs) => {
      assert.ok(refs.every((ref) => ref.userId.startsWith("c:")));
      return refs.map((ref) => ({
        ...ref,
        state: ref.sessionId === "deleted-501" ? "deleted" as const : "active" as const,
      }));
    });
    try {
      assert.deepEqual(await sweeper.runNow(), { timedOut: 0, orphaned: 0 });
      assert.deepEqual(await sweeper.runNow(), { timedOut: 0, orphaned: 1 });
    } finally {
      sweeper.stop();
    }
  });
});
