/** The Box CLI runs with CLAUDE_CODE_MAX_RETRIES=0. When the upstream refuses a
 * call (the account's usage window is exhausted, a 4xx/5xx, a rejected input)
 * it does not stream a model message: it writes one synthetic assistant record
 * of its own (model `<synthetic>`, `error` tag, `is_api_error_message`) and an
 * error result. That text is not model output, nothing was generated, and it
 * must never be delivered or billed. Shared by the live decoders so the refusal
 * is one named code instead of an order or snapshot violation. */
export const BOX_CLI_UPSTREAM_RATE_LIMITED = "BOX_CLI_UPSTREAM_RATE_LIMITED";
export const BOX_CLI_UPSTREAM_REFUSED = "BOX_CLI_UPSTREAM_REFUSED";
export type BoxCliUpstreamRefusalCode = typeof BOX_CLI_UPSTREAM_RATE_LIMITED
  | typeof BOX_CLI_UPSTREAM_REFUSED;

const REFUSAL_CODES: ReadonlySet<string> = new Set([BOX_CLI_UPSTREAM_RATE_LIMITED,
  BOX_CLI_UPSTREAM_REFUSED]);

export function isBoxCliUpstreamRefusalCode(code: unknown): code is BoxCliUpstreamRefusalCode {
  return typeof code === "string" && REFUSAL_CODES.has(code);
}

/** The refusal code for a CLI record, or null for every other record. */
export function boxCliUpstreamRefusal(record: unknown): BoxCliUpstreamRefusalCode | null {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const item = record as { type?: unknown; error?: unknown; message?: unknown;
    is_api_error_message?: unknown };
  if (item.type !== "assistant") return null;
  const message = item.message;
  if (!message || typeof message !== "object" || Array.isArray(message)
    || (message as { model?: unknown }).model !== "<synthetic>") return null;
  // `<synthetic>` also marks the CLI's local command output; only an API error
  // message carries the error tag and flag (see the capture fixture).
  if (item.is_api_error_message !== true && typeof item.error !== "string") return null;
  return item.error === "rate_limit" ? BOX_CLI_UPSTREAM_RATE_LIMITED : BOX_CLI_UPSTREAM_REFUSED;
}
