/**
 * OCV5-914 — Admin HTTP control plane for the Selfhost Visual Governance Console
 * (L5 interface-http / http-admin-routes).
 *
 * Auth boundary (R3-handler-auth compliant, matching `modelPoolBindings.ts`):
 *   `router.ts` runs the global `/api/admin/*` `requireAdminVerifyDb` gate (JWT + DB
 *   re-verify) and attaches the verified `AuthedUser` via `setVerifiedAdminForRequest`.
 *
 * Three mandatory security gates enforced here (fail-closed):
 *   1. Verified active admin principal from router's `requireAdminVerifyDb` gate (401/403)
 *   2. `String(admin.id) === "3"` (selfhost owner uid3 only -> 403 FORBIDDEN)
 *   3. `deps.selfhostGovernance` present (commercial instances -> 404 SELFHOST_GOVERNANCE_DISABLED)
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { writeAdminAuditBestEffort, type AdminAuditRequestCtx } from "../../admin/audit.js";
import { isAdminAuditAction } from "../../admin/auditActions.js";
import {
  GovernanceServiceError,
  isValidGovernanceApprovalId,
  isValidGovernanceMode,
  type SelfhostGovernanceService,
} from "../../admin/selfhostGovernanceTypes.js";
import type { AuthedUser } from "../auth.js";
import type { CommercialHttpDeps, RequestContext } from "../handlers.js";
import { HttpError, isObj, readJsonBody, sendJson } from "../util.js";
import { getVerifiedAdminForRequest } from "./modelPoolBindings.js";

const GOVERNANCE_BASE = "/api/admin/governance";
const SHA64_RE = /^[0-9a-f]{64}$/;

const GOVERNANCE_AUDIT_ACTIONS = {
  mode: "governance.mode",
  breakerUnlock: "governance.breaker.unlock",
  approvalApprove: "governance.approval.approve",
  approvalReject: "governance.approval.reject",
  approvalResume: "governance.approval.resume",
} as const;

type GovernanceAuditActionName =
  (typeof GOVERNANCE_AUDIT_ACTIONS)[keyof typeof GOVERNANCE_AUDIT_ACTIONS];

export type AdminGovernanceAuditWriter = (
  ctx: AdminAuditRequestCtx,
  action: GovernanceAuditActionName,
  target: string | null,
  before: unknown,
  after: unknown,
) => Promise<void>;

export type AdminGovernanceDeps = CommercialHttpDeps & {
  selfhostGovernance?: SelfhostGovernanceService;
  /** Test seam ONLY: observe audit events without a live PG pool. */
  governanceAuditWriter?: AdminGovernanceAuditWriter;
};

function assertVerifiedSelfhostAdmin(req: IncomingMessage): AuthedUser {
  const admin = getVerifiedAdminForRequest(req);
  if (!admin) throw new HttpError(401, "UNAUTHORIZED", "admin authentication required");
  if (admin.role !== "admin") throw new HttpError(403, "FORBIDDEN", "admin role required");
  if (String(admin.id) !== "3") {
    throw new HttpError(403, "FORBIDDEN", "governance control plane is restricted to selfhost admin uid3");
  }
  return admin;
}

async function recordGovernanceAudit(
  writer: AdminGovernanceAuditWriter | undefined,
  auditCtx: AdminAuditRequestCtx,
  action: GovernanceAuditActionName,
  target: string | null,
  before: unknown,
  after: unknown,
): Promise<void> {
  if (writer) {
    await writer(auditCtx, action, target, before, after);
    return;
  }
  if (isAdminAuditAction(action)) {
    await writeAdminAuditBestEffort(auditCtx, action, target, before, after);
  }
}

function decodeApprovalIdSegment(rawSegment: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawSegment);
  } catch (err) {
    void err;
    throw new HttpError(400, "VALIDATION", "malformed approval id encoding");
  }
  if (!isValidGovernanceApprovalId(decoded)) throw new HttpError(400, "VALIDATION", "invalid approval id");
  return decoded;
}

async function readRequiredObjectBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readJsonBody(req);
  if (!isObj(body) || Array.isArray(body)) {
    throw new HttpError(400, "VALIDATION", "request body must be a JSON object");
  }
  return body;
}

async function handlePostMode(
  req: IncomingMessage,
  res: ServerResponse,
  service: SelfhostGovernanceService,
  auditCtx: AdminAuditRequestCtx,
  auditWriter: AdminGovernanceAuditWriter | undefined,
): Promise<void> {
  const body = await readRequiredObjectBody(req);
  const mode = typeof body.mode === "string" ? body.mode.trim() : "";
  const reason = typeof body.reason === "string" ? body.reason : "";
  if (!isValidGovernanceMode(mode)) {
    throw new HttpError(400, "VALIDATION", "mode must be autonomous, debt_first, or emergency_stop");
  }
  const actor = `admin:${String(auditCtx.adminId)}`;
  const modeState = await service.setMode(mode, reason, actor);
  await recordGovernanceAudit(auditWriter, auditCtx, GOVERNANCE_AUDIT_ACTIONS.mode, "governance:mode", null, {
    mode: modeState.mode,
    autoMergeFrozen: modeState.autoMergeFrozen,
    reason: modeState.reason,
  });
  sendJson(res, 200, { ok: true, mode: modeState });
}

async function handlePostBreakerUnlock(
  req: IncomingMessage,
  res: ServerResponse,
  service: SelfhostGovernanceService,
  auditCtx: AdminAuditRequestCtx,
  auditWriter: AdminGovernanceAuditWriter | undefined,
): Promise<void> {
  const body = await readRequiredObjectBody(req);
  const reason = typeof body.reason === "string" ? body.reason : "";
  const actor = `admin:${String(auditCtx.adminId)}`;
  const breaker = await service.unlockBreaker(reason, actor);
  await recordGovernanceAudit(auditWriter, auditCtx, GOVERNANCE_AUDIT_ACTIONS.breakerUnlock, "governance:breaker", null, {
    tripped: breaker.tripped,
    reason: reason.trim(),
  });
  sendJson(res, 200, { ok: true, breaker });
}

function parseOptionalLockFields(body: Record<string, unknown>): {
  expectedVersion?: number;
  expectedSha256?: string;
  allowWholeCommit?: boolean;
} {
  const out: { expectedVersion?: number; expectedSha256?: string; allowWholeCommit?: boolean } = {};
  if (body.expectedVersion !== undefined) {
    if (typeof body.expectedVersion !== "number" || !Number.isInteger(body.expectedVersion) || body.expectedVersion < 1) {
      throw new HttpError(400, "VALIDATION", "expectedVersion must be a positive integer");
    }
    out.expectedVersion = body.expectedVersion;
  }
  if (body.expectedSha256 !== undefined) {
    if (typeof body.expectedSha256 !== "string" || !SHA64_RE.test(body.expectedSha256)) {
      throw new HttpError(400, "VALIDATION", "expectedSha256 must be a 64-char lowercase hex digest");
    }
    out.expectedSha256 = body.expectedSha256;
  }
  if (body.allowWholeCommit !== undefined) {
    if (typeof body.allowWholeCommit !== "boolean") {
      throw new HttpError(400, "VALIDATION", "allowWholeCommit must be a boolean");
    }
    out.allowWholeCommit = body.allowWholeCommit;
  }
  return out;
}

function parseDecideBody(body: Record<string, unknown>): {
  decision: "approve" | "reject";
  note?: string;
  autoResumeTrain?: boolean;
  expectedVersion?: number;
  expectedSha256?: string;
  allowWholeCommit?: boolean;
} {
  const decision = body.decision;
  if (decision !== "approve" && decision !== "reject") {
    throw new HttpError(400, "VALIDATION", "decision must be 'approve' or 'reject'");
  }
  if (body.note !== undefined && typeof body.note !== "string") {
    throw new HttpError(400, "VALIDATION", "note must be a string");
  }
  if (body.autoResumeTrain !== undefined && typeof body.autoResumeTrain !== "boolean") {
    throw new HttpError(400, "VALIDATION", "autoResumeTrain must be a boolean");
  }
  return {
    decision,
    ...(typeof body.note === "string" ? { note: body.note } : {}),
    ...(typeof body.autoResumeTrain === "boolean" ? { autoResumeTrain: body.autoResumeTrain } : {}),
    ...parseOptionalLockFields(body),
  };
}

async function handlePostApprovalDecide(
  req: IncomingMessage,
  res: ServerResponse,
  rawIdSegment: string,
  service: SelfhostGovernanceService,
  auditCtx: AdminAuditRequestCtx,
  auditWriter: AdminGovernanceAuditWriter | undefined,
): Promise<void> {
  const id = decodeApprovalIdSegment(rawIdSegment);
  const parsed = parseDecideBody(await readRequiredObjectBody(req));
  const actor = `admin:${String(auditCtx.adminId)}`;
  const approval = await service.decideApproval(id, parsed, actor);
  const auditAction =
    parsed.decision === "approve"
      ? GOVERNANCE_AUDIT_ACTIONS.approvalApprove
      : GOVERNANCE_AUDIT_ACTIONS.approvalReject;
  await recordGovernanceAudit(auditWriter, auditCtx, auditAction, `approval:${id}`, null, {
    decision: parsed.decision,
    status: approval.status,
    issuedArtifactId: approval.decision?.issuedArtifactId ?? null,
    resumeStatus: approval.decision?.resumeStatus ?? null,
  });
  sendJson(res, 200, { ok: true, approval });
}

async function handlePostApprovalResume(
  res: ServerResponse,
  rawIdSegment: string,
  service: SelfhostGovernanceService,
  auditCtx: AdminAuditRequestCtx,
  auditWriter: AdminGovernanceAuditWriter | undefined,
): Promise<void> {
  const id = decodeApprovalIdSegment(rawIdSegment);
  const actor = `admin:${String(auditCtx.adminId)}`;
  const approval = await service.resumeApproval(id, actor);
  await recordGovernanceAudit(auditWriter, auditCtx, GOVERNANCE_AUDIT_ACTIONS.approvalResume, `approval:${id}`, null, {
    status: approval.status,
    issuedArtifactId: approval.decision?.issuedArtifactId ?? null,
    resumeStatus: approval.decision?.resumeStatus ?? null,
    resumeUnit: approval.decision?.resumeUnit ?? null,
  });
  sendJson(res, 200, { ok: true, approval });
}

function parseGovernancePath(req: IncomingMessage): { method: string; suffix: string } {
  const rawUrl = req.url ?? "/";
  const pathPart = rawUrl.split("?")[0] ?? "/";
  if (pathPart !== GOVERNANCE_BASE && !pathPart.startsWith(`${GOVERNANCE_BASE}/`)) {
    throw new HttpError(404, "NOT_FOUND", "unknown governance path");
  }
  return { method: req.method ?? "GET", suffix: pathPart.slice(GOVERNANCE_BASE.length) };
}

async function dispatchGovernanceRoute(
  req: IncomingMessage,
  res: ServerResponse,
  service: SelfhostGovernanceService,
  auditCtx: AdminAuditRequestCtx,
  auditWriter: AdminGovernanceAuditWriter | undefined,
): Promise<void> {
  const { method, suffix } = parseGovernancePath(req);
  if (method === "GET" && suffix === "/overview") {
    sendJson(res, 200, await service.getOverview());
    return;
  }
  if (method === "GET" && suffix.startsWith("/approvals/")) {
    const id = decodeApprovalIdSegment(suffix.slice("/approvals/".length));
    sendJson(res, 200, { approval: await service.getApproval(id) });
    return;
  }
  if (method === "POST" && suffix === "/mode") {
    await handlePostMode(req, res, service, auditCtx, auditWriter);
    return;
  }
  if (method === "POST" && suffix === "/breaker/unlock") {
    await handlePostBreakerUnlock(req, res, service, auditCtx, auditWriter);
    return;
  }
  if (method === "POST" && suffix.startsWith("/approvals/") && suffix.endsWith("/decide")) {
    const rawId = suffix.slice("/approvals/".length, -"/decide".length);
    await handlePostApprovalDecide(req, res, rawId, service, auditCtx, auditWriter);
    return;
  }
  if (method === "POST" && suffix.startsWith("/approvals/") && suffix.endsWith("/resume")) {
    const rawId = suffix.slice("/approvals/".length, -"/resume".length);
    await handlePostApprovalResume(res, rawId, service, auditCtx, auditWriter);
    return;
  }
  throw new HttpError(404, "NOT_FOUND", "unknown governance endpoint");
}

export async function handleAdminGovernance(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: AdminGovernanceDeps,
): Promise<void> {
  const admin = assertVerifiedSelfhostAdmin(req);
  const service = deps.selfhostGovernance;
  if (!service) {
    throw new HttpError(404, "SELFHOST_GOVERNANCE_DISABLED", "selfhost governance control plane is not enabled on this instance");
  }
  const auditCtx: AdminAuditRequestCtx = { adminId: admin.id, ip: ctx.clientIp, userAgent: ctx.userAgent };
  try {
    await dispatchGovernanceRoute(req, res, service, auditCtx, deps.governanceAuditWriter);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err instanceof GovernanceServiceError) {
      if (err.status === 409) {
        sendJson(res, 409, {
          error: { code: err.code, message: err.message, request_id: ctx.requestId },
          ...(err.approval ? { approval: err.approval } : {}),
        });
        return;
      }
      throw new HttpError(err.status, err.code, err.message);
    }
    throw err;
  }
}
