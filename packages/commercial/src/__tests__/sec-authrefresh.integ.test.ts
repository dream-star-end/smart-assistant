import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPool, closePool, setPoolOverride, resetPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { register } from "../auth/register.js";
import { login, refresh, RefreshError, warmupLoginDummyHash } from "../auth/login.js";
import { verifyAccess, refreshTokenHash, REFRESH_TOKEN_TTL_SECONDS } from "../auth/jwt.js";
import type { Mailer, MailMessage } from "../auth/mail.js";
import { resetTestSchemaForTest } from "./helpers/db.js";
import { prepareAuthRowResetForTest } from "./helpers/authRows.js";

/**
 * sec-authrefresh (PR #1288) independent review cases. Claude reviewer, 2026-10-30.
 *
 * R-xx  = regression invariants that MUST hold on the PR head (a failure is a bug).
 * CE-xx = the review counterexamples, retargeted at the fixed contract. A PASS means
 *         the weak behaviour does not reproduce: a different real client IP is theft,
 *         a reissued successor cannot be alternated, two tabs do not revoke the new
 *         ticket, and a reissue is stored as revoked_reason 'reissued'.
 *
 * All credentials are fake fixtures. remoteIp "127.0.0.1" is what handleRefresh passes
 * for every proxied client (ctx.authBoundIp = req.socket.remoteAddress, router.ts:2260,
 * handlers.ts:967); the selfhost master binds 127.0.0.1 behind cloudflared.
 */

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";
const JWT_SECRET = "z".repeat(64);
const PASSWORD = "sec review fake password";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36";
const PROXY_IP = "127.0.0.1";
const fp = { jwtSecret: JWT_SECRET, remoteIp: PROXY_IP, userAgent: UA };

let pgAvailable = false;
let resetAuthRows: (() => Promise<void>) | undefined;

class NullMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  async send(msg: MailMessage): Promise<void> { this.sent.push(msg); }
}

before(async () => {
  const p = createPool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 });
  try { await p.query("SELECT 1"); pgAvailable = true; } catch { pgAvailable = false; }
  try { await p.end(); } catch { /* ignore */ }
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error("Postgres test fixture required");
    return;
  }
  await resetPool();
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 6 }));
  await resetTestSchemaForTest();
  await runMigrations();
  resetAuthRows = await prepareAuthRowResetForTest();
  await warmupLoginDummyHash();
});

after(async () => {
  if (pgAvailable) {
    try { await resetTestSchemaForTest(); } catch { /* ignore */ }
    await closePool();
  }
});

beforeEach(async () => {
  if (!pgAvailable) return;
  process.env.REFRESH_ROTATION_GRACE_SECONDS = ""; // empty = default 45s
  await resetAuthRows!();
});

function skip(t: { skip: (r: string) => void }): boolean {
  if (!pgAvailable) { t.skip("pg not running"); return true; }
  return false;
}

const isInvalid = (e: unknown) => e instanceof RefreshError && e.code === "INVALID_REFRESH";

/** Login → one rotation. Returns X (rotated, aged past grace) and Y (its live, unused successor). */
async function staleChain(label: string, opts: { remember?: boolean; clientIp?: string } = {}) {
  const email = `sec-${label}@example.com`;
  const bound = opts.clientIp === undefined ? fp : { ...fp, clientIp: opts.clientIp };
  await register({ email, password: PASSWORD, turnstile_token: "tok" }, { mailer: new NullMailer(), turnstileBypass: true });
  const x = await login(
    { email, password: PASSWORD, turnstile_token: "tok", ...(opts.remember === undefined ? {} : { remember: opts.remember }) },
    { ...bound, turnstileBypass: true },
  );
  const y = await refresh(x.refresh_token, bound);
  await age(x.refresh_token, "50 seconds");
  return { userId: x.user.id, x: x.refresh_token, y };
}

async function age(raw: string, interval: string) {
  await query("UPDATE refresh_tokens SET revoked_at = NOW() - $2::interval WHERE token_hash = $1", [refreshTokenHash(raw), interval]);
}

async function family(raw: string) {
  const r = await query<{ live: string; theft: string; total: string; reasons: string }>(
    `SELECT COUNT(*) FILTER (WHERE revoked_at IS NULL)::text AS live,
            COUNT(*) FILTER (WHERE revoked_reason = 'theft')::text AS theft,
            COUNT(*)::text AS total,
            COALESCE(string_agg(DISTINCT COALESCE(revoked_reason, 'live'), ',' ORDER BY COALESCE(revoked_reason, 'live')), '') AS reasons
       FROM refresh_tokens
      WHERE family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1)`,
    [refreshTokenHash(raw)],
  );
  const row = r.rows[0];
  return { live: Number(row.live), theft: Number(row.theft), total: Number(row.total), reasons: row.reasons };
}

describe("sec-authrefresh R: regression invariants (must pass)", () => {
  test("R-01 used direct successor → theft, whole family revoked, onTheftDetected fires", async (t) => {
    if (skip(t)) return;
    const { x, y } = await staleChain("r01");
    await refresh(y.refresh_token, fp); // Y used → Z
    let fired = 0;
    await assert.rejects(refresh(x, { ...fp, onTheftDetected: () => { fired++; } }), isInvalid);
    assert.equal(fired, 1);
    assert.equal((await family(x)).live, 0);
  });

  for (const [name, over] of [
    ["UA mismatch", { userAgent: "curl/8.0" }],
    ["IP mismatch", { remoteIp: "10.9.9.9" }],
    ["empty UA", { userAgent: "" }],
    ["missing IP", { remoteIp: undefined }],
  ] as const) {
    test(`R-02 ${name} with unused successor → theft, family revoked`, async (t) => {
      if (skip(t)) return;
      const { x, y } = await staleChain(`r02-${name.replace(/\W+/g, "-").toLowerCase()}`);
      let fired = 0;
      await assert.rejects(refresh(x, { ...fp, ...over, onTheftDetected: () => { fired++; } }), isInvalid);
      assert.equal(fired, 1);
      assert.equal((await family(x)).live, 0);
      await assert.rejects(refresh(y.refresh_token, fp), isInvalid);
    });
  }

  test("R-03 within grace (<45s) a stale presentation is still REFRESH_RACE, no issuance", async (t) => {
    if (skip(t)) return;
    const { x } = await staleChain("r03");
    await age(x, "10 seconds");
    await assert.rejects(refresh(x, fp), (e: unknown) => e instanceof RefreshError && e.code === "REFRESH_RACE");
    const f = await family(x);
    assert.equal(f.live, 1);
    assert.equal(f.total, 2);
  });

  test("R-04 reissue: exactly one live row; the old ticket dies (second use → theft)", async (t) => {
    if (skip(t)) return;
    const { userId, x, y } = await staleChain("r04");
    let noted = 0;
    let notedUser = "";
    let notedFamily = "";
    const z = await refresh(x, {
      ...fp,
      onReissued: (ev) => { noted += 1; notedUser = ev.user_id; notedFamily = ev.family_id; },
    });
    assert.equal(noted, 1, "reissue is distinguishable from a normal rotation");
    assert.equal(notedUser, String(userId));
    assert.ok(notedFamily.length > 0);
    const claims = await verifyAccess(z.access_token, JWT_SECRET);
    assert.equal(String(claims.sub), String(userId));
    assert.notEqual(z.refresh_token, y.refresh_token);
    let f = await family(x);
    assert.equal(f.live, 1, "after reissue only the reissued row is live");
    assert.equal(f.theft, 0);
    const yRow = await query<{ revoked_reason: string | null }>(
      "SELECT revoked_reason FROM refresh_tokens WHERE token_hash = $1", [refreshTokenHash(y.refresh_token)]);
    assert.equal(yRow.rows[0].revoked_reason, "reissued");
    // The other tab, still inside the successor's 45s window, must not kill the new ticket.
    await assert.rejects(refresh(x, fp), (e: unknown) => e instanceof RefreshError && e.code === "REFRESH_RACE");
    f = await family(x);
    assert.equal(f.live, 1);
    assert.equal(f.theft, 0);
    const kept = await refresh(z.refresh_token, fp);
    assert.ok(kept.access_token.length > 0);
    // Past that window the same old ticket is theft and the family dies.
    await age(y.refresh_token, "50 seconds");
    await assert.rejects(refresh(x, fp), isInvalid);
    f = await family(x);
    assert.equal(f.live, 0);
    assert.ok(f.theft >= 1);
  });

  test("R-05 reissued ticket keeps rotating normally afterwards", async (t) => {
    if (skip(t)) return;
    const { x } = await staleChain("r05");
    const z = await refresh(x, fp);
    const z2 = await refresh(z.refresh_token, fp);
    assert.ok(z2.access_token.length > 0);
    assert.equal((await family(x)).live, 1);
  });

  for (const remember of [false, true]) {
    test(`R-06 reissue inherits remember_me=${remember}`, async (t) => {
      if (skip(t)) return;
      const { x } = await staleChain(`r06-${remember}`, { remember });
      const z = await refresh(x, fp);
      assert.equal(z.remember, remember);
      const r = await query<{ remember_me: boolean }>("SELECT remember_me FROM refresh_tokens WHERE token_hash = $1", [refreshTokenHash(z.refresh_token)]);
      assert.equal(r.rows[0].remember_me, remember);
    });
  }

  test("R-07 reissue expiry equals ordinary rotation (now + TTL), never longer", async (t) => {
    if (skip(t)) return;
    const { x, y } = await staleChain("r07");
    const now = Math.floor(Date.now() / 1000) + 3600;
    const z = await refresh(x, { ...fp, now: () => now });
    assert.equal(z.refresh_exp, now + REFRESH_TOKEN_TTL_SECONDS);
    // Same clock, ordinary rotation of the reissued ticket gives the same horizon.
    const z2 = await refresh(z.refresh_token, { ...fp, now: () => now });
    assert.equal(z2.refresh_exp, z.refresh_exp);
    assert.ok(y.refresh_exp <= z.refresh_exp);
  });

  test("R-08 expired successor → no reissue (theft path)", async (t) => {
    if (skip(t)) return;
    const { x, y } = await staleChain("r08");
    await query("UPDATE refresh_tokens SET expires_at = NOW() - INTERVAL '1 second' WHERE token_hash = $1", [refreshTokenHash(y.refresh_token)]);
    await assert.rejects(refresh(x, fp), isInvalid);
    assert.equal((await family(x)).live, 0);
  });

  test("R-09 successor explicitly revoked (logout/admin) → no reissue", async (t) => {
    if (skip(t)) return;
    const { x, y } = await staleChain("r09");
    await query("UPDATE refresh_tokens SET revoked_at = NOW(), revoked_reason = 'logout' WHERE token_hash = $1", [refreshTokenHash(y.refresh_token)]);
    await assert.rejects(refresh(x, fp), isInvalid);
    assert.equal((await family(x)).live, 0);
  });

  test("R-10 stale X and live Y presented concurrently never leave two live rows", async (t) => {
    if (skip(t)) return;
    for (let i = 0; i < 5; i++) {
      const { x, y } = await staleChain(`r10-${i}`);
      await Promise.allSettled([refresh(x, fp), refresh(y.refresh_token, fp)]);
      assert.ok((await family(x)).live <= 1, `iteration ${i}: two live tickets in one family`);
    }
  });

  test("R-11 old ticket itself expired → plain INVALID, no reissue", async (t) => {
    if (skip(t)) return;
    const { x } = await staleChain("r11");
    await query("UPDATE refresh_tokens SET expires_at = NOW() - INTERVAL '1 second' WHERE token_hash = $1", [refreshTokenHash(x)]);
    await assert.rejects(refresh(x, fp), isInvalid);
    assert.equal((await family(x)).live, 1, "expired-parent path is plain invalid, successor untouched");
  });
});

describe("sec-authrefresh CE: fixed contract (PASS = the hole is closed)", () => {
  test("CE-01 a different real client IP cannot reissue through the loopback socket", async (t) => {
    if (skip(t)) return;
    const { x, y } = await staleChain("ce01", { clientIp: "203.0.113.10" });
    await age(x, "6 hours");
    let theft = 0;
    await assert.rejects(
      refresh(x, { ...fp, clientIp: "198.51.100.66", onTheftDetected: () => { theft += 1; } }),
      isInvalid,
    );
    assert.equal(theft, 1);
    assert.equal((await family(x)).live, 0, "the unused successor dies with the family");
    await assert.rejects(refresh(y.refresh_token, { ...fp, clientIp: "203.0.113.10" }), isInvalid);

    // Same public IP, socket still loopback: the lost cookie is reissued.
    const ok = await staleChain("ce01b", { clientIp: "203.0.113.10" });
    await age(ok.x, "6 hours");
    let noted = 0;
    const again = await refresh(ok.x, { ...fp, clientIp: "203.0.113.10", onReissued: () => { noted += 1; }, onTheftDetected: () => { theft += 1; } });
    assert.equal(noted, 1);
    assert.equal(theft, 1, "the earlier theft must not be joined by this reissue");
    assert.ok(again.access_token.length > 0);
    const reason = await query<{ revoked_reason: string | null }>(
      "SELECT revoked_reason FROM refresh_tokens WHERE token_hash = $1",
      [refreshTokenHash(ok.y.refresh_token)],
    );
    assert.equal(reason.rows[0].revoked_reason, "reissued");
    const stored = await query<{ client_ip: string | null; ip: string | null }>(
      "SELECT host(client_ip) AS client_ip, host(ip) AS ip FROM refresh_tokens WHERE token_hash = $1",
      [refreshTokenHash(again.refresh_token)],
    );
    assert.equal(stored.rows[0].client_ip, "203.0.113.10");
    assert.equal(stored.rows[0].ip, "127.0.0.1");
  });

  test("CE-02 a reissued successor cannot be alternated with the attacker", async (t) => {
    if (skip(t)) return;
    const { x, y } = await staleChain("ce02");
    let theft = 0;
    const deps = { ...fp, onTheftDetected: () => { theft += 1; } };
    const attacker = await refresh(x, deps);
    assert.equal(theft, 0);
    await assert.rejects(
      refresh(y.refresh_token, deps),
      (e: unknown) => e instanceof RefreshError && e.code === "REFRESH_RACE",
    );
    assert.equal(theft, 0, "inside the grace window the victim's return is a race, not a second reissue");
    assert.equal((await family(x)).live, 1);
    await age(y.refresh_token, "16 minutes");
    await assert.rejects(refresh(y.refresh_token, deps), isInvalid);
    assert.equal(theft, 1);
    const f = await family(x);
    assert.ok(f.theft >= 1);
    assert.equal(f.live, 0);
    await assert.rejects(refresh(attacker.refresh_token, fp), isInvalid);
  });

  test("CE-03 two tabs presenting the same lost cookie: one reissue, one REFRESH_RACE, the new ticket stays live", async (t) => {
    if (skip(t)) return;
    for (let i = 0; i < 5; i++) {
      const { x } = await staleChain(`ce03-${i}`);
      await age(x, "6 hours");
      const out = await Promise.allSettled([refresh(x, fp), refresh(x, fp)]);
      const fulfilled = out.filter((o) => o.status === "fulfilled");
      const rejected = out.filter((o) => o.status === "rejected");
      assert.equal(fulfilled.length, 1, `iteration ${i} fulfilled`);
      assert.equal(rejected.length, 1, `iteration ${i} rejected`);
      const err = (rejected[0] as PromiseRejectedResult).reason;
      const f = await family(x);
      const got = err instanceof RefreshError
        ? `${err.code} ${err.message}`
        : (err instanceof Error ? `${err.name}: ${err.message}` : String(err));
      assert.equal(
        got,
        "REFRESH_RACE refresh token rotation race",
        `iteration ${i} family live=${f.live} theft=${f.theft} reasons=${f.reasons}`,
      );
      assert.equal(f.live, 1, `iteration ${i} live`);
      assert.equal(f.theft, 0, `iteration ${i} theft`);
      const ok = fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof refresh>>>;
      const next = await refresh(ok.value.refresh_token, fp);
      assert.ok(next.access_token.length > 0);
    }
  });

  test("CE-04 a reissue is stored as reissued, distinct from a normal rotation", async (t) => {
    if (skip(t)) return;
    const a = await staleChain("ce04a");
    await refresh(a.x, fp);
    const b = await staleChain("ce04b");
    await refresh(b.y.refresh_token, fp);
    const fa = await family(a.x);
    const fb = await family(b.x);
    assert.notEqual(fa.reasons, fb.reasons);
    assert.equal(fa.reasons, "live,reissued,rotated");
    assert.equal(fb.reasons, "live,rotated");
  });
});
