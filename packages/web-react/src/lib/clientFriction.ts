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
};

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
  if (token) headers.Authorization = `Bearer ${token}`;
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
      entity_slug: signal.entitySlug,
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

function reportGlobalClass(code: "JS_ERROR" | "UNHANDLED_REJECTION"): void {
  if (globallyReportedClasses.has(code) || globallyReportedClasses.size >= GLOBAL_REPORT_CAP) return;
  globallyReportedClasses.add(code);
  reportClientFriction({ surface: "client", stage: "runtime", code });
}

export function installGlobalClientFrictionHandlers(): void {
  if (globalHandlersInstalled) return;
  globalHandlersInstalled = true;
  window.addEventListener("error", () => {
    reportGlobalClass("JS_ERROR");
  });
  window.addEventListener("unhandledrejection", () => {
    reportGlobalClass("UNHANDLED_REJECTION");
  });
}
