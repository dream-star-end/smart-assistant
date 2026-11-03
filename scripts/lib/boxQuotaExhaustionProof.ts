/** Called by the existing Box refusal release proof. No model/Box endpoint,
 * credentials, side-effect tool or automatic recovery job is launched. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function proveQuotaExhaustion(candidate: string, upstreamModel: string): Promise<void> {
  const source = (path: string) => import(pathToFileURL(join(candidate, path)).href);
  const [decoder, core, gateway, protocol] = await Promise.all([
    source("packages/commercial/src/http/proxy/boxCliSse.ts"),
    source("packages/commercial/src/http/proxy/core.ts"),
    source("packages/gateway/src/errorClassify.ts"),
    source("packages/protocol/src/turnErrorTaxonomy.ts"),
  ]);
  const raw = readFileSync(join(candidate,
    "packages/commercial/src/http/proxy/__fixtures__/box-cli-upstream-refusal/real-session-limit.jsonl"), "utf8");
  const sessionId = JSON.parse(raw.trim().split("\n")[0]!).session_id;
  // This trusted expected-session input represents the launch/claim binding;
  // the quota event alone must never grant it to an unbound decoder.
  const codeOf = (bound: boolean): string => {
    try { decoder.createBoxCliSseDecoder(upstreamModel, bound ? sessionId : undefined).push(raw); }
    catch (error) { return String((error as { code?: unknown }).code ?? ""); }
    return "";
  };
  if (codeOf(true) !== "BOX_CLI_QUOTA_EXHAUSTED"
    || codeOf(false) !== "BOX_CLI_UPSTREAM_RATE_LIMITED") {
    throw new Error("[quota-proof] SUBSCRIPTION_WINDOW_BINDING");
  }
  let status = 0, body = "", headers: Record<string, string> = {};
  core.sendBoxUpstreamRefusal({ headersSent: false,
    writeHead: (value: number, fields: Record<string, string>) => { status = value; headers = fields; },
    end: (value: string) => { body = value; },
  }, codeOf(true), "offline-quota-proof");
  const typed = gateway.classifyRunError(JSON.stringify({ type: "result", subtype: "success",
    is_error: true, result: `API Error: ${status} ${body}` })).code;
  if (status !== 503 || headers["x-should-retry"] !== "false" || headers["retry-after"] !== undefined
    || typed !== "quota_exhausted" || protocol.supportsAutomaticTurnRecovery(typed)
    || !protocol.supportsManualTurnRecovery(typed)) {
    throw new Error("[quota-proof] AUTOMATIC_RETRY_OR_MANUAL_POLICY");
  }
  // Short/unspecified rate limits keep the existing retry policy.
  if (!protocol.supportsAutomaticTurnRecovery(gateway.classifyRunError("429 Too Many Requests").code)) {
    throw new Error("[quota-proof] GENERIC_RATE_LIMIT_POLICY_CHANGED");
  }
}
