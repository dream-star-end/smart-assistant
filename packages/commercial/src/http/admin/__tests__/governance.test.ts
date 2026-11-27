import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Pool } from "pg";
import { computeApprovalSha256 } from "../../../admin/selfhostGovernanceFormat.js";
import { createSelfhostGovernanceService } from "../../../admin/selfhostGovernanceService.js";
import type {
  GovernanceOverviewResponse,
  PendingGovernanceApproval,
  ProbeUnitStatusResult,
} from "../../../admin/selfhostGovernanceTypes.js";
import { signAccess } from "../../../auth/jwt.js";
import { closePool, setPoolOverride } from "../../../db/index.js";
import type { CommercialHttpDeps } from "../../handlers.js";
import { createCommercialHandler } from "../../router.js";
import type { AdminGovernanceDeps } from "../governance.js";

const execFileAsync = promisify(execFileCb);
const REPO_ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const REAL_GOVERNOR_SH = path.join(REPO_ROOT_DIR, "scripts/harness-gate/oc-governor.sh");
const JWT_SECRET = "g".repeat(64);
const NOW_ISO = "2026-11-27T11:00:00Z";
const VALID_SHA = "b".repeat(40);

interface MockDbRow {
  role: string;
  status: string;
}

const dbUsers = new Map<string, MockDbRow>();

function makeReq(
  method: string,
  url: string,
  options: { token?: string; body?: unknown } = {},
): IncomingMessage {
  const payload =
    options.body === undefined
      ? ""
      : typeof options.body === "string"
        ? options.body
        : JSON.stringify(options.body);
  const stream = Readable.from(payload ? [Buffer.from(payload, "utf8")] : []) as IncomingMessage;
  stream.method = method;
  stream.url = url;
  stream.headers = {
    host: "localhost",
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
  };
  (stream as unknown as { socket: { remoteAddress: string } }).socket = { remoteAddress: "127.0.0.1" };
  return stream;
}

interface CapturedRes {
  res: ServerResponse;
  status: number;
  bodyText: string;
  json<T = Record<string, unknown>>(): T;
}

function makeRes(): CapturedRes {
  const cap: CapturedRes = {
    res: null as unknown as ServerResponse,
    status: 200,
    bodyText: "",
    json<T = Record<string, unknown>>(): T {
      return JSON.parse(cap.bodyText) as T;
    },
  };
  const fake = {
    get statusCode() {
      return cap.status;
    },
    set statusCode(v: number) {
      cap.status = v;
    },
    headersSent: false,
    writableEnded: false,
    setHeader() {
      return fake;
    },
    getHeader() {
      return undefined;
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) {
        cap.bodyText += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      }
      fake.headersSent = true;
      fake.writableEnded = true;
      return fake;
    },
  };
  cap.res = fake as unknown as ServerResponse;
  return cap;
}

function baseDeps(overrides: Partial<AdminGovernanceDeps> = {}): AdminGovernanceDeps {
  return {
    jwtSecret: JWT_SECRET,
    mailer: {} as CommercialHttpDeps["mailer"],
    redis: {} as CommercialHttpDeps["redis"],
    ...overrides,
  };
}

function makeSignedApproval(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    schemaVersion: 1,
    id: "gov-http-0001",
    kind: "blast_voucher",
    status: "pending",
    classification: "human_review_required",
    version: 1,
    code: "BILLING_CORE_LOCKED",
    scope: "billing",
    branch: "feat/v5-selfhost",
    sha: VALID_SHA,
    title: "计费防线拦截",
    plainSummary: "变更涉及计费辅助文件。",
    approveEffect: "批准并签发绑定本次 SHA 的 4 小时凭证。",
    rejectEffect: "驳回并继续阻断。",
    files: ["packages/commercial/src/billing/remoteNativeTurnBilling.ts"],
    safetyLights: [],
    stewardVerdict: { present: true, verdict: "approve", hmacVerified: true },
    createdAt: "2026-11-27T10:30:00Z",
    expiresAt: "2026-11-28T10:30:00Z",
    ...overrides,
  };
  doc.sha256 = computeApprovalSha256(doc);
  return doc;
}

describe("http/admin/governance (real createCommercialHandler router)", () => {
  let tmpRoot: string;
  let govRoot: string;
  let pendingDir: string;
  let tokenUid3: string;
  let tokenUid7: string;
  let tokenRegularUser: string;

  before(async () => {
    await closePool();
    setPoolOverride({
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes("INSERT INTO admin_audit")) {
          return { rows: [{ id: "1" }], rowCount: 1 };
        }
        const uid = String(params?.[0] ?? "");
        const row = dbUsers.get(uid);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      },
      end: async () => {},
    } as unknown as Pool);
    tokenUid3 = (await signAccess({ sub: "3", role: "admin" }, JWT_SECRET)).token;
    tokenUid7 = (await signAccess({ sub: "7", role: "admin" }, JWT_SECRET)).token;
    tokenRegularUser = (await signAccess({ sub: "3", role: "user" }, JWT_SECRET)).token;
  });

  after(async () => {
    await closePool();
  });

  beforeEach(async () => {
    dbUsers.clear();
    dbUsers.set("3", { role: "admin", status: "active" });
    dbUsers.set("7", { role: "admin", status: "active" });
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), "ocv5-gov-http-"));
    govRoot = path.join(tmpRoot, "harness-gate");
    pendingDir = path.join(govRoot, "control", "pending-approvals");
    await mkdir(pendingDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  async function dispatch(
    handler: ReturnType<typeof createCommercialHandler>,
    method: string,
    url: string,
    options: { token?: string; body?: unknown } = {},
  ): Promise<CapturedRes> {
    const req = makeReq(method, url, options);
    const res = makeRes();
    const handled = await handler(req, res.res);
    assert.equal(handled, true, `expected router to handle ${method} ${url}`);
    return res;
  }

  function createServiceWithFakeGovernor(state: {
    lockBusy: boolean;
    headSha: string;
    unitProbe: ProbeUnitStatusResult;
    spawns: Array<Record<string, string>>;
  }) {
    return createSelfhostGovernanceService({
      governorRoot: govRoot,
      governorBin: "/usr/local/bin/oc-governor",
      cockpitDir: path.join(tmpRoot, "cockpit-empty"),
      repoRoot: "/opt/openclaude/openclaude-v5-selfhost",
      deployScriptPath: "/opt/openclaude/openclaude-v5-selfhost/scripts/deploy-v5-selfhost.sh",
      now: () => new Date(NOW_ISO),
      readRepoHeadShaFn: async () => state.headSha,
      checkDeployBusyFn: async () => ({ busy: state.lockBusy }),
      probeUnitStatusFn: async () => state.unitProbe,
      spawnDetachedDeployFn: async (input) => {
        state.spawns.push({ ...input.env, unitName: input.unitName });
        return { started: true, unitName: input.unitName, detail: "resumed" };
      },
      execFileFn: async (_file, args) => {
        const cmd = args[0];
        if (cmd === "mode") {
          const doc = { schemaVersion: 1, mode: args[1], autoMergeFrozen: args[1] !== "autonomous", reason: args[3], updatedAt: NOW_ISO, updatedBy: "root" };
          await writeFile(path.join(govRoot, "control", "mode.json"), JSON.stringify(doc), "utf8");
          return { stdout: JSON.stringify(doc), stderr: "" };
        }
        if (cmd === "unlock-breaker") {
          await writeFile(path.join(govRoot, "control", "breaker.json"), JSON.stringify({ tripped: false }), "utf8");
          return { stdout: JSON.stringify({ ok: true }), stderr: "" };
        }
        if (cmd === "decide-pending-approval") {
          const id = args[args.indexOf("--id") + 1]!;
          const decision = args[args.indexOf("--decision") + 1] as "approve" | "reject";
          const actor = args[args.indexOf("--actor") + 1]!;
          const p = path.join(pendingDir, `${id}.json`);
          const doc = JSON.parse(await readFile(p, "utf8")) as Record<string, unknown>;
          if (doc.status !== "pending") throw new Error("ALREADY_RESOLVED");
          doc.status = decision === "approve" ? "approved" : "rejected";
          doc.version = Number(doc.version ?? 1) + 1;
          doc.decision = {
            action: decision,
            decidedBy: actor,
            decidedAt: NOW_ISO,
            ...(decision === "approve" ? { issuedArtifactId: "bv-abcdef1234567890", resumeStatus: "not_started" } : {}),
          };
          doc.sha256 = computeApprovalSha256(doc);
          await writeFile(p, JSON.stringify(doc), "utf8");
          return { stdout: JSON.stringify(doc), stderr: "" };
        }
        if (cmd === "update-approval-resume") {
          const id = args[args.indexOf("--id") + 1]!;
          const status = args[args.indexOf("--status") + 1]!;
          const claimIdx = args.indexOf("--claim-from");
          const expUnitIdx = args.indexOf("--expected-unit");
          const unitIdx = args.indexOf("--unit");
          const p = path.join(pendingDir, `${id}.json`);
          const doc = JSON.parse(await readFile(p, "utf8")) as Record<string, unknown>;
          const dec = (doc.decision ?? {}) as Record<string, unknown>;
          if (claimIdx >= 0) {
            const allowed = new Set(args[claimIdx + 1]!.split(","));
            if (!allowed.has(String(dec.resumeStatus ?? "not_started"))) throw new Error("RESUME_ALREADY_CLAIMED");
          }
          if (expUnitIdx >= 0 && String(dec.resumeUnit ?? "") !== args[expUnitIdx + 1]) {
            throw new Error("RESUME_UNIT_MISMATCH");
          }
          dec.resumeStatus = status;
          if (unitIdx >= 0) dec.resumeUnit = args[unitIdx + 1];
          else if (["not_started_busy", "head_moved", "not_applicable", "skipped"].includes(status)) dec.resumeUnit = undefined;
          doc.decision = dec;
          doc.version = Number(doc.version ?? 1) + 1;
          doc.sha256 = computeApprovalSha256(doc);
          await writeFile(p, JSON.stringify(doc), "utf8");
          return { stdout: JSON.stringify(doc), stderr: "" };
        }
        throw new Error(`unexpected cmd: ${cmd}`);
      },
    });
  }

  it("enforces all three security gates through real createCommercialHandler router (401/403/404)", async () => {
    const state = { lockBusy: false, headSha: VALID_SHA, unitProbe: { status: "unknown" as const }, spawns: [] as Array<Record<string, string>> };
    const selfhostHandler = createCommercialHandler(baseDeps({ selfhostGovernance: createServiceWithFakeGovernor(state) }));
    const commercialHandler = createCommercialHandler(baseDeps({ selfhostGovernance: undefined }));

    assert.equal((await dispatch(selfhostHandler, "GET", "/api/admin/governance/overview")).status, 401);
    assert.equal((await dispatch(selfhostHandler, "GET", "/api/admin/governance/overview", { token: tokenRegularUser })).status, 403);
    assert.equal((await dispatch(selfhostHandler, "GET", "/api/admin/governance/overview", { token: tokenUid7 })).status, 403);

    const commRes = await dispatch(commercialHandler, "GET", "/api/admin/governance/overview", { token: tokenUid3 });
    assert.equal(commRes.status, 404);
    assert.equal((commRes.json().error as { code: string }).code, "SELFHOST_GOVERNANCE_DISABLED");
  });

  it("handles decide -> not_started_busy -> POST /resume -> unit failed -> safe retry, 409 conflict, 403 commercial branch, and 400 traversal via real router", async () => {
    const state = {
      lockBusy: true,
      headSha: VALID_SHA,
      unitProbe: { status: "unknown" as const } as ProbeUnitStatusResult,
      spawns: [] as Array<Record<string, string>>,
    };
    const audits: Array<{ action: string; target: string | null }> = [];
    const handler = createCommercialHandler(
      baseDeps({
        selfhostGovernance: createServiceWithFakeGovernor(state),
        governanceAuditWriter: async (_ctx, action, target) => {
          audits.push({ action, target });
        },
      }),
    );

    const signed = makeSignedApproval({ id: "gov-http-0001" });
    await writeFile(path.join(pendingDir, "gov-http-0001.json"), JSON.stringify(signed), "utf8");
    await writeFile(
      path.join(pendingDir, "gov-http-comm.json"),
      JSON.stringify(makeSignedApproval({ id: "gov-http-comm", branch: "feat/v5-aurora-rewrite" })),
      "utf8",
    );

    assert.equal((await dispatch(handler, "GET", "/api/admin/governance/approvals/..%2Fsecret", { token: tokenUid3 })).status, 400);

    const commDecide = await dispatch(handler, "POST", "/api/admin/governance/approvals/gov-http-comm/decide", {
      token: tokenUid3,
      body: { decision: "approve" },
    });
    assert.equal(commDecide.status, 403);
    assert.equal((commDecide.json().error as { code: string }).code, "COMMERCIAL_BRANCH_FORBIDDEN");

    const approveRes = await dispatch(handler, "POST", "/api/admin/governance/approvals/gov-http-0001/decide", {
      token: tokenUid3,
      body: { decision: "approve", expectedVersion: 1, expectedSha256: signed.sha256, autoResumeTrain: true },
    });
    assert.equal(approveRes.status, 200);
    assert.equal((approveRes.json().approval as PendingGovernanceApproval).decision?.resumeStatus, "not_started_busy");
    assert.equal(state.spawns.length, 0);

    // Duplicate decide -> 409 carrying latest approval
    const dupRes = await dispatch(handler, "POST", "/api/admin/governance/approvals/gov-http-0001/decide", {
      token: tokenUid3,
      body: { decision: "reject" },
    });
    assert.equal(dupRes.status, 409);
    const dupBody = dupRes.json<{ error: { code: string }; approval: PendingGovernanceApproval }>();
    assert.equal(dupBody.error.code, "CONFLICT_ALREADY_RESOLVED");
    assert.equal(dupBody.approval.status, "approved");

    // Lock frees -> POST /resume triggers deploy with voucher + expected HEAD
    state.lockBusy = false;
    const resumeRes = await dispatch(handler, "POST", "/api/admin/governance/approvals/gov-http-0001/resume", { token: tokenUid3 });
    assert.equal(resumeRes.status, 200);
    assert.equal((resumeRes.json().approval as PendingGovernanceApproval).decision?.resumeStatus, "started");
    assert.equal(state.spawns.length, 1);

    // Unit crashes -> GET reconciles to failed -> second POST /resume succeeds safely
    state.unitProbe = { status: "failed", detail: "ActiveState=failed" };
    const getFailed = await dispatch(handler, "GET", "/api/admin/governance/approvals/gov-http-0001", { token: tokenUid3 });
    assert.equal((getFailed.json().approval as PendingGovernanceApproval).decision?.resumeStatus, "failed");
    state.unitProbe = { status: "unknown" };
    const retryRes = await dispatch(handler, "POST", "/api/admin/governance/approvals/gov-http-0001/resume", { token: tokenUid3 });
    assert.equal(retryRes.status, 200);
    assert.equal(state.spawns.length, 2);

    assert.deepEqual(
      audits.map((a) => a.action),
      ["governance.approval.approve", "governance.approval.resume", "governance.approval.resume"],
    );
  });

  it("end-to-end real createCommercialHandler + real oc-governor.sh (missing mode, corrupt breaker, expired reopen, A0 gh status, claim/unit fail retry, 409 conflict)", async () => {
    const repoDir = path.join(tmpRoot, "repo");
    const fakeBinDir = path.join(tmpRoot, "bin");
    const ghLogPath = path.join(tmpRoot, "gh-calls.log");
    await mkdir(repoDir, { recursive: true });
    await mkdir(fakeBinDir, { recursive: true });
    const fakeGhPath = path.join(fakeBinDir, "gh");
    await writeFile(fakeGhPath, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${ghLogPath}"\nexit 0\n`, "utf8");
    await chmod(fakeGhPath, 0o755);

    await execFileAsync("git", ["init", "-q", "-b", "feat/v5-selfhost"], { cwd: repoDir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: repoDir });
    await writeFile(path.join(repoDir, "README.md"), "init\n", "utf8");
    await execFileAsync("git", ["add", "README.md"], { cwd: repoDir });
    await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: repoDir });
    const headSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoDir })).stdout.trim();

    const spawns: Array<Record<string, string>> = [];
    let lockBusy = true;
    let unitProbe: ProbeUnitStatusResult = { status: "unknown" };
    const customPath = `${fakeBinDir}:${process.env.PATH ?? "/usr/bin:/bin"}`;
    const envWithRoot = { ...process.env, PATH: customPath, OC_GOVERNOR_ROOT: govRoot };

    const service = createSelfhostGovernanceService({
      governorRoot: govRoot,
      governorBin: REAL_GOVERNOR_SH,
      cockpitDir: path.join(tmpRoot, "cockpit-empty"),
      repoRoot: repoDir,
      deployScriptPath: "/opt/openclaude/openclaude-v5-selfhost/scripts/deploy-v5-selfhost.sh",
      githubRepo: "openclaude/openclaude",
      commandPath: customPath,
      commandEnv: { OC_GOVERNOR_UNSAFE_TEST_SKIP_OWNER: "1" },
      checkDeployBusyFn: async () => ({ busy: lockBusy, detail: "mock deploy lock held" }),
      probeUnitStatusFn: async () => unitProbe,
      spawnDetachedDeployFn: async (input) => {
        spawns.push({ ...input.env, unitName: input.unitName });
        return { started: true, unitName: input.unitName, detail: "recorded-safe-no-deploy" };
      },
    });
    const handler = createCommercialHandler(baseDeps({ selfhostGovernance: service }));

    // 1. Missing mode.json matches train default (uninitialized autonomous, NOT frozen) + corrupt breaker.json reports readError
    await writeFile(path.join(govRoot, "control", "breaker.json"), "{corrupt breaker", "utf8");
    const initOvRes = await dispatch(handler, "GET", "/api/admin/governance/overview", { token: tokenUid3 });
    assert.equal(initOvRes.status, 200);
    const initOv = initOvRes.json<GovernanceOverviewResponse>();
    assert.equal(initOv.mode.mode, "autonomous");
    assert.equal(initOv.mode.uninitialized, true);
    assert.equal(initOv.mode.autoMergeFrozen, false);
    assert.equal(initOv.breaker.readError, true);
    await rm(path.join(govRoot, "control", "breaker.json"), { force: true });

    // 2. Real oc-governor mode switch + breaker trip -> autonomous 409 -> unlock
    const modeRes = await dispatch(handler, "POST", "/api/admin/governance/mode", {
      token: tokenUid3,
      body: { mode: "debt_first", reason: "真实宿主总闸模式切换验证" },
    });
    assert.equal(modeRes.status, 200);

    await execFileAsync(
      REAL_GOVERNOR_SH,
      ["trip-breaker", "--train", "train-real-01", "--reason", "real e2e rollback storm"],
      { env: envWithRoot },
    );
    const blockedAuto = await dispatch(handler, "POST", "/api/admin/governance/mode", {
      token: tokenUid3,
      body: { mode: "autonomous", reason: "尝试绕过熔断切回全自动" },
    });
    assert.equal(blockedAuto.status, 409);
    assert.equal((blockedAuto.json().error as { code: string }).code, "BREAKER_TRIPPED_USE_UNLOCK");

    const unlockRes = await dispatch(handler, "POST", "/api/admin/governance/breaker/unlock", {
      token: tokenUid3,
      body: { reason: "真实联调已完成根因复盘并解锁" },
    });
    assert.equal(unlockRes.status, 200);

    // 3. Real oc-governor blast_voucher -> expired reopen (N1) -> decide (not_started_busy) -> 409 dup -> resume -> unit failed -> retry
    const helpOut = (await execFileAsync(REAL_GOVERNOR_SH, ["--help"])).stdout;
    assert.ok(helpOut.includes("decide-pending-approval"), "real oc-governor.sh must expose decide-pending-approval");
    assert.ok(helpOut.includes("--claim-from"), "real oc-governor.sh must expose --claim-from");

    // 3a. N1: record expired approval in past, verify GET sees expired, then reopen with current time (version 2)
    await execFileAsync(
      REAL_GOVERNOR_SH,
      [
        "record-pending-approval",
        "--id", "gov-real-e2e-01",
        "--kind", "blast_voucher",
        "--code", "BILLING_CORE_LOCKED",
        "--scope", "billing",
        "--branch", "feat/v5-selfhost",
        "--sha", headSha,
        "--ttl-hours", "1",
        "--repo-root", repoDir,
        "--files", "packages/commercial/src/billing/remoteNativeTurnBilling.ts",
      ],
      { env: { ...envWithRoot, OC_GOVERNOR_NOW_ISO: "2020-01-01T00:00:00Z" } },
    );
    const expiredView = (await dispatch(handler, "GET", "/api/admin/governance/approvals/gov-real-e2e-01", { token: tokenUid3 })).json().approval as PendingGovernanceApproval;
    assert.equal(expiredView.status, "expired");

    await execFileAsync(
      REAL_GOVERNOR_SH,
      [
        "record-pending-approval",
        "--id", "gov-real-e2e-01",
        "--kind", "blast_voucher",
        "--code", "BILLING_CORE_LOCKED",
        "--scope", "billing",
        "--branch", "feat/v5-selfhost",
        "--sha", headSha,
        "--repo-root", repoDir,
        "--files", "packages/commercial/src/billing/remoteNativeTurnBilling.ts",
      ],
      { env: envWithRoot },
    );
    const loaded = (await dispatch(handler, "GET", "/api/admin/governance/approvals/gov-real-e2e-01", { token: tokenUid3 })).json().approval as PendingGovernanceApproval;
    assert.equal(loaded.status, "pending");
    assert.equal(loaded.version, 2);

    const decideRes = await dispatch(handler, "POST", "/api/admin/governance/approvals/gov-real-e2e-01/decide", {
      token: tokenUid3,
      body: { decision: "approve", expectedVersion: loaded.version, expectedSha256: loaded.sha256, note: "真实联调批准" },
    });
    assert.equal(decideRes.status, 200);
    const decided = decideRes.json().approval as PendingGovernanceApproval;
    assert.equal(decided.decision?.resumeStatus, "not_started_busy");

    const dupRes = await dispatch(handler, "POST", "/api/admin/governance/approvals/gov-real-e2e-01/decide", {
      token: tokenUid3,
      body: { decision: "approve", expectedVersion: loaded.version, expectedSha256: loaded.sha256 },
    });
    assert.equal(dupRes.status, 409);

    lockBusy = false;
    const resume1 = await dispatch(handler, "POST", "/api/admin/governance/approvals/gov-real-e2e-01/resume", { token: tokenUid3 });
    assert.equal(resume1.status, 200);
    assert.equal((resume1.json().approval as PendingGovernanceApproval).decision?.resumeStatus, "started");
    assert.equal(spawns.length, 1);

    // Unit crashes -> GET reconciles to failed -> safe retry reuses voucher
    unitProbe = { status: "failed", detail: "ActiveState=failed" };
    const afterFail = await dispatch(handler, "GET", "/api/admin/governance/approvals/gov-real-e2e-01", { token: tokenUid3 });
    assert.equal((afterFail.json().approval as PendingGovernanceApproval).decision?.resumeStatus, "failed");
    unitProbe = { status: "unknown" };
    const resume2 = await dispatch(handler, "POST", "/api/admin/governance/approvals/gov-real-e2e-01/resume", { token: tokenUid3 });
    assert.equal(resume2.status, 200);
    assert.equal((resume2.json().approval as PendingGovernanceApproval).decision?.issuedArtifactId, decided.decision?.issuedArtifactId);
    assert.equal(spawns.length, 2);

    // 4. N2: real A0 approval with githubRepo publishes status via gh CLI recorder
    await execFileAsync(
      REAL_GOVERNOR_SH,
      [
        "record-pending-approval",
        "--id", "gov-real-a0-01",
        "--kind", "a0_approval",
        "--code", "A0_GUARDRAIL_CHANGED",
        "--branch", "feat/v5-selfhost",
        "--sha", headSha,
        "--repo-root", repoDir,
        "--files", "scripts/harness-gate/oc-governor.sh",
      ],
      { env: envWithRoot },
    );
    const a0Loaded = (await dispatch(handler, "GET", "/api/admin/governance/approvals/gov-real-a0-01", { token: tokenUid3 })).json().approval as PendingGovernanceApproval;
    const a0Decide = await dispatch(handler, "POST", "/api/admin/governance/approvals/gov-real-a0-01/decide", {
      token: tokenUid3,
      body: { decision: "approve", expectedVersion: a0Loaded.version, expectedSha256: a0Loaded.sha256, note: "真实联调 A0 发布验证" },
    });
    assert.equal(a0Decide.status, 200);
    const ghLog = await readFile(ghLogPath, "utf8");
    assert.match(ghLog, new RegExp(`repos/openclaude/openclaude/statuses/${headSha}`));

    // 5. Steward P1 regression: crashed mid-'approving' docs MUST self-heal via HTTP GET/overview/decide/resume!
    // Case A: voucher ALREADY minted before crash -> GET heals to 'approved', POST /decide returns 409 without duplicate voucher, POST /resume reuses exact minted voucher!
    const mintedVoucherOut = (
      await execFileAsync(
        REAL_GOVERNOR_SH,
        [
          "issue-blast-voucher", "--id", "bv-crashedmint000001", "--scope", "billing",
          "--branch", "feat/v5-selfhost", "--sha", headSha, "--approval-id", "gov-crash-minted",
          "--reason", "simulated post-mint crash recovery", "--files", "packages/commercial/src/billing/remoteNativeTurnBilling.ts",
        ],
        { env: envWithRoot },
      )
    ).stdout;
    const mintedId = (JSON.parse(mintedVoucherOut) as { id: string }).id;
    assert.equal(mintedId, "bv-crashedmint000001");
    await writeFile(
      path.join(pendingDir, "gov-crash-minted.json"),
      JSON.stringify(
        makeSignedApproval({
          id: "gov-crash-minted",
          status: "approving",
          version: 2,
          sha: headSha,
          pendingArtifactId: mintedId,
          decision: { action: "approve", decidedBy: "admin:3", decidedAt: NOW_ISO },
        }),
      ),
      "utf8",
    );
    const healedMintedRes = await dispatch(handler, "GET", "/api/admin/governance/approvals/gov-crash-minted", { token: tokenUid3 });
    assert.equal(healedMintedRes.status, 200);
    const healedMinted = healedMintedRes.json().approval as PendingGovernanceApproval;
    assert.equal(healedMinted.status, "approved");
    assert.equal(healedMinted.decision?.issuedArtifactId, mintedId);
    assert.equal(healedMinted.decision?.resumeStatus, "not_started");
    const dupAfterHeal = await dispatch(handler, "POST", "/api/admin/governance/approvals/gov-crash-minted/decide", {
      token: tokenUid3,
      body: { decision: "approve" },
    });
    assert.equal(dupAfterHeal.status, 409);
    const resumeAfterHeal = await dispatch(handler, "POST", "/api/admin/governance/approvals/gov-crash-minted/resume", { token: tokenUid3 });
    assert.equal(resumeAfterHeal.status, 200);
    assert.equal((resumeAfterHeal.json().approval as PendingGovernanceApproval).decision?.resumeStatus, "started");
    assert.equal(spawns[spawns.length - 1]!.OC_V5_BLAST_VOUCHER, mintedId);

    // Case B: crash BEFORE voucher minted -> POST /decide heals 'approving' -> 'pending' and approves cleanly without staying stuck!
    await writeFile(
      path.join(pendingDir, "gov-crash-pre-mint.json"),
      JSON.stringify(
        makeSignedApproval({
          id: "gov-crash-pre-mint",
          status: "approving",
          version: 2,
          sha: headSha,
          pendingArtifactId: "bv-nevercreated000001",
          decision: { action: "approve", decidedBy: "admin:3", decidedAt: NOW_ISO },
        }),
      ),
      "utf8",
    );
    const decidePreMint = await dispatch(handler, "POST", "/api/admin/governance/approvals/gov-crash-pre-mint/decide", {
      token: tokenUid3,
      body: { decision: "approve", autoResumeTrain: false, note: "崩溃恢复后重新批准" },
    });
    assert.equal(decidePreMint.status, 200);
    const approvedPreMint = decidePreMint.json().approval as PendingGovernanceApproval;
    assert.equal(approvedPreMint.status, "approved");
    assert.ok(approvedPreMint.decision?.issuedArtifactId?.startsWith("bv-"));

    // Case C: GET /overview also heals crashed pre-mint 'approving' into pendingApprovals as 'pending'
    await writeFile(
      path.join(pendingDir, "gov-crash-overview.json"),
      JSON.stringify(
        makeSignedApproval({
          id: "gov-crash-overview",
          status: "approving",
          version: 2,
          sha: headSha,
          pendingArtifactId: "bv-nevercreated000002",
          decision: { action: "approve", decidedBy: "admin:3", decidedAt: NOW_ISO },
        }),
      ),
      "utf8",
    );
    const ovAfterCrash = (await dispatch(handler, "GET", "/api/admin/governance/overview", { token: tokenUid3 })).json<GovernanceOverviewResponse>();
    const healedOvItem = ovAfterCrash.pendingApprovals.find((a) => a.id === "gov-crash-overview");
    assert.equal(healedOvItem?.status, "pending");
  });
});
