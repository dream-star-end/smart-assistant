/**
 * 企业版(P3.1)批次 C 行为测试 —— 真 DB round-trip(org 维度共享技能)。
 *
 * 隔离策略:专属数据库 openclaude_orgc_test(before CREATE / after DROP),仿批次 A
 * orgEnterprise.test.ts,避免与共享库上的 `DROP SCHEMA public` 型测试并发打架。
 *
 * 覆盖:
 *   - listing org 可见性(browse/search 枚举 + detail):非成员不可见 / 成员可见 / 他 org 私有不可见
 *   - 发布 visibility=org 落 listing.org_id
 *   - org install / uninstall 生命周期(数据层 + HTTP 权限矩阵)
 *   - install 校验(未 approved 拒 / 他 org 私有拒 / 不存在拒)
 *   - sync 结果 UNION(纯个人 / 纯 org / 同 slug 个人优先 / 离开 org 后收敛 / org 停用后收敛)
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { Client } from "pg";
import { marketplaceArtifactHash } from "@openclaude/storage";
import { createPool, closePool, getPool, setPoolOverride, resetPool } from "../db/index.js";
import { query, tx } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { signAccess } from "../auth/jwt.js";
import { createOrg } from "../org/orgs.js";
import { dispatchOrgRoute } from "../http/org/routes.js";
import type { CommercialHttpDeps, RequestContext } from "../http/handlers.js";
import {
  publishSkillVersion,
  reviewVersion,
  getListingDetail,
  listApprovedForSearch,
  installApprovedVersion,
  listActiveInstalledArtifacts,
  resolveCallerOrgId,
  MarketplaceError,
} from "../marketplace/marketplaceDb.js";
import {
  installOrgSkill,
  uninstallOrgSkill,
  listOrgInstalls,
  listOrgInstallCandidates,
} from "../marketplace/orgInstalls.js";

const BASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const MY_DB = "openclaude_orgc_test";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";
const JWT_SECRET = "z".repeat(64);

function withDb(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}
const MY_URL = withDb(BASE_URL, MY_DB);

let pgAvailable = false;

async function adminExec(sql: string): Promise<void> {
  const c = new Client({ connectionString: BASE_URL, connectionTimeoutMillis: 1500 });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

before(async () => {
  try {
    await adminExec("SELECT 1");
    pgAvailable = true;
  } catch {
    pgAvailable = false;
  }
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error("Postgres test fixture required");
    return;
  }
  await adminExec(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${MY_DB}' AND pid <> pg_backend_pid()`,
  ).catch(() => {});
  await adminExec(`DROP DATABASE IF EXISTS ${MY_DB}`);
  await adminExec(`CREATE DATABASE ${MY_DB} TEMPLATE template0`);

  await resetPool();
  setPoolOverride(createPool({ connectionString: MY_URL, max: 10, statementTimeoutMs: 120_000 }));
  await runMigrations();
});

after(async () => {
  if (!pgAvailable) return;
  await closePool();
  await adminExec(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${MY_DB}' AND pid <> pg_backend_pid()`,
  ).catch(() => {});
  await adminExec(`DROP DATABASE IF EXISTS ${MY_DB}`).catch(() => {});
});

beforeEach(async () => {
  if (!pgAvailable) return;
  await query(
    `TRUNCATE TABLE marketplace_skill_listings, marketplace_skill_versions,
       marketplace_installs, org_installs, orgs, org_memberships, org_invitations,
       users, admin_audit
     RESTART IDENTITY CASCADE`,
  );
});

function skipIfNoPg(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) {
    t.skip("pg not running");
    return true;
  }
  return false;
}

// ─── fixtures ───────────────────────────────────────────────────────

async function createUser(email: string): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO users(email, password_hash, role, status, email_verified, free_bootstrap_settled)
     VALUES ($1, 'argon2$stub', 'user', 'active', TRUE, TRUE) RETURNING id::text AS id`,
    [email],
  );
  return r.rows[0].id;
}

async function makeOrg(ownerId: string, name = "Acme"): Promise<string> {
  return tx(async (client) => {
    const o = await createOrg({ name, ownerUserId: ownerId, createdBy: null, maxMembers: 100 }, client);
    return o.id;
  });
}

async function addMember(
  orgId: string,
  userId: string,
  role: "owner" | "admin" | "member" = "member",
  status: "active" | "suspended" = "active",
): Promise<void> {
  await query(
    `INSERT INTO org_memberships(org_id, user_id, org_role, status, billing_enabled)
     VALUES ($1::bigint, $2::bigint, $3, $4, TRUE)`,
    [orgId, userId, role, status],
  );
}

/** 发布并批准一个 skill listing。返回 versionId。orgId 非空 = org-private(可见范围)。 */
async function publishApproved(opts: {
  slug: string;
  ownerId: string;
  orgId?: string | null;
  version?: string;
  approve?: boolean;
}): Promise<string> {
  const version = opts.version ?? "1.0.0";
  const rawSkillMd = `---\nname: ${opts.slug}\ndescription: "d"\nversion: ${version}\n---\nbody ${version}\n`;
  const { versionId } = await publishSkillVersion({
    slug: opts.slug,
    ownerUserId: Number(opts.ownerId),
    version,
    name: opts.slug,
    description: `desc ${opts.slug}`,
    tags: [],
    rawSkillMd,
    artifactHash: marketplaceArtifactHash(rawSkillMd),
    embeddingHash: `eh-${opts.slug}-${version}`,
    riskFlags: [],
    policyVersion: 1,
    submittedBy: Number(opts.ownerId),
    orgId: opts.orgId ?? null,
    queueAiReview: false,
  });
  if (opts.approve !== false) {
    await reviewVersion({
      versionId,
      reviewerUserId: Number(opts.ownerId),
      approve: true,
      allowSelfReview: true,
    });
  }
  return versionId;
}

async function token(uid: string): Promise<string> {
  const r = await signAccess({ sub: uid, role: "user" }, JWT_SECRET);
  return r.token;
}

async function listingOrgId(slug: string): Promise<string | null> {
  const r = await query<{ org_id: string | null }>(
    `SELECT org_id::text AS org_id FROM marketplace_skill_listings WHERE slug = $1`,
    [slug],
  );
  return r.rows[0]?.org_id ?? null;
}

// ─── HTTP 驱动(仿 orgEnterprise.test.ts)────────────────────────────

function makeReq(method: string, path: string, tok?: string, body?: unknown): Readable {
  const bodyStr = body === undefined ? "" : JSON.stringify(body);
  const req = Readable.from(bodyStr.length > 0 ? [Buffer.from(bodyStr)] : []) as Readable & {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
    socket?: { remoteAddress: string };
  };
  req.method = method;
  req.url = path;
  req.headers = { host: "x.invalid", ...(tok ? { authorization: `Bearer ${tok}` } : {}) };
  req.socket = { remoteAddress: "127.0.0.1" };
  return req;
}

interface FakeRes {
  statusCode: number;
  _body: string;
  headers: Record<string, unknown>;
  setHeader(k: string, v: unknown): void;
  getHeader(k: string): unknown;
  end(b?: string): void;
  headersSent: boolean;
}

function makeRes(): FakeRes {
  const headers: Record<string, unknown> = {};
  return {
    statusCode: 200,
    _body: "",
    headers,
    setHeader(k, v) {
      headers[k.toLowerCase()] = v;
    },
    getHeader(k) {
      return headers[k.toLowerCase()];
    },
    end(b) {
      this._body = b ?? "";
    },
    headersSent: false,
  };
}

const noopDeps = {
  jwtSecret: JWT_SECRET,
  mailer: { send: async () => {} },
  verifyEmailUrlBase: "https://test.local",
} as unknown as CommercialHttpDeps;

const fakeCtx = {
  requestId: "t",
  clientIp: "127.0.0.1",
  authBoundIp: "127.0.0.1",
  userAgent: "UA",
  log: { child: () => ({}), info() {}, warn() {}, error() {} },
} as unknown as RequestContext;

async function callOrg(
  method: string,
  path: string,
  tok: string | undefined,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const req = makeReq(method, path, tok, body) as never;
  const res = makeRes();
  try {
    await dispatchOrgRoute(req, res as never, fakeCtx, noopDeps);
  } catch (err) {
    const e = err as { status?: number; code?: string; message?: string };
    if (typeof e.status === "number") {
      res.statusCode = e.status;
      res._body = JSON.stringify({ error: { code: e.code, message: e.message } });
    } else {
      throw err;
    }
  }
  let json: unknown;
  try {
    json = res._body ? JSON.parse(res._body) : undefined;
  } catch {
    json = res._body;
  }
  return { status: res.statusCode, json };
}

function isMarketplaceError(code: string) {
  return (err: unknown): boolean => err instanceof MarketplaceError && err.code === code;
}

// ====================================================================
// listing org 可见性(browse / search 枚举）
// ====================================================================

describe("listing org 可见性 — 枚举(listApprovedForSearch)", () => {
  test("非成员只见公开;成员见公开+本 org 私有,不见他 org 私有", async (t) => {
    if (skipIfNoPg(t)) return;
    const oA = await createUser("oa@x.com");
    const orgA = await makeOrg(oA, "A");
    const oB = await createUser("ob@x.com");
    const orgB = await makeOrg(oB, "B");
    const loner = await createUser("loner@x.com");
    const memberA = await createUser("ma@x.com");
    await addMember(orgA, memberA, "member");

    await publishApproved({ slug: "pub-skill", ownerId: oA, orgId: null });
    await publishApproved({ slug: "orga-skill", ownerId: oA, orgId: orgA });
    await publishApproved({ slug: "orgb-skill", ownerId: oB, orgId: orgB });

    // 非成员(callerOrgId=null)
    const lonerOrg = await resolveCallerOrgId(loner);
    assert.equal(lonerOrg, null);
    const lonerSlugs = (await listApprovedForSearch("skill", lonerOrg)).map((r) => r.slug).sort();
    assert.deepEqual(lonerSlugs, ["pub-skill"]);

    // orgA 成员
    const maOrg = await resolveCallerOrgId(memberA);
    assert.equal(maOrg, orgA);
    const maSlugs = (await listApprovedForSearch("skill", maOrg)).map((r) => r.slug).sort();
    assert.deepEqual(maSlugs, ["orga-skill", "pub-skill"]);
    assert.ok(!maSlugs.includes("orgb-skill"), "orgA 成员不应看到 orgB 私有技能");
  });
});

describe("listing org 可见性 — detail(getListingDetail)", () => {
  test("org-private detail:非成员 → null(路由 404);成员 → 命中;他 org → null", async (t) => {
    if (skipIfNoPg(t)) return;
    const oA = await createUser("oa@x.com");
    const orgA = await makeOrg(oA, "A");
    const oB = await createUser("ob@x.com");
    const orgB = await makeOrg(oB, "B");
    const memberA = await createUser("ma@x.com");
    await addMember(orgA, memberA, "member");
    await publishApproved({ slug: "orga-skill", ownerId: oA, orgId: orgA });

    assert.equal(await getListingDetail("orga-skill", null), null, "非成员 detail 应为 null→404");
    const asMember = await getListingDetail("orga-skill", orgA);
    assert.equal(asMember?.slug, "orga-skill");
    assert.equal(await getListingDetail("orga-skill", orgB), null, "他 org 成员 detail 应为 null→404");
  });

  test("公开 listing:任何 caller 均可见", async (t) => {
    if (skipIfNoPg(t)) return;
    const oA = await createUser("oa@x.com");
    await publishApproved({ slug: "pub-skill", ownerId: oA, orgId: null });
    assert.equal((await getListingDetail("pub-skill", null))?.slug, "pub-skill");
  });
});

// ====================================================================
// 发布 visibility=org 落 org_id
// ====================================================================

describe("发布可见范围落库", () => {
  test("orgId 非空 → listing.org_id = 该 org;缺省 → NULL(公开)", async (t) => {
    if (skipIfNoPg(t)) return;
    const oA = await createUser("oa@x.com");
    const orgA = await makeOrg(oA, "A");
    await publishApproved({ slug: "orga-skill", ownerId: oA, orgId: orgA });
    await publishApproved({ slug: "pub-skill", ownerId: oA, orgId: null });
    assert.equal(await listingOrgId("orga-skill"), orgA);
    assert.equal(await listingOrgId("pub-skill"), null);
  });

  test("已存在 listing 再发新版本不改可见性(org_id listing 级不可变)", async (t) => {
    if (skipIfNoPg(t)) return;
    const oA = await createUser("oa@x.com");
    const orgA = await makeOrg(oA, "A");
    await publishApproved({ slug: "s", ownerId: oA, orgId: orgA, version: "1.0.0" });
    // 再发一版,故意传 orgId=null(视图上想改公开),ON CONFLICT DO NOTHING 保留原 org_id
    await publishApproved({ slug: "s", ownerId: oA, orgId: null, version: "2.0.0" });
    assert.equal(await listingOrgId("s"), orgA);
  });
});

// ====================================================================
// org install / uninstall 生命周期
// ====================================================================

describe("org install/uninstall(数据层)", () => {
  test("装公开技能 → 活跃安装出现;卸载 → 消失;可重装", async (t) => {
    if (skipIfNoPg(t)) return;
    const oA = await createUser("oa@x.com");
    const orgA = await makeOrg(oA, "A");
    await publishApproved({ slug: "pub-skill", ownerId: oA, orgId: null });

    await installOrgSkill({ orgId: orgA, slug: "pub-skill", installedBy: oA });
    let installed = await listOrgInstalls(orgA);
    assert.deepEqual(installed.map((r) => r.slug), ["pub-skill"]);
    assert.equal(installed[0].version, "1.0.0");
    assert.deepEqual(installed[0].agentIds, ["main"]);

    assert.equal(await uninstallOrgSkill(orgA, "pub-skill"), true);
    assert.equal((await listOrgInstalls(orgA)).length, 0);
    assert.equal(await uninstallOrgSkill(orgA, "pub-skill"), false, "重复卸载 → false");

    // 重装合法
    await installOrgSkill({ orgId: orgA, slug: "pub-skill", installedBy: oA });
    assert.equal((await listOrgInstalls(orgA)).length, 1);
  });

  test("装本 org 私有技能 → 成功", async (t) => {
    if (skipIfNoPg(t)) return;
    const oA = await createUser("oa@x.com");
    const orgA = await makeOrg(oA, "A");
    await publishApproved({ slug: "orga-skill", ownerId: oA, orgId: orgA });
    const r = await installOrgSkill({ orgId: orgA, slug: "orga-skill", installedBy: oA });
    assert.equal(r.slug, "orga-skill");
    assert.deepEqual((await listOrgInstalls(orgA)).map((x) => x.slug), ["orga-skill"]);
  });

  test("候选目录:含公开+本 org 私有且未装;装后候选移除", async (t) => {
    if (skipIfNoPg(t)) return;
    const oA = await createUser("oa@x.com");
    const orgA = await makeOrg(oA, "A");
    const oB = await createUser("ob@x.com");
    const orgB = await makeOrg(oB, "B");
    await publishApproved({ slug: "pub-skill", ownerId: oA, orgId: null });
    await publishApproved({ slug: "orga-skill", ownerId: oA, orgId: orgA });
    await publishApproved({ slug: "orgb-skill", ownerId: oB, orgId: orgB });

    let cands = (await listOrgInstallCandidates(orgA)).map((c) => c.slug).sort();
    assert.deepEqual(cands, ["orga-skill", "pub-skill"]);
    const pubCand = (await listOrgInstallCandidates(orgA)).find((c) => c.slug === "pub-skill");
    assert.equal(pubCand?.visibility, "public");
    const orgCand = (await listOrgInstallCandidates(orgA)).find((c) => c.slug === "orga-skill");
    assert.equal(orgCand?.visibility, "org");

    await installOrgSkill({ orgId: orgA, slug: "pub-skill", installedBy: oA });
    cands = (await listOrgInstallCandidates(orgA)).map((c) => c.slug).sort();
    assert.deepEqual(cands, ["orga-skill"], "已装的从候选移除");
  });
});

describe("org install 校验", () => {
  test("他 org 私有 → NOT_INSTALLABLE", async (t) => {
    if (skipIfNoPg(t)) return;
    const oA = await createUser("oa@x.com");
    const orgA = await makeOrg(oA, "A");
    const oB = await createUser("ob@x.com");
    const orgB = await makeOrg(oB, "B");
    await publishApproved({ slug: "orgb-skill", ownerId: oB, orgId: orgB });
    await assert.rejects(
      () => installOrgSkill({ orgId: orgA, slug: "orgb-skill", installedBy: oA }),
      isMarketplaceError("NOT_INSTALLABLE"),
    );
  });

  test("未 approved → NOT_INSTALLABLE", async (t) => {
    if (skipIfNoPg(t)) return;
    const oA = await createUser("oa@x.com");
    const orgA = await makeOrg(oA, "A");
    await publishApproved({ slug: "pending-skill", ownerId: oA, orgId: null, approve: false });
    await assert.rejects(
      () => installOrgSkill({ orgId: orgA, slug: "pending-skill", installedBy: oA }),
      isMarketplaceError("NOT_INSTALLABLE"),
    );
  });

  test("不存在 slug → NOT_INSTALLABLE", async (t) => {
    if (skipIfNoPg(t)) return;
    const oA = await createUser("oa@x.com");
    const orgA = await makeOrg(oA, "A");
    await assert.rejects(
      () => installOrgSkill({ orgId: orgA, slug: "ghost-skill", installedBy: oA }),
      isMarketplaceError("NOT_INSTALLABLE"),
    );
  });
});

// ====================================================================
// org skills 路由权限矩阵(HTTP 端到端)
// ====================================================================

describe("/api/org/skills 权限矩阵(HTTP)", () => {
  async function setup() {
    const owner = await createUser("owner@x.com");
    const orgId = await makeOrg(owner, "Acme");
    const admin = await createUser("admin@x.com");
    await addMember(orgId, admin, "admin");
    const member = await createUser("member@x.com");
    await addMember(orgId, member, "member");
    await publishApproved({ slug: "pub-skill", ownerId: owner, orgId: null });
    return { owner, orgId, admin, member };
  }

  test("admin install → 200;member install → 403;GET member → 200", async (t) => {
    if (skipIfNoPg(t)) return;
    const { admin, member } = await setup();

    const asMember = await callOrg("POST", "/api/org/skills/install", await token(member), {
      slug: "pub-skill",
    });
    assert.equal(asMember.status, 403);

    const asAdmin = await callOrg("POST", "/api/org/skills/install", await token(admin), {
      slug: "pub-skill",
    });
    assert.equal(asAdmin.status, 200);
    assert.equal(asAdmin.json.slug, "pub-skill");

    const listed = await callOrg("GET", "/api/org/skills", await token(member));
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.json.installed.map((r: any) => r.slug), ["pub-skill"]);
  });

  test("DELETE by admin → 200;member → 403;未装 slug → 404", async (t) => {
    if (skipIfNoPg(t)) return;
    const { admin, member } = await setup();
    await callOrg("POST", "/api/org/skills/install", await token(admin), { slug: "pub-skill" });

    const memberDel = await callOrg("DELETE", "/api/org/skills/pub-skill", await token(member));
    assert.equal(memberDel.status, 403);

    const adminDel = await callOrg("DELETE", "/api/org/skills/pub-skill", await token(admin));
    assert.equal(adminDel.status, 200);

    const again = await callOrg("DELETE", "/api/org/skills/pub-skill", await token(admin));
    assert.equal(again.status, 404);
  });

  test("非成员(无 org 归属)→ 403", async (t) => {
    if (skipIfNoPg(t)) return;
    await setup();
    const loner = await createUser("loner@x.com");
    const r = await callOrg("GET", "/api/org/skills", await token(loner));
    assert.equal(r.status, 403);
  });
});

// ====================================================================
// sync 结果 UNION(listActiveInstalledArtifacts)
// ====================================================================

describe("sync UNION — 个人 ∪ org(个人优先)", () => {
  test("纯个人:无 org 归属仍下发个人安装", async (t) => {
    if (skipIfNoPg(t)) return;
    const u = await createUser("u@x.com");
    const oOwner = await createUser("o@x.com");
    const vid = await publishApproved({ slug: "pub-skill", ownerId: oOwner, orgId: null });
    await installApprovedVersion({ userId: Number(u), versionId: vid });
    const out = await listActiveInstalledArtifacts(Number(u));
    assert.deepEqual(out.map((x) => x.slug), ["pub-skill"]);
  });

  test("纯 org:成员无个人安装,但 org 已装 → 下发 org 技能", async (t) => {
    if (skipIfNoPg(t)) return;
    const oA = await createUser("oa@x.com");
    const orgA = await makeOrg(oA, "A");
    const member = await createUser("m@x.com");
    await addMember(orgA, member, "member");
    await publishApproved({ slug: "orga-skill", ownerId: oA, orgId: orgA });
    await installOrgSkill({ orgId: orgA, slug: "orga-skill", installedBy: oA });

    const out = await listActiveInstalledArtifacts(Number(member));
    assert.deepEqual(out.map((x) => x.slug), ["orga-skill"]);
  });

  test("同 slug 个人优先:个人 pin v1 覆盖 org pin v2", async (t) => {
    if (skipIfNoPg(t)) return;
    const oA = await createUser("oa@x.com");
    const orgA = await makeOrg(oA, "A");
    const member = await createUser("m@x.com");
    await addMember(orgA, member, "member");

    // v1 上架 → 成员个人装 v1
    const vid1 = await publishApproved({ slug: "shared", ownerId: oA, orgId: null, version: "1.0.0" });
    await installApprovedVersion({ userId: Number(member), versionId: vid1 });
    // v2 上架(current 变 v2)→ org 装 current(v2)
    await publishApproved({ slug: "shared", ownerId: oA, orgId: null, version: "2.0.0" });
    await installOrgSkill({ orgId: orgA, slug: "shared", installedBy: oA });

    const out = await listActiveInstalledArtifacts(Number(member));
    assert.equal(out.length, 1, "同 slug 去重");
    assert.equal(out[0].slug, "shared");
    assert.equal(out[0].version, "1.0.0", "个人 pin 的 v1 优先于 org pin 的 v2");
  });

  test("离开 org 后收敛:org 技能从 sync 结果消失", async (t) => {
    if (skipIfNoPg(t)) return;
    const oA = await createUser("oa@x.com");
    const orgA = await makeOrg(oA, "A");
    const member = await createUser("m@x.com");
    await addMember(orgA, member, "member");
    await publishApproved({ slug: "orga-skill", ownerId: oA, orgId: orgA });
    await installOrgSkill({ orgId: orgA, slug: "orga-skill", installedBy: oA });
    assert.equal((await listActiveInstalledArtifacts(Number(member))).length, 1);

    // 成员离开(删 membership)→ getActiveMembership 为空 → org 分支收敛
    await query(`DELETE FROM org_memberships WHERE org_id=$1::bigint AND user_id=$2::bigint`, [
      orgA,
      member,
    ]);
    assert.equal((await listActiveInstalledArtifacts(Number(member))).length, 0);
  });

  test("org 停用后收敛:org 分支 JOIN orgs active 滤掉", async (t) => {
    if (skipIfNoPg(t)) return;
    const oA = await createUser("oa@x.com");
    const orgA = await makeOrg(oA, "A");
    const member = await createUser("m@x.com");
    await addMember(orgA, member, "member");
    await publishApproved({ slug: "orga-skill", ownerId: oA, orgId: orgA });
    await installOrgSkill({ orgId: orgA, slug: "orga-skill", installedBy: oA });
    assert.equal((await listActiveInstalledArtifacts(Number(member))).length, 1);

    await query(`UPDATE orgs SET status='suspended' WHERE id=$1::bigint`, [orgA]);
    assert.equal(
      (await listActiveInstalledArtifacts(Number(member))).length,
      0,
      "org 停用后不下发 org 技能",
    );
  });
});
