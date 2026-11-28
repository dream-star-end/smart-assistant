/**
 * 个人版自托管视觉治理控制面 API 客户端（F1 web-lib）。
 * 供管理中心「自治治理」页面与对话内一键审批卡共享，契约统一源自 `@openclaude/protocol/selfhostGovernance`。
 */
import {
  GOVERNANCE_APPROVAL_ID_RE, type DecideGovernanceApprovalRequest, type GovernanceApprovalClassification,
  type GovernanceApprovalDecision, type GovernanceApprovalKind, type GovernanceApprovalStatus, type GovernanceAuditItem,
  type GovernanceBreakerState, type GovernanceCockpitGauge, type GovernanceCockpitSummary, type GovernanceEffectiveMode,
  type GovernanceMode, type GovernanceModeState, type GovernanceOverviewResponse, type GovernanceResumeStatus,
  type GovernanceSafetyLight, type GovernanceSafetyLightKey, type GovernanceStewardVerdict, type PendingGovernanceApproval, type SafetyLightLevel,
} from "@openclaude/protocol/browser";
import type { AuthSession } from "../types";
import { bearerHeaders, callWithRefresh, jsonOrThrow } from "./http";

export {
  GOVERNANCE_APPROVAL_ID_RE, type DecideGovernanceApprovalRequest, type GovernanceApprovalClassification,
  type GovernanceApprovalDecision, type GovernanceApprovalKind, type GovernanceApprovalStatus, type GovernanceAuditItem,
  type GovernanceBreakerState, type GovernanceCockpitGauge, type GovernanceCockpitSummary, type GovernanceEffectiveMode,
  type GovernanceMode, type GovernanceModeState, type GovernanceOverviewResponse, type GovernanceResumeStatus,
  type GovernanceSafetyLight, type GovernanceSafetyLightKey, type GovernanceStewardVerdict, type PendingGovernanceApproval, type SafetyLightLevel,
};

const BASE_PATH = "/api/admin/governance";

function governanceRequest<T>(
  auth: AuthSession,
  method: "GET" | "POST",
  path: string,
  opts: { body?: unknown; signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<T> {
  const fetcher = opts.fetchImpl ?? fetch;
  const hasBody = opts.body !== undefined;
  return jsonOrThrow<T>(
    callWithRefresh(auth, (token) =>
      fetcher(`${BASE_PATH}${path}`, {
        method,
        credentials: "include",
        headers: bearerHeaders(token, hasBody),
        body: hasBody ? JSON.stringify(opts.body) : undefined,
        signal: opts.signal,
      }),
    ),
  );
}

export function getGovernanceOverview(
  auth: AuthSession,
  signal?: AbortSignal,
  fetchImpl?: typeof fetch,
): Promise<GovernanceOverviewResponse> {
  return governanceRequest<GovernanceOverviewResponse>(auth, "GET", "/overview", { signal, fetchImpl });
}

export function getGovernanceApproval(
  auth: AuthSession,
  id: string,
  signal?: AbortSignal,
  fetchImpl?: typeof fetch,
): Promise<{ approval: PendingGovernanceApproval }> {
  return governanceRequest<{ approval: PendingGovernanceApproval }>(
    auth,
    "GET",
    `/approvals/${encodeURIComponent(id)}`,
    { signal, fetchImpl },
  );
}

export function setGovernanceMode(
  auth: AuthSession,
  body: { mode: GovernanceMode; reason: string },
  fetchImpl?: typeof fetch,
): Promise<{ ok: true; mode: GovernanceOverviewResponse["mode"] }> {
  return governanceRequest<{ ok: true; mode: GovernanceOverviewResponse["mode"] }>(
    auth,
    "POST",
    "/mode",
    { body, fetchImpl },
  );
}

export function unlockGovernanceBreaker(
  auth: AuthSession,
  body: { reason: string },
  fetchImpl?: typeof fetch,
): Promise<{ ok: true; breaker: GovernanceOverviewResponse["breaker"] }> {
  return governanceRequest<{ ok: true; breaker: GovernanceOverviewResponse["breaker"] }>(
    auth,
    "POST",
    "/breaker/unlock",
    { body, fetchImpl },
  );
}

export function decideGovernanceApproval(
  auth: AuthSession,
  id: string,
  body: DecideGovernanceApprovalRequest,
  fetchImpl?: typeof fetch,
): Promise<{ ok: true; approval: PendingGovernanceApproval }> {
  return governanceRequest<{ ok: true; approval: PendingGovernanceApproval }>(
    auth,
    "POST",
    `/approvals/${encodeURIComponent(id)}/decide`,
    { body, fetchImpl },
  );
}

export function resumeGovernanceApproval(
  auth: AuthSession,
  id: string,
  fetchImpl?: typeof fetch,
): Promise<{ ok: true; approval: PendingGovernanceApproval }> {
  return governanceRequest<{ ok: true; approval: PendingGovernanceApproval }>(
    auth,
    "POST",
    `/approvals/${encodeURIComponent(id)}/resume`,
    { body: {}, fetchImpl },
  );
}
