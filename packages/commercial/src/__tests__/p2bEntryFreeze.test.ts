/**
 * P2b entry freeze (arch plan v3.6 §4.2; docs/ARCH_P2B_FUND_ENTRY_GATES.md §6.4 B4/B6/B7).
 * Pins what the admin gates and the token parsers do TODAY so the P4b auth rewrite cannot
 * change it silently. Cases marked "known gap" freeze weak behaviour on purpose; the PR that
 * fixes one flips its case and says so.
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Pool } from "pg";
import { signAccess, verifyAccess, JwtError } from "../auth/jwt.js";
import { parseContainerToken, ContainerIdentityError } from "../auth/containerIdentity.js";
import { requireAdmin, requireAdminVerifyDb } from "../admin/requireAdmin.js";
import { closePool, setPoolOverride } from "../db/index.js";
import { HttpError } from "../http/util.js";

const SECRET = "p".repeat(64);
let onQuery: (sql: string) => Promise<{ rows: unknown[]; rowCount: number }>;
const queried: string[] = [];

before(async () => {
  await closePool();
  setPoolOverride({
    query: async (sql: string) => { queried.push(sql); return onQuery(sql); },
    end: async () => {},
  } as unknown as Pool);
});

after(async () => { await closePool(); });

async function adminReq(): Promise<IncomingMessage> {
  const { token } = await signAccess({ sub: "7", role: "admin" }, SECRET);
  return { headers: { authorization: `Bearer ${token}` } } as IncomingMessage;
}

function dbRow(row: Record<string, string> | null) {
  return async () => ({ rows: row ? [row] : [], rowCount: row ? 1 : 0 });
}

function forbidden(err: unknown): boolean {
  return err instanceof HttpError && err.status === 403 && err.code === "FORBIDDEN";
}

describe("B4 admin gates: JWT-only requireAdmin vs DB-checked requireAdminVerifyDb", () => {
  test("known gap: requireAdmin trusts the JWT role and never reads the DB (/api/me/api-keys* use it)", async () => {
    queried.length = 0;
    onQuery = async () => { throw new Error("must not be called"); };
    assert.equal((await requireAdmin(await adminReq(), SECRET)).role, "admin");
    assert.deepEqual(queried, []);
  });

  test("requireAdminVerifyDb rejects an admin token whose DB role was demoted", async () => {
    onQuery = dbRow({ role: "user", status: "active" });
    await assert.rejects(requireAdminVerifyDb(await adminReq(), SECRET), forbidden);
  });

  test("requireAdminVerifyDb rejects a banned admin and a deleted admin", async () => {
    onQuery = dbRow({ role: "admin", status: "banned" });
    await assert.rejects(requireAdminVerifyDb(await adminReq(), SECRET), forbidden);
    onQuery = dbRow(null);
    await assert.rejects(requireAdminVerifyDb(await adminReq(), SECRET), forbidden);
  });

  test("requireAdminVerifyDb passes an active admin", async () => {
    onQuery = dbRow({ role: "admin", status: "active" });
    assert.equal((await requireAdminVerifyDb(await adminReq(), SECRET)).id, "7");
  });
});

describe("B7 DB read failure on the admin gate", () => {
  test("requireAdminVerifyDb fails closed: the DB error propagates, the request is not admitted", async () => {
    onQuery = async () => { throw new Error("db down"); };
    await assert.rejects(requireAdminVerifyDb(await adminReq(), SECRET), /db down/);
  });
});

describe("B6 cross-purpose tokens", () => {
  test("a personal gateway JWT ({userId, exp}, HS256, same secret) is rejected by verifyAccess", async () => {
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const h = b64({ alg: "HS256", typ: "JWT" });
    const p = b64({ userId: "7", exp: Math.floor(Date.now() / 1000) + 3600 });
    const sig = createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url");
    await assert.rejects(verifyAccess(`${h}.${p}.${sig}`, SECRET), (e: unknown) => e instanceof JwtError);
  });

  test("an API key (oc-cc.*) is rejected by the container token parser and by verifyAccess", async () => {
    const apiKey = `oc-cc.${"a".repeat(8)}.${"b".repeat(48)}`;
    assert.throws(
      () => parseContainerToken(`Bearer ${apiKey}`),
      (e: unknown) => e instanceof ContainerIdentityError && e.code === "BAD_TOKEN_FORMAT",
    );
    await assert.rejects(verifyAccess(apiKey, SECRET), (e: unknown) => e instanceof JwtError);
  });
});
