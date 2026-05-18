/**
 * `handleMediaSign` 鉴权策略契约测试 —— v1.0.159 cookie-first + Bearer 兜底 + dual verify。
 *
 * 这层只测**入口鉴权 8 条 contract**,不打 DB / docker / 真签名(deps.mediaSignKey
 * 用合法 HKDF 派生,batch 用 `/home/agent/.openclaude/...` 通过 isContainerPathAllowed)。
 *
 * 8 条 contract(对应 plan):
 *   1. cookie-only valid       → 200
 *   2. bearer-only valid       → 200
 *   3. neither                 → 401
 *   4. invalid bearer + invalid cookie → 401, 2 条 media_sign_auth_fail(source=cookie + bearer)
 *   5. **invalid bearer + valid cookie → 200**(v1.0.158 → v1.0.159 老前端迁移关键路径)
 *   6. **invalid cookie + valid bearer → 200**(Step 2 Bearer 兜底语义)
 *   7. cookie === bearer (同一 token) → 200,只 verify 一次(不重复打 fail 日志)
 *   8. valid bearer + valid cookie 不同 sub → 200(cookie 胜)+ 1 条 media_sign_subject_mismatch
 *   9. valid bearer + valid cookie 相同 sub → 200,无 mismatch 日志
 *
 * `_logMediaSignAuthFail` / `_logMediaSignSubjectMismatch` 不导出,通过 spy `ctx.log.warn`
 * 收集事件名(第 1 个参数)区分。requireActiveAccountVerifyDb 用 fake pool 返一个 active
 * user row(role=user) → 让 auth 通过后 200 路径能跑完。
 *
 * 为什么不写 fail-then-recovery 端到端跑通:DB / signing key / mediaSignKey 之外的真链路
 * 已被 `mediaSign.test.ts`(primitive 层)和 `blockedForUser.integ.test.ts`(integ 层)覆盖。
 * 这里只验"鉴权进出口"。
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, test } from "node:test";
import type { Pool } from "pg";

import { signAccess } from "../../auth/jwt.js";
import { handleMediaSign } from "../handlers.js";
import type { CommercialHttpDeps, RequestContext } from "../handlers.js";
import { deriveMediaSignKey } from "../mediaSign.js";

// ─── fixtures ──────────────────────────────────────────────────────────

const TEST_JWT_SECRET =
  "test_jwt_secret_that_is_long_enough_for_hs256_at_least_32_bytes";
const TEST_BRIDGE_SECRET = randomBytes(32).toString("hex"); // 64-char lowercase hex
const TEST_MEDIA_SIGN_KEY = deriveMediaSignKey(TEST_BRIDGE_SECRET);
const ALLOWED_PATH = "/home/agent/.openclaude/uploads/x.png";

// ─── JWT helpers ───────────────────────────────────────────────────────

async function makeJwt(sub: string): Promise<string> {
  const r = await signAccess({ sub, role: "user" }, TEST_JWT_SECRET);
  return r.token;
}

// ─── req/res/ctx fakes ─────────────────────────────────────────────────

interface FakeRes {
  statusCode: number;
  headers: Record<string, string | string[] | number>;
  body: string;
  res: ServerResponse;
}

function makeRes(): FakeRes {
  const out: FakeRes = {
    statusCode: 200,
    headers: {},
    body: "",
    res: null as unknown as ServerResponse,
  };
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string | string[] | number) {
      out.headers[name] = value;
    },
    getHeader(name: string) {
      return out.headers[name];
    },
    end(chunk?: string) {
      if (chunk) out.body = chunk;
      out.statusCode = (this as unknown as { statusCode: number }).statusCode;
    },
  } as unknown as ServerResponse;
  Object.defineProperty(res, "statusCode", {
    get() {
      return out.statusCode;
    },
    set(v: number) {
      out.statusCode = v;
    },
  });
  out.res = res;
  return out;
}

function makeReq(opts: {
  cookieToken?: string | null;
  bearerToken?: string | null;
  paths?: string[];
}): IncomingMessage {
  const body = JSON.stringify({ paths: opts.paths ?? [ALLOWED_PATH] });
  const stream = Readable.from([Buffer.from(body, "utf8")]);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    host: "test.example",
  };
  if (opts.bearerToken) headers.authorization = `Bearer ${opts.bearerToken}`;
  if (opts.cookieToken) headers.cookie = `oc_session=${opts.cookieToken}`;
  Object.assign(stream, {
    method: "POST",
    url: "/api/media-sign",
    headers,
    socket: { remoteAddress: "127.0.0.1" },
  });
  return stream as unknown as IncomingMessage;
}

interface WarnEvent {
  event: string;
  fields: Record<string, unknown>;
}

function makeCtx(): { ctx: RequestContext; warns: WarnEvent[] } {
  const warns: WarnEvent[] = [];
  const log = {
    info: () => {},
    warn: (event: string, fields?: Record<string, unknown>) => {
      warns.push({ event, fields: fields ?? {} });
    },
    error: () => {},
    debug: () => {},
    child() {
      return log;
    },
  } as unknown as RequestContext["log"];
  const ctx: RequestContext = {
    requestId: "test-req",
    clientIp: "127.0.0.1",
    authBoundIp: "127.0.0.1",
    userAgent: "test-ua",
    log,
  };
  return { ctx, warns };
}

// ─── fake pool (requireActiveAccountVerifyDb) ──────────────────────────

interface PoolCall {
  sql: string;
  params: unknown[];
}

/**
 * 模拟 `requireActiveAccountVerifyDb` 的 SQL:`SELECT id, role FROM users WHERE id=$1
 * AND role=ANY($2) AND status='active'`。本测试中只要 sub 在 `activeSubs` 集合就返
 * 一行 role=user。其他 SQL 不该被调到,撞上即抛(防 handler 偷偷查 DB)。
 */
function makePool(activeSubs: Set<string>): { pool: Pool; calls: PoolCall[] } {
  const calls: PoolCall[] = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      if (/FROM users/i.test(sql) && /status = 'active'/i.test(sql)) {
        const sub = String(params?.[0] ?? "");
        if (activeSubs.has(sub)) {
          return { rowCount: 1, rows: [{ id: sub, role: "user" }] };
        }
        return { rowCount: 0, rows: [] };
      }
      throw new Error(`makePool: unexpected SQL: ${sql.slice(0, 200)}`);
    },
  } as unknown as Pool;
  return { pool, calls };
}

function makeDeps(activeSubs: Set<string>): {
  deps: CommercialHttpDeps;
  poolCalls: PoolCall[];
} {
  const { pool, calls } = makePool(activeSubs);
  // v3Supervisor 只需 `pool` 字段供 requireActiveAccountVerifyDb 用,其余字段
  // handleMediaSign 不读 —— cast 到 V3SupervisorDeps 形状即可,不构造完整 docker。
  const v3Supervisor = { pool } as unknown as CommercialHttpDeps["v3Supervisor"];
  const deps: CommercialHttpDeps = {
    jwtSecret: TEST_JWT_SECRET,
    mailer: {} as CommercialHttpDeps["mailer"],
    redis: {} as CommercialHttpDeps["redis"],
    mediaSignKey: TEST_MEDIA_SIGN_KEY,
    v3Supervisor,
  } as CommercialHttpDeps;
  return { deps, poolCalls: calls };
}

// ─── helpers to read response ──────────────────────────────────────────

function parseBody(out: FakeRes): unknown {
  if (!out.body) return null;
  try {
    return JSON.parse(out.body);
  } catch {
    return out.body;
  }
}

// ─── tests ─────────────────────────────────────────────────────────────

describe("handleMediaSign auth (v1.0.159 cookie-first dual-verify)", () => {
  test("contract 1: cookie-only valid → 200", async () => {
    const sub = "42";
    const cookie = await makeJwt(sub);
    const { deps } = makeDeps(new Set([sub]));
    const req = makeReq({ cookieToken: cookie });
    const out = makeRes();
    const { ctx, warns } = makeCtx();
    await handleMediaSign(req, out.res, ctx, deps);
    assert.equal(out.statusCode, 200);
    const body = parseBody(out) as { urls?: Record<string, string>; expMs?: number };
    assert.ok(body.urls);
    assert.ok(body.urls[ALLOWED_PATH]);
    // 无任何 warn(无 fail / 无 mismatch)
    assert.deepEqual(warns, []);
  });

  test("contract 2: bearer-only valid → 200", async () => {
    const sub = "43";
    const bearer = await makeJwt(sub);
    const { deps } = makeDeps(new Set([sub]));
    const req = makeReq({ bearerToken: bearer });
    const out = makeRes();
    const { ctx, warns } = makeCtx();
    await handleMediaSign(req, out.res, ctx, deps);
    assert.equal(out.statusCode, 200);
    const body = parseBody(out) as { urls?: Record<string, string> };
    assert.ok(body.urls?.[ALLOWED_PATH]);
    assert.deepEqual(warns, []);
  });

  test("contract 3: neither cookie nor bearer → 401", async () => {
    const { deps } = makeDeps(new Set());
    const req = makeReq({});
    const out = makeRes();
    const { ctx, warns } = makeCtx();
    await assert.rejects(
      () => handleMediaSign(req, out.res, ctx, deps),
      (err: unknown) => {
        const e = err as { status?: number; code?: string };
        return e.status === 401 && e.code === "UNAUTHORIZED";
      },
    );
    // 没传 token,_logMediaSignAuthFail 不会被调到(逻辑里有 `if (cookieToken)` /
    // `if (bearerToken)` 守门),warn 应当空
    assert.deepEqual(warns, []);
  });

  test("contract 4: invalid bearer + invalid cookie → 401, 2× fail logs (source=cookie, source=bearer)", async () => {
    const { deps } = makeDeps(new Set());
    const req = makeReq({
      cookieToken: "garbage.cookie.token",
      bearerToken: "garbage.bearer.token",
    });
    const out = makeRes();
    const { ctx, warns } = makeCtx();
    await assert.rejects(
      () => handleMediaSign(req, out.res, ctx, deps),
      (err: unknown) => {
        const e = err as { status?: number; code?: string };
        return e.status === 401 && e.code === "UNAUTHORIZED";
      },
    );
    const fails = warns.filter((w) => w.event === "media_sign_auth_fail");
    assert.equal(fails.length, 2, "fail log 应当 cookie + bearer 各 1 条");
    const sources = fails.map((w) => w.fields.source).sort();
    assert.deepEqual(sources, ["bearer", "cookie"]);
    // 没有 mismatch 日志 —— 两边都 verify 失败,不可能进 mismatch 分支
    assert.equal(
      warns.filter((w) => w.event === "media_sign_subject_mismatch").length,
      0,
    );
  });

  test("contract 5: invalid bearer + valid cookie → 200 (v1.0.158 stale-Bearer 迁移关键路径)", async () => {
    // d1193355375 case 的实际形态:浏览器内 state.token 老化 75 分钟(stale Bearer),
    // 但 cookie 每次 refresh 自动 mint 是 fresh 的。cookie-first → 200,bearer 旁路。
    const sub = "44";
    const cookie = await makeJwt(sub);
    const { deps } = makeDeps(new Set([sub]));
    const req = makeReq({
      cookieToken: cookie,
      bearerToken: "stale.bearer.invalid",
    });
    const out = makeRes();
    const { ctx, warns } = makeCtx();
    await handleMediaSign(req, out.res, ctx, deps);
    assert.equal(out.statusCode, 200);
    // 鉴权阶段 bearer 被跳过(cookie 已胜),无 fail 日志;mismatch 阶段会
    // verify bearer 但失败 → br.ok=false,不打 mismatch。warns 应空。
    assert.deepEqual(warns, []);
  });

  test("contract 6: invalid cookie + valid bearer → 200 (Bearer 兜底语义)", async () => {
    // Step 1: cookie 存在但 verify 失败 → 打 fail 日志 source=cookie,chosenSource 仍 null
    // Step 2: !chosenSource && bearer valid → chosenSource=bearer,claims 装填
    // Step 3: chosenSource !== 'cookie',mismatch 不检查
    // 期望 200,1 条 fail 日志 source=cookie
    const sub = "55";
    const bearer = await makeJwt(sub);
    const { deps } = makeDeps(new Set([sub]));
    const req = makeReq({
      cookieToken: "garbage.cookie.invalid",
      bearerToken: bearer,
    });
    const out = makeRes();
    const { ctx, warns } = makeCtx();
    await handleMediaSign(req, out.res, ctx, deps);
    assert.equal(out.statusCode, 200);
    const fails = warns.filter((w) => w.event === "media_sign_auth_fail");
    assert.equal(fails.length, 1);
    assert.equal(fails[0]!.fields.source, "cookie");
    assert.equal(
      warns.filter((w) => w.event === "media_sign_subject_mismatch").length,
      0,
    );
  });

  test("contract 7: cookie === bearer (同 token) → 200,无 mismatch / 无 fail 日志", async () => {
    // 浏览器同源场景 fetch 既带 cookie 又带 Authorization,且来自同一 access token。
    // step 1 cookie verify 一次,step 2 因 bearer===cookie 跳过,step 3 也因
    // bearer===cookie 跳过(不进 mismatch 分支)。
    const sub = "45";
    const token = await makeJwt(sub);
    const { deps } = makeDeps(new Set([sub]));
    const req = makeReq({ cookieToken: token, bearerToken: token });
    const out = makeRes();
    const { ctx, warns } = makeCtx();
    await handleMediaSign(req, out.res, ctx, deps);
    assert.equal(out.statusCode, 200);
    assert.deepEqual(warns, []);
  });

  test("contract 8: valid bearer + valid cookie 不同 sub → 200 + mismatch warn(cookie 胜)", async () => {
    const cookieSub = "100";
    const bearerSub = "200";
    const cookie = await makeJwt(cookieSub);
    const bearer = await makeJwt(bearerSub);
    // 两个 sub 都得在 DB active,否则 200 路径会被后续 requireActiveAccountVerifyDb
    // 卡 403。本测试只关心鉴权策略 → cookie 的 sub 被 active 即可。
    const { deps } = makeDeps(new Set([cookieSub]));
    const req = makeReq({ cookieToken: cookie, bearerToken: bearer });
    const out = makeRes();
    const { ctx, warns } = makeCtx();
    await handleMediaSign(req, out.res, ctx, deps);
    assert.equal(out.statusCode, 200);
    const mismatches = warns.filter((w) => w.event === "media_sign_subject_mismatch");
    assert.equal(mismatches.length, 1, "应当打一条 mismatch warn");
    assert.equal(mismatches[0]!.fields.chosen, "cookie");
    assert.equal(mismatches[0]!.fields.cookie_sub, cookieSub);
    assert.equal(mismatches[0]!.fields.bearer_sub, bearerSub);
    // 鉴权阶段无 fail 日志(cookie 胜,bearer 被跳过)
    assert.equal(warns.filter((w) => w.event === "media_sign_auth_fail").length, 0);
  });

  test("contract 9: valid bearer + valid cookie 相同 sub(不同 token 字面) → 200,无 mismatch", async () => {
    const sub = "77";
    // signAccess 每次新 jti + iat,生成两个不同的 token 字符串但 sub 相同
    const cookie = await makeJwt(sub);
    const bearer = await makeJwt(sub);
    assert.notEqual(cookie, bearer, "两 token 字面应不同,测试才有意义");
    const { deps } = makeDeps(new Set([sub]));
    const req = makeReq({ cookieToken: cookie, bearerToken: bearer });
    const out = makeRes();
    const { ctx, warns } = makeCtx();
    await handleMediaSign(req, out.res, ctx, deps);
    assert.equal(out.statusCode, 200);
    // 同 sub,mismatch 分支条件 `br.claims.sub !== claims.sub` 不成立,无 warn
    assert.deepEqual(warns, []);
  });
});
