/**
 * bindAuthorityTurnDispatch: cron-origin 占位行收养 + 正常行身份篱笆。
 * 用 fake pool 锁 SQL 谓词与并发赢家语义,不依赖 PG。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Pool, PoolClient } from "pg";
import {
  bindAuthorityTurnDispatch,
  CRON_ORIGIN_OWNER_PREFIX,
  VerificationSponsorshipInvariantError,
} from "../billing/verificationSponsorship.js";
import { DISPATCH_LEASE_TTL_MS } from "../dispatch/turnDispatchStore.js";

const DISPATCH_ID = "00000000-0000-4000-8000-000000000031";
const USER_ID = 31n;
const SESSION_ID = "cron-origin-bind-session";
const CANONICAL = "glm-5.2";

interface DispatchRow {
  user_id: string;
  session_id: string;
  model: string | null;
  attempt_no: number;
  status: string;
  owner_id: string | null;
  lease_epoch: string;
  lease_until: Date | null;
}

function baseRow(over: Partial<DispatchRow> = {}): DispatchRow {
  return {
    user_id: USER_ID.toString(),
    session_id: SESSION_ID,
    model: null,
    attempt_no: 1,
    status: "admitted",
    owner_id: `${CRON_ORIGIN_OWNER_PREFIX}cmid-31`,
    lease_epoch: "0",
    lease_until: null,
    ...over,
  };
}

function bindInput(over: Partial<Parameters<typeof bindAuthorityTurnDispatch>[1]> = {}) {
  return {
    authorityTurnId: "a".repeat(32),
    dispatchId: DISPATCH_ID,
    userId: USER_ID,
    sessionId: SESSION_ID,
    dispatchModel: null as string | null,
    canonicalModel: CANONICAL,
    attemptNo: 1,
    ownerId: "conn-live",
    leaseEpoch: 0,
    ...over,
  };
}

function fakePool(opts: {
  row: DispatchRow;
  /** Shared store so two connects race on the same row. */
  store?: { row: DispatchRow };
}): { pool: Pool; store: { row: DispatchRow }; sql: string[] } {
  const store = opts.store ?? { row: { ...opts.row } };
  const sql: string[] = [];
  const mappings: Array<{
    authority_turn_id: string;
    user_id: string;
    dispatch_model: string | null;
    canonical_model: string;
    session_id: string;
    dispatch_id: string;
    attempt_no: number;
  }> = [];

  const makeClient = (): PoolClient => {
    const client = {
      async query(raw: string | { text: string }, params: unknown[] = []) {
        const text = (typeof raw === "string" ? raw : raw.text).replace(/\s+/g, " ").trim();
        sql.push(text);
        if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
          return { rowCount: 0, rows: [] };
        }
        if (text.includes("FROM turn_dispatches") && text.includes("FOR UPDATE")) {
          return { rowCount: store.row ? 1 : 0, rows: [{ ...store.row }] };
        }
        if (text.includes("UPDATE turn_dispatches") && text.includes("cron-origin:%")) {
          assert.match(text, /owner_id LIKE 'cron-origin:%'/);
          assert.match(text, /status = 'admitted'/);
          assert.equal(params[2], DISPATCH_LEASE_TTL_MS);
          const owner = store.row.owner_id;
          if (
            typeof owner === "string" &&
            owner.startsWith(CRON_ORIGIN_OWNER_PREFIX) &&
            store.row.status === "admitted" &&
            store.row.user_id === String(params[4]) &&
            store.row.session_id === params[5] &&
            store.row.attempt_no === params[6] &&
            store.row.lease_epoch === String(params[7])
          ) {
            store.row = {
              ...store.row,
              owner_id: String(params[1]),
              lease_until: new Date(Date.now() + DISPATCH_LEASE_TTL_MS),
              model: (params[3] as string | null) ?? null,
            };
            return { rowCount: 1, rows: [{ ...store.row }] };
          }
          return { rowCount: 0, rows: [] };
        }
        if (text.includes("INSERT INTO authority_turn_dispatches")) {
          mappings.push({
            authority_turn_id: String(params[0]),
            user_id: String(params[1]),
            dispatch_model: (params[2] as string | null) ?? null,
            canonical_model: String(params[3]),
            session_id: String(params[4]),
            dispatch_id: String(params[5]),
            attempt_no: params[6] as number,
          });
          return { rowCount: 1, rows: [] };
        }
        if (text.includes("FROM authority_turn_dispatches")) {
          return { rowCount: mappings.length, rows: mappings };
        }
        throw new Error(`unexpected sql: ${text}`);
      },
      release() {},
    };
    return client as unknown as PoolClient;
  };

  const pool = {
    connect: async () => makeClient(),
  } as unknown as Pool;
  return { pool, store, sql };
}

describe("bindAuthorityTurnDispatch cron-origin adoption", () => {
  test("adopts a cron-origin placeholder (null lease, empty model) onto the live conn", async () => {
    const { pool, store, sql } = fakePool({ row: baseRow() });
    const binding = await bindAuthorityTurnDispatch(pool, bindInput());
    assert.equal(binding.dispatchId, DISPATCH_ID);
    assert.equal(binding.sessionId, SESSION_ID);
    assert.equal(store.row.owner_id, "conn-live");
    assert.ok(store.row.lease_until !== null && store.row.lease_until.getTime() > Date.now());
    assert.equal(store.row.model, null);
    assert.ok(sql.some((s) => s.includes("owner_id LIKE 'cron-origin:%'")));
  });

  test("stamps dispatchModel during adoption", async () => {
    const { pool, store } = fakePool({ row: baseRow() });
    await bindAuthorityTurnDispatch(pool, bindInput({ dispatchModel: "glm-5.2" }));
    assert.equal(store.row.model, "glm-5.2");
    assert.equal(store.row.owner_id, "conn-live");
  });

  test("adopts cron-origin placeholder that already has model without wiping it", async () => {
    const { pool, store } = fakePool({
      row: baseRow({ model: "grok-build" }),
    });
    await bindAuthorityTurnDispatch(pool, bindInput({ dispatchModel: "grok-build" }));
    assert.equal(store.row.model, "grok-build");
    assert.equal(store.row.owner_id, "conn-live");
    assert.ok(store.row.lease_until !== null && store.row.lease_until.getTime() > Date.now());
  });

  test("normal row owner mismatch still throws (no adoption)", async () => {
    const { pool, store } = fakePool({
      row: baseRow({
        owner_id: "conn-other",
        model: null,
        lease_until: new Date(Date.now() + 60_000),
      }),
    });
    await assert.rejects(
      bindAuthorityTurnDispatch(pool, bindInput()),
      (err: unknown) =>
        err instanceof VerificationSponsorshipInvariantError &&
        err.message === "authority turn dispatch identity mismatch",
    );
    assert.equal(store.row.owner_id, "conn-other");
  });

  test("normal row expired lease still throws", async () => {
    const { pool } = fakePool({
      row: baseRow({
        owner_id: "conn-live",
        model: null,
        lease_until: new Date(Date.now() - 1_000),
      }),
    });
    await assert.rejects(
      bindAuthorityTurnDispatch(pool, bindInput()),
      VerificationSponsorshipInvariantError,
    );
  });

  test("normal row model mismatch still throws", async () => {
    const { pool, store } = fakePool({
      row: baseRow({
        owner_id: "conn-live",
        model: "glm-5.2",
        lease_until: new Date(Date.now() + 60_000),
      }),
    });
    await assert.rejects(
      bindAuthorityTurnDispatch(pool, bindInput({ dispatchModel: "deepseek-v4-flash" })),
      VerificationSponsorshipInvariantError,
    );
    assert.equal(store.row.model, "glm-5.2");
  });

  test("terminal cron-origin row is not adopted", async () => {
    const { pool, store } = fakePool({
      row: baseRow({ status: "terminal" }),
    });
    await assert.rejects(
      bindAuthorityTurnDispatch(pool, bindInput()),
      VerificationSponsorshipInvariantError,
    );
    assert.equal(store.row.owner_id, `${CRON_ORIGIN_OWNER_PREFIX}cmid-31`);
  });

  test("concurrent adoption: only one winner", async () => {
    const store = { row: baseRow() };
    const a = fakePool({ row: store.row, store });
    const b = fakePool({ row: store.row, store });
    const results = await Promise.allSettled([
      bindAuthorityTurnDispatch(a.pool, bindInput({
        authorityTurnId: "b".repeat(32),
        ownerId: "conn-a",
      })),
      bindAuthorityTurnDispatch(b.pool, bindInput({
        authorityTurnId: "c".repeat(32),
        ownerId: "conn-b",
      })),
    ]);
    assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal(results.filter((x) => x.status === "rejected").length, 1);
    assert.ok(results.some(
      (x) => x.status === "rejected" && x.reason instanceof VerificationSponsorshipInvariantError,
    ));
    assert.ok(store.row.owner_id === "conn-a" || store.row.owner_id === "conn-b");
  });
});
