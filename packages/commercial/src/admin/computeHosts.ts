/**
 * V3 D.3 — 超管 compute_hosts(虚机池)CRUD + bootstrap orchestration。
 *
 * 本文件职责:
 *   - 入参校验 → 加密凭据 → 调 queries 写 DB → 异步 kick off bootstrap → 写 audit
 *   - 只返 admin UI 需要的 HostView,隐藏所有密文 / nonce / cert PEM
 *
 * 和 admin/accounts.ts 同构:业务失败走 HttpError,审计 best-effort。
 */

import { randomUUID, randomBytes } from "node:crypto";
import { HttpError } from "../http/util.js";
import { writeAdminAudit } from "./audit.js";
import { incrAdminAuditWriteFailure } from "./metrics.js";
import type { AdminAuditCtx } from "./accounts.js";
import * as queries from "../compute-pool/queries.js";
import type { ComputeHostRow, ComputeHostStatus } from "../compute-pool/types.js";
import {
  encryptSshPassword,
  encryptAgentPsk,
} from "../compute-pool/crypto.js";
import { bootstrapHost } from "../compute-pool/nodeBootstrap.js";
import {
  getBaselineVersion as rpcGetBaselineVersion,
  hostRowToTarget,
} from "../compute-pool/nodeAgentClient.js";
import { getBaselineServer } from "../compute-pool/baselineServer.js";
import { decryptSshPassword } from "../compute-pool/crypto.js";
import {
  distributePreheatToAllHosts,
  streamImageToHost,
  ImageDistributeError,
  type DistributeHostResult,
} from "../compute-pool/imageDistribute.js";
import type { SshTarget } from "../compute-pool/sshExec.js";
import { rootLogger } from "../logging/logger.js";

const log = rootLogger.child({ subsys: "admin.computeHosts" });

// ─── View model(admin UI 用,无密文 / nonce / cert PEM)──────────────

export interface ComputeHostView {
  id: string;
  name: string;
  host: string;
  ssh_port: number;
  ssh_user: string;
  agent_port: number;
  status: ComputeHostStatus;
  max_containers: number;
  active_containers: number;
  cert_not_before: string | null; // ISO8601
  cert_not_after: string | null;
  last_health_at: string | null;
  last_health_ok: boolean | null;
  last_health_err: string | null;
  consecutive_health_ok: number;
  consecutive_health_fail: number;
  last_bootstrap_at: string | null;
  last_bootstrap_err: string | null;
  /** 0041:VPS 租期到期 ISO8601(UTC,toISOString())。null = 永久/未填。 */
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

function mapRowToView(row: ComputeHostRow, activeContainers: number): ComputeHostView {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    ssh_port: row.ssh_port,
    ssh_user: row.ssh_user,
    agent_port: row.agent_port,
    status: row.status,
    max_containers: row.max_containers,
    active_containers: activeContainers,
    cert_not_before: row.agent_cert_not_before ? row.agent_cert_not_before.toISOString() : null,
    cert_not_after: row.agent_cert_not_after ? row.agent_cert_not_after.toISOString() : null,
    last_health_at: row.last_health_at ? row.last_health_at.toISOString() : null,
    last_health_ok: row.last_health_ok ?? null,
    last_health_err: row.last_health_err ?? null,
    consecutive_health_ok: row.consecutive_health_ok ?? 0,
    consecutive_health_fail: row.consecutive_health_fail ?? 0,
    last_bootstrap_at: row.last_bootstrap_at ? row.last_bootstrap_at.toISOString() : null,
    last_bootstrap_err: row.last_bootstrap_err ?? null,
    expires_at: row.expires_at ? row.expires_at.toISOString() : null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

// ─── best-effort audit(同 accounts.ts)────────────────────────────

async function bestEffortAudit(
  ctx: AdminAuditCtx,
  action: string,
  target: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): Promise<void> {
  const { getPool } = await import("../db/index.js");
  try {
    await writeAdminAudit(getPool(), {
      adminId: ctx.adminId,
      action,
      target,
      before,
      after,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    });
  } catch (err) {
    incrAdminAuditWriteFailure(action);
    (ctx.onAuditError ?? ((e) => {
      // eslint-disable-next-line no-console
      console.error("[admin/computeHosts] admin_audit write failed:", e);
    }))(err);
  }
}

// ─── list ────────────────────────────────────────────────────────

export async function listComputeHostsForAdmin(): Promise<ComputeHostView[]> {
  const hosts = await queries.listAllHostsWithCounts();
  return hosts.map(({ row, activeContainers }) => mapRowToView(row, activeContainers));
}

// ─── create ──────────────────────────────────────────────────────

const HOST_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const IPV4_OR_HOST_RE = /^[a-zA-Z0-9][a-zA-Z0-9.\-]{0,253}$/;
const CIDR_RE = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
/**
 * 0041:严格的 timezone-aware ISO8601。
 * - 必须 `YYYY-MM-DDTHH:mm` 至少
 * - 可选秒/毫秒
 * - 强制 timezone offset:`Z` 或 `[+-]HH:MM`(冒号必填,拒 `+0800`)
 * 这样后端永远不会因"裸时间字符串"而把本地时间误当 UTC。
 */
const ISO_TZ_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * 解析 expires_at 入参。
 *   - undefined → 调用方根据语义决定(create 时 = 不填 = NULL)
 *   - null      → 显式清空
 *   - string    → 必须满足 ISO_TZ_RE 且 Date.parse 成功
 *   - 其他      → 400
 */
function parseExpiresAtInput(raw: unknown, fieldName = "expires_at"): Date | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "string") {
    throw new HttpError(400, "VALIDATION", `${fieldName} must be string|null`);
  }
  if (raw === "") {
    // 把空串视为"不变"是危险约定;统一拒,要求显式 null
    throw new HttpError(400, "VALIDATION", `${fieldName} must be ISO8601 with timezone offset, or null`);
  }
  if (!ISO_TZ_RE.test(raw)) {
    throw new HttpError(
      400,
      "VALIDATION",
      `${fieldName} must be timezone-aware ISO8601 like '2026-05-27T19:45:00+08:00' or '2026-05-27T11:45:00Z'`,
    );
  }
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) {
    throw new HttpError(400, "VALIDATION", `${fieldName} parse failed: ${raw}`);
  }
  return new Date(ts);
}

export interface CreateComputeHostInput {
  name: string;
  host: string;
  ssh_port?: number;
  ssh_user: string;
  password: string;
  agent_port?: number;
  bridge_cidr: string;
  max_containers?: number;
  /** 0041:可选,timezone-aware ISO8601;省略 / null 都表示不填(NULL)。 */
  expires_at?: string | null;
}

function validateCreateInput(input: unknown): Required<Omit<CreateComputeHostInput, "password" | "expires_at">> & {
  password: string;
  expires_at: Date | null;
} {
  if (!input || typeof input !== "object") {
    throw new HttpError(400, "VALIDATION", "body must be object");
  }
  const b = input as Record<string, unknown>;
  const name = String(b.name ?? "");
  if (!HOST_NAME_RE.test(name)) {
    throw new HttpError(400, "VALIDATION", "name must match [a-zA-Z0-9][a-zA-Z0-9_-]{0,63}");
  }
  if (name === "self") {
    throw new HttpError(400, "VALIDATION", "name 'self' is reserved");
  }
  const host = String(b.host ?? "").trim();
  if (!IPV4_OR_HOST_RE.test(host)) {
    throw new HttpError(400, "VALIDATION", "host invalid");
  }
  const sshPort = Number(b.ssh_port ?? 22);
  if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) {
    throw new HttpError(400, "VALIDATION", "ssh_port must be 1..65535");
  }
  const sshUser = String(b.ssh_user ?? "").trim();
  if (!sshUser || sshUser.length > 64) {
    throw new HttpError(400, "VALIDATION", "ssh_user required and <=64 chars");
  }
  const password = String(b.password ?? "");
  if (!password) {
    throw new HttpError(400, "VALIDATION", "password required");
  }
  // 字节长度上限 512B;中文/emoji 场景下字符数会比字节数少
  if (Buffer.byteLength(password, "utf8") > 512) {
    throw new HttpError(400, "VALIDATION", "password too long (>512 bytes)");
  }
  const agentPort = Number(b.agent_port ?? 9443);
  if (!Number.isInteger(agentPort) || agentPort < 1024 || agentPort > 65535) {
    throw new HttpError(400, "VALIDATION", "agent_port must be 1024..65535");
  }
  const bridgeCidr = String(b.bridge_cidr ?? "").trim();
  if (!CIDR_RE.test(bridgeCidr)) {
    throw new HttpError(400, "VALIDATION", "bridge_cidr must be CIDR like 172.30.1.0/24");
  }
  const maxContainers = Number(b.max_containers ?? 20);
  if (!Number.isInteger(maxContainers) || maxContainers < 1 || maxContainers > 200) {
    throw new HttpError(400, "VALIDATION", "max_containers must be 1..200");
  }
  // 0041:expires_at 可省;省略 → NULL。显式 null / 校验通过 → 直接用。
  const parsedExpiresAt = parseExpiresAtInput(b.expires_at);
  const expiresAt: Date | null = parsedExpiresAt === undefined ? null : parsedExpiresAt;
  return {
    name,
    host,
    ssh_port: sshPort,
    ssh_user: sshUser,
    password,
    agent_port: agentPort,
    bridge_cidr: bridgeCidr,
    max_containers: maxContainers,
    expires_at: expiresAt,
  };
}

export interface CreateComputeHostResult {
  hostId: string;
  status: ComputeHostStatus;
}

export async function createComputeHost(
  rawInput: unknown,
  ctx: AdminAuditCtx,
): Promise<CreateComputeHostResult> {
  const input = validateCreateInput(rawInput);

  // 重名检查(friendlier than后端 unique constraint 错)
  const existing = await queries.getHostByName(input.name);
  if (existing) {
    throw new HttpError(409, "DUPLICATE_NAME", `host name '${input.name}' already exists`);
  }

  // 预生成 UUID → 加密用它绑 AAD → INSERT 用同一个
  const hostId = randomUUID();
  const sshEnc = encryptSshPassword(hostId, input.password);
  const pskPlain = randomBytes(32);
  let pskEnc;
  try {
    pskEnc = encryptAgentPsk(hostId, pskPlain);
  } finally {
    pskPlain.fill(0);
  }

  // `getHostByName` 预检只缓解 race 的一小部分——两个并发 create 仍可能都通过预检
  // 走到 INSERT,此时 DB 的 unique(name) 约束会抛 23505。兜底一次映射成 409,
  // 避免把业务语义退化成 500。
  let row;
  try {
    row = await queries.createHost({
      id: hostId,
      name: input.name,
      host: input.host,
      sshPort: input.ssh_port,
      sshUser: input.ssh_user,
      agentPort: input.agent_port,
      sshPasswordNonce: sshEnc.nonce,
      sshPasswordCt: sshEnc.ciphertext,
      agentPskNonce: pskEnc.nonce,
      agentPskCt: pskEnc.ciphertext,
      maxContainers: input.max_containers,
      bridgeCidr: input.bridge_cidr,
      expiresAt: input.expires_at,
    });
  } catch (err) {
    if (err && typeof err === "object" && (err as { code?: string }).code === "23505") {
      throw new HttpError(409, "DUPLICATE_NAME", `host name '${input.name}' already exists`);
    }
    throw err;
  }

  // 异步 kick off bootstrap —— admin UI 立即看到 bootstrapping,轮询 bootstrap-log
  // 观察 step。bootstrap 内部自己 markBootstrapResult(成功 ready / 失败 broken)。
  // 用 setImmediate 避开同一 tick 的 unhandledRejection,更容易观测。
  setImmediate(() => {
    bootstrapHost({
      hostId: row.id,
      bridgeCIDR: input.bridge_cidr,
      agentPort: input.agent_port,
    })
      .then((result) => {
        log.info("bootstrap finished", { hostId: row.id, kind: result.kind });
      })
      .catch((err) => {
        log.error("bootstrap threw unexpectedly", {
          hostId: row.id,
          err: err instanceof Error ? err.message : String(err),
        });
      });
  });

  // audit 只写安全字段,不写密文
  await bestEffortAudit(ctx, "compute_host.create", `compute_host:${row.id}`, null, {
    name: input.name,
    host: input.host,
    ssh_port: input.ssh_port,
    ssh_user: input.ssh_user,
    agent_port: input.agent_port,
    bridge_cidr: input.bridge_cidr,
    max_containers: input.max_containers,
    expires_at: input.expires_at ? input.expires_at.toISOString() : null,
  });

  return { hostId: row.id, status: row.status };
}

// ─── bootstrap log ───────────────────────────────────────────────

export interface BootstrapLogView {
  host_id: string;
  status: ComputeHostStatus;
  last_bootstrap_at: string | null;
  last_bootstrap_err: string | null;
  failed_step: string | null;
}

export async function getBootstrapLog(hostId: string): Promise<BootstrapLogView> {
  const row = await queries.getHostById(hostId);
  if (!row) {
    throw new HttpError(404, "NOT_FOUND", `compute host ${hostId} not found`);
  }
  // last_bootstrap_err 格式: "${step}: ${msg}" (nodeBootstrap.ts markBootstrapResult)
  let failedStep: string | null = null;
  if (row.last_bootstrap_err) {
    const m = /^([a-z_]+):\s/.exec(row.last_bootstrap_err);
    if (m) failedStep = m[1] ?? null;
  }
  return {
    host_id: row.id,
    status: row.status,
    last_bootstrap_at: row.last_bootstrap_at ? row.last_bootstrap_at.toISOString() : null,
    last_bootstrap_err: row.last_bootstrap_err ?? null,
    failed_step: failedStep,
  };
}

// ─── drain / remove / quarantine-clear ───────────────────────────

export async function drainComputeHost(id: string, ctx: AdminAuditCtx): Promise<void> {
  const row = await queries.getHostById(id);
  if (!row) throw new HttpError(404, "NOT_FOUND", `compute host ${id} not found`);
  if (row.name === "self") {
    throw new HttpError(403, "FORBIDDEN", "cannot drain self host");
  }
  const ok = await queries.setDraining(id);
  if (!ok) {
    throw new HttpError(
      409,
      "NOT_DRAINABLE",
      `host status '${row.status}' not in (ready/quarantined/broken) — cannot drain`,
    );
  }
  await bestEffortAudit(ctx, "compute_host.drain", `compute_host:${id}`, { status: row.status }, { status: "draining" });
}

export async function removeComputeHost(id: string, ctx: AdminAuditCtx): Promise<void> {
  // queries.deleteHost 已包含:self 拒、draining 检查、active=0 检查、ID 存在性
  // throw message 我们按文案 map 成 HttpError code/status
  try {
    const ok = await queries.deleteHost(id);
    if (!ok) {
      throw new HttpError(404, "NOT_FOUND", `compute host ${id} not found`);
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("cannot delete self host")) {
      throw new HttpError(403, "FORBIDDEN", "cannot delete self host");
    }
    if (msg.includes("draining status")) {
      throw new HttpError(409, "NOT_DRAINING", msg);
    }
    if (msg.includes("active containers")) {
      throw new HttpError(409, "HAS_ACTIVE_CONTAINERS", msg);
    }
    throw err;
  }
  await bestEffortAudit(ctx, "compute_host.remove", `compute_host:${id}`, null, null);
}

export async function clearQuarantineForHost(id: string, ctx: AdminAuditCtx): Promise<void> {
  const row = await queries.getHostById(id);
  if (!row) throw new HttpError(404, "NOT_FOUND", `compute host ${id} not found`);
  const ok = await queries.clearQuarantine(id);
  if (!ok) {
    throw new HttpError(
      409,
      "NOT_QUARANTINED",
      `host status '${row.status}' is not 'quarantined' — nothing to clear`,
    );
  }
  await bestEffortAudit(
    ctx,
    "compute_host.quarantine_clear",
    `compute_host:${id}`,
    { status: row.status },
    { status: "ready" },
  );
}

// ─── 0041:update expires_at ─────────────────────────────────────

/**
 * 更新 host 的 expires_at(VPS 租期到期时间)。
 * body 必须显式带 `expires_at` key:string(ISO8601 + tz offset)或 null(清空)。
 * 缺 key / 空字符串 / 非时区感知字符串 → 400(见 parseExpiresAtInput)。
 *
 * self host 也允许改(boss 不会去碰,但不在后端做 self 特例硬拦)。
 */
export async function updateComputeHostExpiresAt(
  id: string,
  rawBody: unknown,
  ctx: AdminAuditCtx,
): Promise<void> {
  if (!rawBody || typeof rawBody !== "object") {
    throw new HttpError(400, "VALIDATION", "body must be object");
  }
  const b = rawBody as Record<string, unknown>;
  if (!("expires_at" in b)) {
    throw new HttpError(400, "VALIDATION", "expires_at key is required (use null to clear)");
  }
  const parsed = parseExpiresAtInput(b.expires_at);
  if (parsed === undefined) {
    // 经过 parseExpiresAtInput,只有 raw === undefined 才返 undefined,
    // 但我们前面已经 assert key 存在,理论不可达。补一道防御保险。
    throw new HttpError(400, "VALIDATION", "expires_at must be ISO8601 string with tz offset, or null");
  }

  const row = await queries.getHostById(id);
  if (!row) {
    throw new HttpError(404, "NOT_FOUND", `compute host ${id} not found`);
  }

  const ok = await queries.updateExpiresAt(id, parsed);
  if (!ok) {
    // race: row 在 getHostById 与 update 之间被删除
    throw new HttpError(404, "NOT_FOUND", `compute host ${id} not found`);
  }

  const beforeIso = row.expires_at ? row.expires_at.toISOString() : null;
  const afterIso = parsed ? parsed.toISOString() : null;
  await bestEffortAudit(
    ctx,
    "compute_host.update_expires_at",
    `compute_host:${id}`,
    { expires_at: beforeIso },
    { expires_at: afterIso },
  );
}

// ─── baseline version ────────────────────────────────────────────

export interface BaselineVersionPerHost {
  host_id: string;
  name: string;
  remote_version: string | null;
  err: string | null;
}

export interface BaselineVersionView {
  master_version: string | null;
  master_err: string | null;
  per_host: BaselineVersionPerHost[];
}

/** admin 聚合查询:master 当前 baseline 版本 + 每个 remote host 已同步版本。 */
export async function getBaselineVersions(): Promise<BaselineVersionView> {
  // master 侧:baselineServer 可能未初始化(启动序列相关)→ 降级返 null + err,不 500
  let masterVersion: string | null = null;
  let masterErr: string | null = null;
  try {
    masterVersion = getBaselineServer().getVersion() || null;
  } catch (e) {
    masterErr = e instanceof Error ? e.message : String(e);
  }

  const hosts = await queries.listAllHosts();
  const perHostResults = await Promise.allSettled(
    hosts
      .filter((h) => h.name !== "self") // self host 不跑 node-agent
      .map(async (row): Promise<BaselineVersionPerHost> => {
        try {
          const v = await rpcGetBaselineVersion(hostRowToTarget(row), { timeoutMs: 5000 });
          return { host_id: row.id, name: row.name, remote_version: v || null, err: null };
        } catch (e) {
          return {
            host_id: row.id,
            name: row.name,
            remote_version: null,
            err: e instanceof Error ? e.message : String(e),
          };
        }
      }),
  );
  const perHost = perHostResults.map((r) => {
    if (r.status === "fulfilled") return r.value;
    // 理论上不可达(await 内已 try/catch),但兜底
    return { host_id: "", name: "", remote_version: null, err: String(r.reason) };
  });

  return {
    master_version: masterVersion,
    master_err: masterErr,
    per_host: perHost,
  };
}

// ─── distribute v3 runtime image to remote hosts ─────────────────

/**
 * 业务层:把 OC_RUNTIME_IMAGE stream 到所有 ready 的 remote host。
 * 同步等待返回 per-host 结果(`already` / `loaded` / `error`)。
 *
 * 调用场景:运维 build-image.sh 之后 curl 一次,把新 image 摊到全集群,
 * 避免靠用户调度时 docker auto-pull 失败再走 ImageNotFound 5min retry。
 *
 * 注意:3.5GB image 在慢链路可能 5-10 分钟。前端/反代 timeout 要够长。
 */
export async function adminDistributeImageToAllHosts(
  ctx: AdminAuditCtx,
): Promise<DistributeHostResult[]> {
  const image = process.env.OC_RUNTIME_IMAGE?.trim() ?? "";
  if (!image) {
    throw new HttpError(412, "PRECONDITION_FAILED", "OC_RUNTIME_IMAGE not set in env");
  }
  log.info("admin distribute-image to all hosts", { adminId: String(ctx.adminId), image });
  const results = await distributePreheatToAllHosts(image, { logger: log });
  await bestEffortAudit(
    ctx,
    "compute_host.distribute_image_all",
    `image:${image}`,
    null,
    {
      image,
      hosts: results.map((r) => ({
        name: r.hostName, outcome: r.outcome,
        durationMs: r.durationMs, bytes: r.bytes ?? null,
        errorSource: r.errorSource ?? null,
      })),
    },
  );
  return results;
}

/**
 * 业务层:把 OC_RUNTIME_IMAGE stream 到指定 host。
 *
 * 与 all-hosts 版本不同:**允许非 ready 状态**(运维场景:bootstrap 失败的
 * host 想手动补镜像后重新 bootstrap;quarantined host 准备 reuse)。
 * self host 仍然拒绝(本地 docker 不需要 SSH stream)。
 */
export async function adminDistributeImageToHost(
  hostId: string,
  ctx: AdminAuditCtx,
): Promise<DistributeHostResult> {
  const image = process.env.OC_RUNTIME_IMAGE?.trim() ?? "";
  if (!image) {
    throw new HttpError(412, "PRECONDITION_FAILED", "OC_RUNTIME_IMAGE not set in env");
  }
  const row = await queries.getHostById(hostId);
  if (!row) throw new HttpError(404, "NOT_FOUND", `compute host ${hostId} not found`);
  if (row.name === "self") {
    throw new HttpError(403, "FORBIDDEN", "cannot distribute image to self host (use local docker)");
  }
  log.info("admin distribute-image to host", {
    adminId: String(ctx.adminId), hostId, hostName: row.name, image,
  });

  let password: Buffer | null = null;
  let result: DistributeHostResult;
  try {
    try {
      password = decryptSshPassword(row.id, row.ssh_password_nonce, row.ssh_password_ct);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new HttpError(500, "DECRYPT_FAILED", `decrypt ssh password: ${msg}`);
    }
    // 同 _distributeOne / nodeBootstrap.ts:141-146 —— 当前 fingerprint 是远端
    // ssh-keyscan 127.0.0.1 写入,host marker 与外连目标不匹配,strict 必失败。
    // 等 0031 严格化时与 nodeBootstrap 一起切。
    const target: SshTarget = {
      host: row.host,
      port: row.ssh_port,
      username: row.ssh_user,
      password,
      knownHostsContent: null,
    };
    try {
      const r = await streamImageToHost(target, image, { hostId: row.id, logger: log });
      result = {
        hostId: row.id,
        hostName: row.name,
        outcome: r.outcome,
        durationMs: r.durationMs,
        bytes: r.bytes,
      };
    } catch (e) {
      if (e instanceof ImageDistributeError) {
        result = {
          hostId: row.id,
          hostName: row.name,
          outcome: "error",
          durationMs: e.durationMs,
          bytes: e.bytesTransferred,
          error: e.message,
          errorSource: e.source,
        };
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        result = {
          hostId: row.id,
          hostName: row.name,
          outcome: "error",
          durationMs: 0,
          error: msg,
        };
      }
    }
  } finally {
    if (password) password.fill(0);
  }

  await bestEffortAudit(
    ctx,
    "compute_host.distribute_image",
    `compute_host:${hostId}`,
    { image },
    {
      outcome: result.outcome,
      durationMs: result.durationMs,
      bytes: result.bytes ?? null,
      errorSource: result.errorSource ?? null,
    },
  );
  return result;
}
