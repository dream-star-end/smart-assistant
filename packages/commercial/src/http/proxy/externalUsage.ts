/**
 * `GET /api/anthropic/v1/usage` — balance / per-key spend for the external
 * API-key surface, shaped so CC Switch's「用量查询」JS-script path can consume it
 * with a two-line extractor (and any other Anthropic-compatible desktop tool can
 * read the same numbers).
 *
 * Why a dedicated endpoint instead of pointing CC Switch at
 * `GET /api/me/api-keys/usage`:
 *   - that route is JWT-only (browser session), CC Switch only holds the API key;
 *   - the report there is a 30-day analytics table; the desktop footer wants
 *     three numbers — how much is left, how much this key has spent, is it
 *     still usable — in one small JSON object.
 *
 * Auth: the same `resolveApiKeyIdentity` chain as `/v1/models` (format /
 * revoked / disabled / admin gate), **no User-Agent gate** — CC Switch's
 * usage-script runner is a plain reqwest client. Read-only, no upstream call,
 * moves no credits, does not bump last_used_at.
 *
 * Response (all money fields are **integer credits**; the desktop shows them
 * with unit "积分"):
 *   {
 *     object: "usage",
 *     unit: "credits",
 *     balance: { spendable: "<credits>" },      // personal wallet + org spendable
 *     key: {
 *       id, label, key_prefix,
 *       spent_credits, credit_limit | null, remaining_limit | null,
 *       is_valid: boolean                         // spendable > 0 && (no limit || under limit)
 *     },
 *     window: { range: "30d", requests, credits, input_tokens, output_tokens }
 *   }
 * Big integers are serialised as strings (same convention as every other
 * billing surface in this package); `window` numbers are small enough that the
 * extractor can `Number()` them safely.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "../../logging/logger.js";
import { IdentityError, type ProxyIdentity } from "../../auth/proxyIdentity.js";
import type { ApiKeyRepo } from "../../auth/apiKeyRepo.js";
import { readTotalSpendableBalance } from "../../billing/preCheck.js";
import { getApiKeyUsageReport } from "../../billing/apiKeyUsageReport.js";
import { ensureRequestId, REQUEST_ID_HEADER } from "../util.js";
import { sendJsonError } from "./shared.js";

export interface ExternalUsageHandlerDeps {
  /** Shared with `/v1/models` so "which key works" never diverges. */
  resolveIdentity: (req: IncomingMessage) => Promise<ProxyIdentity>;
  /** `list()` is used to fetch label / prefix for the resolved key id. */
  repo: Pick<ApiKeyRepo, "list">;
  /** Personal + org spendable credits (default: billing/preCheck). */
  readBalance?: (uid: bigint) => Promise<bigint>;
  /** 30-day per-key aggregate (default: billing/apiKeyUsageReport). */
  readWindow?: (uid: string, keyId: string) => Promise<ExternalUsageWindow>;
  logger?: Logger;
}

export interface ExternalUsageWindow {
  requests: string;
  credits: string;
  input_tokens: string;
  output_tokens: string;
}

export interface ExternalUsageResponse {
  object: "usage";
  unit: "credits";
  balance: { spendable: string };
  key: {
    id: string;
    label: string | null;
    key_prefix: string | null;
    spent_credits: string;
    credit_limit: string | null;
    remaining_limit: string | null;
    is_valid: boolean;
  };
  window: { range: "30d" } & ExternalUsageWindow;
}

export type ExternalUsageHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/**
 * Pure projection (exported for unit tests). `spendable` is the wallet; the key
 * snapshot comes straight from the identity resolve (so it is never stale versus
 * what the messages endpoint would enforce on the very next request).
 */
export function projectExternalUsage(input: {
  spendable: bigint;
  key: { id: bigint; creditLimit: bigint | null; spentCredits: bigint };
  meta: { label: string; keyPrefix: string } | null;
  window: ExternalUsageWindow;
}): ExternalUsageResponse {
  const { spendable, key, meta, window } = input;
  const remainingLimit =
    key.creditLimit === null ? null : key.creditLimit - key.spentCredits > 0n ? key.creditLimit - key.spentCredits : 0n;
  const isValid = spendable > 0n && (remainingLimit === null || remainingLimit > 0n);
  return {
    object: "usage",
    unit: "credits",
    balance: { spendable: spendable.toString() },
    key: {
      id: key.id.toString(),
      label: meta?.label ?? null,
      key_prefix: meta ? `oc-cc.${meta.keyPrefix}` : null,
      spent_credits: key.spentCredits.toString(),
      credit_limit: key.creditLimit === null ? null : key.creditLimit.toString(),
      remaining_limit: remainingLimit === null ? null : remainingLimit.toString(),
      is_valid: isValid,
    },
    window: { range: "30d", ...window },
  };
}

const EMPTY_WINDOW: ExternalUsageWindow = { requests: "0", credits: "0", input_tokens: "0", output_tokens: "0" };

async function defaultReadWindow(uid: string, keyId: string): Promise<ExternalUsageWindow> {
  const report = await getApiKeyUsageReport(uid, "30d", keyId);
  const s = report.summary;
  return { requests: s.requests, credits: s.credits, input_tokens: s.input_tokens, output_tokens: s.output_tokens };
}

export function makeExternalUsageHandler(deps: ExternalUsageHandlerDeps): ExternalUsageHandler {
  const readBalance = deps.readBalance ?? ((uid: bigint) => readTotalSpendableBalance(uid));
  const readWindow = deps.readWindow ?? defaultReadWindow;
  return async (req, res) => {
    const requestId = ensureRequestId(req);
    res.setHeader(REQUEST_ID_HEADER, requestId);
    const log = deps.logger?.child({ requestId, route: "__cc_external_usage__" });

    if (req.method !== "GET") {
      sendJsonError(res, 405, "METHOD_NOT_ALLOWED", "use GET", requestId, { allow: "GET" });
      return;
    }

    let identity: ProxyIdentity;
    try {
      identity = await deps.resolveIdentity(req);
    } catch (err) {
      if (err instanceof IdentityError) {
        log?.warn("external_usage_identity_failed", { errcode: err.code, detail: err.message });
        sendJsonError(res, 401, "UNAUTHORIZED", "container identity verification failed", requestId);
        return;
      }
      throw err;
    }
    const key = identity.apiKey;
    if (!key) {
      // Only the API-key strategy produces this identity; a container identity
      // reaching here is a wiring bug, not a client error.
      log?.error("external_usage_no_api_key_identity", { uid: identity.uid.toString() });
      sendJsonError(res, 503, "EXTERNAL_PROXY_UNAVAILABLE", "external api key endpoint not available", requestId);
      return;
    }

    const uid = identity.uid;
    const [spendable, keys, window] = await Promise.all([
      readBalance(uid),
      deps.repo.list(uid),
      readWindow(uid.toString(), key.id.toString()).catch((err) => {
        // Analytics failing must not hide the balance — degrade to zeros.
        log?.warn("external_usage_window_failed", { err: err instanceof Error ? err.message : String(err) });
        return EMPTY_WINDOW;
      }),
    ]);
    const meta = keys.find((k) => k.id === key.id) ?? null;
    const body = projectExternalUsage({
      spendable,
      key,
      meta: meta ? { label: meta.label, keyPrefix: meta.keyPrefix } : null,
      window,
    });
    log?.info("external_usage_listed", { uid: uid.toString(), apiKeyId: key.id.toString(), isValid: body.key.is_valid });
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify(body));
  };
}
