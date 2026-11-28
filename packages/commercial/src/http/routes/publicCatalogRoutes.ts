import type { IncomingMessage, ServerResponse } from "node:http";
import { findRouteProviderForModel } from "@openclaude/protocol";
import { projectLockedModels, projectPublicModels } from "../../billing/modelPublicProjection.js";
import {
  CatalogUnknownError,
  type ModelCatalogSnapshot,
  type UserModelScope,
} from "../../billing/modelCatalog.js";
import type { PublicModel } from "../../billing/pricing.js";
import { getDegradedProviders } from "../../admin/providerHealthGate.js";
import { verifyCommercialJwtSync, type CommercialJwtClaims } from "../../auth/jwtSync.js";
import { rootLogger } from "../../logging/logger.js";
import { getSessionCookieToken } from "../authHelpers.js";
import { HttpError, sendJson } from "../util.js";
import type { CommercialHttpDeps } from "./shared.js";

/** 匿名 /api/public/models 的展示面 fence 微缓存窗口(方案 §1.2:安全/计费面禁缓存,展示面许)。 */
const PUBLIC_MODELS_FENCE_TTL_MS = 2_000;

function extractOptionalPublicModelClaims(
  req: IncomingMessage,
  jwtSecret: string | Uint8Array,
): CommercialJwtClaims | null {
  const authHeader = req.headers.authorization;
  const token = typeof authHeader === "string" ? authHeader.replace(/^Bearer\s+/i, "").trim() : "";
  const bearerClaims = token ? verifyCommercialJwtSync(token, jwtSecret) : null;
  if (bearerClaims) return bearerClaims;
  const cookieToken = getSessionCookieToken(req);
  if (cookieToken && cookieToken !== token) {
    return verifyCommercialJwtSync(cookieToken, jwtSecret);
  }
  return null;
}

function anonymousModelScope(): UserModelScope {
  return {
    uid: 0,
    role: "user",
    grantedModelIds: new Set<string>(),
    userPlanTier: null,
    orgPlanCode: null,
  };
}

async function loadPublicModelScope(
  deps: CommercialHttpDeps,
  claims: CommercialJwtClaims,
  requiredEpoch?: bigint,
): Promise<UserModelScope> {
  if (deps.loadUserModelAuthz) {
    const authz = await deps.loadUserModelAuthz(BigInt(claims.sub), requiredEpoch);
    return {
      uid: claims.sub,
      role: authz.role,
      grantedModelIds: authz.grantedModelIds,
      deniedModelIds: authz.deniedModelIds,
      userPlanTier: authz.userPlanTier ?? null,
      orgPlanCode: authz.orgPlanCode ?? null,
    };
  }
  const { listGrantsForUser } = await import("../../admin/modelGrants.js");
  const grants = await listGrantsForUser(claims.sub);
  return {
    uid: claims.sub,
    role: claims.role,
    grantedModelIds: new Set(grants.map((g) => g.model_id)),
    userPlanTier: null,
    orgPlanCode: null,
  };
}

function annotateDegraded(models: PublicModel[], degraded: ReadonlySet<string>): PublicModel[] {
  if (degraded.size === 0) return models;
  return models.map((m) => {
    const pid = findRouteProviderForModel(m.id)?.id;
    return pid && degraded.has(pid) ? { ...m, degraded: true } : m;
  });
}

async function loadFreshCatalogSnapshot(deps: CommercialHttpDeps): Promise<ModelCatalogSnapshot> {
  try {
    return deps.modelCatalog!.assertFreshCached
      ? await deps.modelCatalog!.assertFreshCached(PUBLIC_MODELS_FENCE_TTL_MS)
      : await deps.modelCatalog!.assertFresh();
  } catch (err) {
    const unknown = err instanceof CatalogUnknownError;
    rootLogger.child({ subsys: "publicModels" }).error("catalog_unavailable", {
      unknown,
      err: (err as Error)?.message ?? String(err),
    });
    throw new HttpError(503, "MODEL_CATALOG_UNAVAILABLE", "model catalog unavailable");
  }
}

export async function serveListPublicModels(
  req: IncomingMessage,
  res: ServerResponse,
  deps: CommercialHttpDeps,
  resolveAuthorizedTeamLeaderModel: (isAuthorized: (model: string) => boolean) => string | null,
): Promise<void> {
  if (!deps.pricing && !deps.modelCatalog) {
    throw new HttpError(503, "PRICING_NOT_READY", "pricing cache not initialized");
  }
  const claims = extractOptionalPublicModelClaims(req, deps.jwtSecret);
  const degraded = await getDegradedProviders();

  if (deps.modelCatalog) {
    const snapshot = await loadFreshCatalogSnapshot(deps);
    const effective = claims
      ? await loadPublicModelScope(deps, claims, snapshot.securityEpoch)
      : anonymousModelScope();
    const teamLeaderModel = resolveAuthorizedTeamLeaderModel(
      (m) =>
        Boolean(snapshot.billingPricingFor(m)?.enabled) &&
        snapshot.canUseModel(effective, snapshot.aliasToCanonical(m)),
    );
    sendJson(res, 200, {
      models: projectPublicModels(snapshot, effective, degraded),
      locked_models: projectLockedModels(snapshot, effective),
      team_leader_model: teamLeaderModel,
    });
    return;
  }

  const pricing = deps.pricing!;
  const scope = claims ? await loadPublicModelScope(deps, claims) : null;
  const models = scope ? pricing.listForUser(scope) : pricing.listPublic();
  const visibleIds = new Set(models.map((m) => m.id));
  const teamLeaderModel = resolveAuthorizedTeamLeaderModel((m) => visibleIds.has(m));
  sendJson(res, 200, {
    models: annotateDegraded(models, degraded),
    team_leader_model: teamLeaderModel,
  });
}
