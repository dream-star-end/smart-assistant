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
  entitySlug?: string;
  /** 0248 有界错误定位——只允许类名/bundle 基名/行列/派生指纹,绝不携带 message/stack。 */
  errorName?: string;
  scriptRef?: string;
  lineNo?: number;
  colNo?: number;
  errorFingerprint?: string;
};

const SAFE_ERROR_NAME = /^[A-Za-z0-9_.$-]{1,64}$/;
const SAFE_SCRIPT_REF = /^[A-Za-z0-9._-]{1,120}$/;

/** 取脚本 URL 的文件基名(去 query/hash);不符合有界模式时丢弃而不是截断。 */
export function scriptRefFromSource(source: unknown): string | undefined {
  if (typeof source !== "string" || source.length === 0) return undefined;
  const withoutQuery = source.split(/[?#]/, 1)[0] ?? "";
  const base = withoutQuery.split("/").pop() ?? "";
  return SAFE_SCRIPT_REF.test(base) ? base : undefined;
}

function boundedErrorName(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_ERROR_NAME.test(value) ? value : undefined;
}

/** FNV-1a 32 位,只对有界字段求值——内容无关的分组键。 */
export function errorLocationFingerprint(
  parts: ReadonlyArray<string | number | undefined>,
): string {
  let hash = 0x811c9dc5;
  const text = parts.map((part) => part ?? "").join("|");
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
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

function wireSignal(signal: ClientFrictionSignal, eventId: string): Record<string, unknown> {
  return {
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
    entity_slug: signal.entitySlug,
    client_build: clientBuild(),
    browser_family: browserFamily(),
    device_class: deviceClass(),
    error_name: signal.errorName,
    script_ref: signal.scriptRef,
    line_no: signal.lineNo,
    col_no: signal.colNo,
    error_fingerprint: signal.errorFingerprint,
  };
}

function report(body: unknown, token?: string | null): void {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  void fetch("/api/client-errors", {
    method: "POST",
    credentials: "include",
    headers,
    body: JSON.stringify(body),
  }).catch(() => {});
}

export function reportClientFriction(signal: ClientFrictionSignal, token?: string | null): string {
  const eventId = signal.eventId ?? buildId();
  report(wireSignal(signal, eventId), token);
  return eventId;
}

/** One request for a rendered marketplace page, so per-entity truth does not exhaust telemetry rate limits. */
export function reportClientFrictionBatch(
  signals: ClientFrictionSignal[],
  token?: string | null,
): string[] {
  if (signals.length === 0) return [];
  const eventIds = signals.map((signal) => signal.eventId ?? buildId());
  report({ events: signals.map((signal, index) => wireSignal(signal, eventIds[index]!)) }, token);
  return eventIds;
}

let globalHandlersInstalled = false;
const globallyReportedClasses = new Set<"JS_ERROR" | "UNHANDLED_REJECTION">();
// There are intentionally only two content-free global classes. Reserving the
// class before POST gives both a stable per-page dedupe key and a hard page
// cap, even when a rejected report itself triggers another runtime error.
const GLOBAL_REPORT_CAP = 2;

function reportGlobalClass(
  code: "JS_ERROR" | "UNHANDLED_REJECTION",
  location?: Pick<ClientFrictionSignal, "errorName" | "scriptRef" | "lineNo" | "colNo">,
): void {
  if (globallyReportedClasses.has(code) || globallyReportedClasses.size >= GLOBAL_REPORT_CAP) return;
  globallyReportedClasses.add(code);
  const hasLocation =
    location &&
    (location.errorName || location.scriptRef || location.lineNo != null || location.colNo != null);
  reportClientFriction({
    surface: "client",
    stage: "runtime",
    code,
    ...(hasLocation
      ? {
          ...location,
          errorFingerprint: errorLocationFingerprint([
            location.errorName,
            location.scriptRef,
            location.lineNo,
            location.colNo,
          ]),
        }
      : {}),
  });
}

/** 从 ErrorEvent / PromiseRejectionEvent 提取有界定位;任何自由文本都不出此函数。 */
export function boundedErrorLocation(
  event: Partial<Pick<ErrorEvent, "filename" | "lineno" | "colno">> & { error?: unknown },
): Pick<ClientFrictionSignal, "errorName" | "scriptRef" | "lineNo" | "colNo"> {
  const errCandidate = event.error as { name?: unknown } | null | undefined;
  return {
    errorName: boundedErrorName(errCandidate?.name) ?? (event.error != null ? "Error" : undefined),
    scriptRef: scriptRefFromSource(event.filename),
    lineNo: typeof event.lineno === "number" && event.lineno > 0 ? event.lineno : undefined,
    colNo: typeof event.colno === "number" && event.colno > 0 ? event.colno : undefined,
  };
}

export function installGlobalClientFrictionHandlers(): void {
  if (globalHandlersInstalled) return;
  globalHandlersInstalled = true;
  window.addEventListener("error", (event) => {
    reportGlobalClass("JS_ERROR", boundedErrorLocation(event));
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = (event as { reason?: unknown }).reason;
    const err = reason instanceof Error ? reason : undefined;
    reportGlobalClass("UNHANDLED_REJECTION", {
      errorName: err ? (boundedErrorName(err.name) ?? "Error") : undefined,
    });
  });
}
