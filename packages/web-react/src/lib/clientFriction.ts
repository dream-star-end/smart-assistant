export type ClientFrictionSignal = {
  eventId?: string;
  surface: string;
  stage: string;
  code: string;
  outcome?: "pending" | "failed" | "recovered" | "succeeded" | "abandoned" | "cancelled";
  attempts?: number;
  latencyMs?: number;
  traceId?: string;
  sessionId?: string;
  model?: string;
  provider?: string;
  errorName?: ClientRuntimeErrorName;
  errorFingerprint?: string;
};

export type ClientRuntimeErrorName =
  | "error"
  | "type_error"
  | "range_error"
  | "reference_error"
  | "syntax_error"
  | "uri_error"
  | "eval_error"
  | "aggregate_error"
  | "dom_exception"
  | "non_error";

type ClientFrictionTokenProvider = () => string | null | undefined;
let clientFrictionTokenProvider: ClientFrictionTokenProvider | null = null;

/**
 * Bind the in-memory AuthSession without copying its token. The owner-scoped
 * cleanup prevents an older StrictMode effect from clearing a newer binding.
 */
export function bindClientFrictionTokenProvider(provider: ClientFrictionTokenProvider): () => void {
  clientFrictionTokenProvider = provider;
  return () => {
    if (clientFrictionTokenProvider === provider) clientFrictionTokenProvider = null;
  };
}

function buildId(): string {
  try { return crypto.randomUUID().replace(/-/g, ""); } catch { return `${Date.now()}_${Math.random().toString(36).slice(2)}`; }
}

function clientBuild(): string | undefined {
  return document.querySelector<HTMLMetaElement>('meta[name="oc-build"]')?.content || undefined;
}

function browserFamily(): string {
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return "edge";
  if (/Firefox\//.test(ua)) return "firefox";
  if (/CriOS\//.test(ua)) return "chrome_ios";
  if (/Chrome\//.test(ua)) return "chrome";
  if (/Safari\//.test(ua)) return "safari";
  return "other";
}

function deviceClass(): "desktop" | "mobile" | "tablet" | "unknown" {
  if (typeof matchMedia !== "function") return "unknown";
  if (matchMedia("(max-width: 640px)").matches) return "mobile";
  if (matchMedia("(max-width: 1024px)").matches) return "tablet";
  return "desktop";
}

export function reportClientFriction(signal: ClientFrictionSignal, token?: string | null): string {
  const eventId = signal.eventId ?? buildId();
  const headers: Record<string, string> = { "content-type": "application/json" };
  const authToken = token === undefined ? clientFrictionTokenProvider?.() : token;
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  void fetch("/api/client-errors", {
    method: "POST",
    credentials: "include",
    headers,
    body: JSON.stringify({
      event_id: eventId,
      surface: signal.surface,
      stage: signal.stage,
      code: signal.code,
      outcome: signal.outcome ?? "failed",
      attempts: signal.attempts,
      latency_ms: signal.latencyMs,
      trace_id: signal.traceId,
      session_id: signal.sessionId,
      model: signal.model,
      provider: signal.provider,
      error_name: signal.errorName,
      error_fingerprint: signal.errorFingerprint,
      client_build: clientBuild(),
      browser_family: browserFamily(),
      device_class: deviceClass(),
    }),
  }).catch(() => {});
  return eventId;
}

let globalHandlersInstalled = false;
const globallyReportedClasses = new Set<"JS_ERROR" | "UNHANDLED_REJECTION">();
// There are intentionally only two content-free global classes. Reserving the
// class before POST gives both a stable per-page dedupe key and a hard page
// cap, even when a rejected report itself triggers another runtime error.
const GLOBAL_REPORT_CAP = 2;

const ERROR_NAMES: Readonly<Record<string, ClientRuntimeErrorName>> = {
  Error: "error",
  TypeError: "type_error",
  RangeError: "range_error",
  ReferenceError: "reference_error",
  SyntaxError: "syntax_error",
  URIError: "uri_error",
  EvalError: "eval_error",
  AggregateError: "aggregate_error",
};

export type ClientRuntimeErrorDescriptor = {
  errorName: ClientRuntimeErrorName;
  normalizedMessage: string;
  frameBasename: string;
};

function boundedText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function errorName(value: unknown): ClientRuntimeErrorName {
  if (typeof DOMException !== "undefined" && value instanceof DOMException) return "dom_exception";
  if (!(value instanceof Error)) return "non_error";
  const name = boundedText((value as { name?: unknown }).name);
  if (ERROR_NAMES[name]) return ERROR_NAMES[name];
  return "error";
}

function normalizeErrorMessage(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "<email>")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "<url>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<id>")
    .replace(/\b[A-Za-z0-9+/_=-]{24,}\b/g, "<id>")
    .replace(/(["'`])(?:\\.|(?!\1)[\s\S])*\1/g, "<quoted>")
    .replace(/\b\d+(?:\.\d+)?\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(normalized).slice(0, 160).join("");
}

function stableFrameBasename(stack: string, filename: string): string {
  const candidates = [...stack.split("\n"), filename];
  for (const line of candidates) {
    const match = line.match(
      /(?:https?:\/\/[^\s)@]+|file:\/\/\/[^\s)@]+|\/[^\s)@]+|[A-Za-z0-9._-]+\.m?js)(?::\d+){0,2}/,
    );
    if (!match) continue;
    const withoutPosition = match[0].replace(/:\d+(?::\d+)?$/, "");
    let path = withoutPosition.replace(/[?#].*$/, "");
    try {
      path = new URL(path).pathname;
    } catch {
      // Relative and absolute filesystem paths are already usable below.
    }
    const basename = path.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
    if (!/\.m?js$/i.test(basename)) continue;
    return basename.replace(/-[A-Za-z0-9_-]{8,}(?=\.m?js$)/, "");
  }
  return "";
}

export function describeClientRuntimeError(
  code: "JS_ERROR" | "UNHANDLED_REJECTION",
  event: Event,
): ClientRuntimeErrorDescriptor {
  const record = event as Event & {
    error?: unknown;
    reason?: unknown;
    message?: unknown;
    filename?: unknown;
  };
  const value = code === "JS_ERROR" ? record.error : record.reason;
  const name = value == null && code === "JS_ERROR" ? "error" : errorName(value);
  if (name === "non_error") {
    const kind = value === null ? "null" : typeof value;
    return {
      errorName: name,
      normalizedMessage: `${kind}_rejection`,
      frameBasename: "",
    };
  }
  const message = boundedText((value as { message?: unknown } | null)?.message)
    || boundedText(record.message);
  const stack = boundedText((value as { stack?: unknown } | null)?.stack);
  return {
    errorName: name,
    normalizedMessage: normalizeErrorMessage(message),
    frameBasename: stableFrameBasename(stack, boundedText(record.filename)),
  };
}

export async function fingerprintClientRuntimeError(
  descriptor: ClientRuntimeErrorDescriptor,
): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  try {
    const input = [
      "oc-js-error-v1",
      descriptor.errorName,
      descriptor.normalizedMessage,
      descriptor.frameBasename,
    ].join("\0");
    const digest = await subtle.digest("SHA-256", new TextEncoder().encode(input));
    return Array.from(new Uint8Array(digest))
      .slice(0, 8)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return null;
  }
}

function reportGlobalClass(code: "JS_ERROR" | "UNHANDLED_REJECTION", event: Event): void {
  if (globallyReportedClasses.has(code) || globallyReportedClasses.size >= GLOBAL_REPORT_CAP) return;
  globallyReportedClasses.add(code);
  // Freeze both privacy-reduced inputs and identity before the async digest.
  // A later logout/login must not attribute this error to the next user.
  const descriptor = describeClientRuntimeError(code, event);
  const token = clientFrictionTokenProvider?.() || null;
  const eventId = buildId();
  void fingerprintClientRuntimeError(descriptor).then((fingerprint) => {
    reportClientFriction({
      eventId,
      surface: "client",
      stage: "runtime",
      code,
      errorName: descriptor.errorName,
      errorFingerprint: fingerprint ?? undefined,
    }, token);
  });
}

export function installGlobalClientFrictionHandlers(): void {
  if (globalHandlersInstalled) return;
  globalHandlersInstalled = true;
  window.addEventListener("error", (event) => {
    reportGlobalClass("JS_ERROR", event);
  });
  window.addEventListener("unhandledrejection", (event) => {
    reportGlobalClass("UNHANDLED_REJECTION", event);
  });
}
