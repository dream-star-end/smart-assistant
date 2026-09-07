/**
 * `GET /api/anthropic/v1/models` — model discovery for the external API-key
 * surface (local Claude Code / CC Switch / any Anthropic-compatible client).
 *
 * Why a dedicated handler instead of reusing `/api/public/models`:
 *   - auth is the API key (`oc-cc.*`), not a browser JWT;
 *   - the response must be the Anthropic **and** OpenAI compatible list shape
 *     (`{ data: [{ id, … }] }`) that desktop tools such as CC Switch parse when
 *     the user clicks「获取模型」— they only read `data[].id`;
 *   - ids are the **public** ids (`fable-5.1-high`), never the internal
 *     engine-prefixed catalog ids. This surface never names the engine.
 *
 * Scope: exactly the models this key's owner may run through the external
 * endpoint today — cursor-engine catalog rows that are enabled and pass
 * `canUseModel` (role / grants / min_plan / visibility / denials). Other
 * catalog engines are deliberately excluded: they are not routable via
 * `/api/anthropic/v1/messages` on this deployment, and listing something the
 * client cannot call is worse than a shorter list.
 *
 * No User-Agent gate here (unlike `/v1/messages`): CC Switch fetches with its
 * own HTTP client and there is nothing to protect — the endpoint is read-only,
 * makes no upstream call and moves no credits. Auth failures still collapse to
 * the same generic 401 as the messages endpoint (anti-enumeration).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  CURSOR_ENGINE_MODEL_IDS,
  publicCursorModelId,
} from "@openclaude/protocol";
import type { Logger } from "../../logging/logger.js";
import { IdentityError, type ProxyIdentity } from "../../auth/proxyIdentity.js";
import type { UserModelAuthzLoader } from "../../auth/userModelAuthz.js";
import type { PricingCache } from "../../billing/pricing.js";
import { canUseModel } from "../../billing/authzModels.js";
import { ensureRequestId, REQUEST_ID_HEADER } from "../util.js";
import { sendJsonError } from "./shared.js";

export interface ExternalModelsHandlerDeps {
  /** Shared with the messages strategy so "which key works" never diverges. */
  resolveIdentity: (req: IncomingMessage) => Promise<ProxyIdentity>;
  pricing: PricingCache;
  loadUserModelAuthz: UserModelAuthzLoader;
  /** `owned_by` value in the OpenAI-shaped rows (brand, not engine). */
  ownedBy: string;
  logger?: Logger;
}

export interface ExternalModelEntry {
  id: string;
  /** Anthropic models API discriminator. */
  type: "model";
  /** OpenAI models API discriminator (CC Switch et al. parse the OpenAI shape). */
  object: "model";
  display_name: string;
  owned_by: string;
  /** Unix seconds; the catalog has no per-model timestamp, so a stable epoch is used. */
  created: number;
  created_at: string;
}

export interface ExternalModelsResponse {
  object: "list";
  data: ExternalModelEntry[];
  has_more: false;
  first_id: string | null;
  last_id: string | null;
}

export type ExternalModelsHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/** Fixed `created` for all rows: Anthropic's shape requires one; ours has no meaning. */
const CATALOG_EPOCH_ISO = "2026-09-01T00:00:00Z";
const CATALOG_EPOCH_SECONDS = Math.floor(Date.parse(CATALOG_EPOCH_ISO) / 1000);

/**
 * Pure projection: which cursor-engine models may `uid`'s authz run, as public
 * rows. Exported for unit tests; the handler wraps it with auth + HTTP.
 */
export function projectExternalModels(
  pricing: PricingCache,
  authz: Awaited<ReturnType<UserModelAuthzLoader>>,
  ownedBy: string,
): ExternalModelEntry[] {
  const rows: { entry: ExternalModelEntry; sortOrder: number }[] = [];
  const seen = new Set<string>();
  for (const internalId of CURSOR_ENGINE_MODEL_IDS) {
    if (seen.has(internalId)) continue;
    seen.add(internalId);
    const row = pricing.get(internalId);
    if (!row || !row.enabled) continue;
    const allowed = canUseModel(
      { pricing },
      {
        role: authz.role,
        grantedModelIds: authz.grantedModelIds,
        deniedModelIds: authz.deniedModelIds,
        modelId: internalId,
        userPlanTier: authz.userPlanTier ?? null,
        orgPlanCode: authz.orgPlanCode ?? null,
      },
    );
    if (!allowed) continue;
    const id = publicCursorModelId(internalId);
    rows.push({
      sortOrder: row.sort_order,
      entry: {
        id,
        type: "model",
        object: "model",
        display_name: row.display_name,
        owned_by: ownedBy,
        created: CATALOG_EPOCH_SECONDS,
        created_at: CATALOG_EPOCH_ISO,
      },
    });
  }
  rows.sort((a, b) => a.sortOrder - b.sortOrder || a.entry.id.localeCompare(b.entry.id));
  return rows.map((r) => r.entry);
}

export function makeExternalModelsHandler(deps: ExternalModelsHandlerDeps): ExternalModelsHandler {
  return async (req, res) => {
    const requestId = ensureRequestId(req);
    res.setHeader(REQUEST_ID_HEADER, requestId);
    const log = deps.logger?.child({ requestId, route: "__cc_external_models__" });

    if (req.method !== "GET") {
      sendJsonError(res, 405, "METHOD_NOT_ALLOWED", "use GET", requestId, { allow: "GET" });
      return;
    }

    let identity: ProxyIdentity;
    try {
      identity = await deps.resolveIdentity(req);
    } catch (err) {
      if (err instanceof IdentityError) {
        log?.warn("external_models_identity_failed", { errcode: err.code });
        // Same generic text as /v1/messages so the two endpoints leak nothing
        // about *why* a key was refused (anti-enumeration).
        sendJsonError(res, 401, "UNAUTHORIZED", "container identity verification failed", requestId);
        return;
      }
      throw err;
    }

    const authz = await deps.loadUserModelAuthz(identity.uid);
    const data = projectExternalModels(deps.pricing, authz, deps.ownedBy);
    const body: ExternalModelsResponse = {
      object: "list",
      data,
      has_more: false,
      first_id: data[0]?.id ?? null,
      last_id: data[data.length - 1]?.id ?? null,
    };
    log?.info("external_models_listed", { uid: identity.uid.toString(), count: data.length });
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify(body));
  };
}
