export type ClientFrictionPresentation =
  | "red"
  | "yellow"
  | "soft"
  | "banner"
  | "placeholder";

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
  /** 稳定事件键；problem_card 必须传 `${sessionId}:${rootCmid}`，禁止依赖默认 event_id。 */
  correlation?: string;
  presentation?: ClientFrictionPresentation;
  path?: string;
  reason?: string;
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
const SCRIPT_FILE_EXT = /\.(?:[cm]?js|jsx|tsx?|wasm)$/i;
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,96}$/;
const SPA_ROUTE_PREFIX = /^\/(?:s|p|sites|board|studio|reset-password|desktop)(?:\/|$)/;
const NON_SCRIPT_SCHEME = /^(?:data|blob|about|javascript|chrome-extension|safari-extension|safari-web-extension|moz-extension):/i;
const SAFE_COMPONENT_NAME = /^[A-Za-z_$][A-Za-z0-9_$.-]{0,63}$/;
const SAFE_FRICTION_PATH = /^[a-z0-9_]{1,32}$/;
const SAFE_FRICTION_REASON = /^[a-z0-9_]{1,48}$/;
const SAFE_FRICTION_CORRELATION = /^[A-Za-z0-9_:-]{1,225}$/;
const MAX_LINE_COL = 10_000_000;
const FRICTION_PRESENTATIONS = new Set<ClientFrictionPresentation>([
  "red",
  "yellow",
  "soft",
  "banner",
  "placeholder",
]);

const KNOWN_ERROR_CLASS_RE =
  /^(?:Uncaught\s+)?(TypeError|ReferenceError|RangeError|SyntaxError|URIError|EvalError|AggregateError|DOMException|SecurityError|QuotaExceededError|AbortError|NotAllowedError|NetworkError|ChunkLoadError)\b/;

const BOUNDED_ERROR_REASON_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Maximum update depth exceeded/i, "react_error_185"],
  [/ResizeObserver loop/i, "resize_observer_loop"],
  [/^Script error\.?$/i, "cross_origin_script_error"],
  [
    /Loading chunk|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i,
    "chunk_load_failed",
  ],
  [/QuotaExceeded|exceeded the quota|Storage quota/i, "quota_exceeded"],
  [/Maximum call stack size exceeded|too much recursion/i, "max_call_stack"],
  [/Cannot read propert(?:y|ies) of null|null is not an object/i, "null_dereference"],
  [/Cannot read propert(?:y|ies) of undefined|undefined is not an object/i, "undefined_dereference"],
  [/is not a function/i, "not_a_function"],
  [/is not iterable/i, "not_iterable"],
  [/Load failed|Failed to fetch|NetworkError/i, "network_load_failed"],
  [/Unexpected token.*JSON|JSON\.parse|is not valid JSON/i, "invalid_json"],
];

const STACK_FRAME_RE =
  /(?:@|\(|\s|^)((?:https?:\/\/|\/)?[^\s()@]+?\.(?:[cm]?js|jsx|tsx?|wasm)(?:[?#][^\s()@]*)?):(\d+)(?::(\d+))?(?:\)|$|\s)/i;

function boundedFrictionPath(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_FRICTION_PATH.test(value) ? value : undefined;
}

function boundedFrictionReason(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_FRICTION_REASON.test(value) ? value : undefined;
}

function boundedFrictionCorrelation(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_FRICTION_CORRELATION.test(value) ? value : undefined;
}

function boundedFrictionPresentation(value: unknown): ClientFrictionPresentation | undefined {
  return typeof value === "string" && FRICTION_PRESENTATIONS.has(value as ClientFrictionPresentation)
    ? (value as ClientFrictionPresentation)
    : undefined;
}

function boundedPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const n = Math.trunc(value);
  return n > 0 && n <= MAX_LINE_COL ? n : undefined;
}

/** 从 SPA 路由 `/s/<id>` 提取会话 ID（先剥离 query/hash，防隐私参数泄漏）。 */
export function sessionIdFromPathname(pathname: unknown): string | undefined {
  if (typeof pathname !== "string" || pathname.length === 0) return undefined;
  const clean = pathname.split(/[?#]/, 1)[0] ?? "";
  const match = /^\/s\/([A-Za-z0-9_-]{1,96})\/?$/.exec(clean);
  if (!match) return undefined;
  return SAFE_SESSION_ID.test(match[1]!) ? match[1] : undefined;
}

function extractUrlPathname(withoutQuery: string): string | null {
  if (withoutQuery.startsWith("/")) return withoutQuery;
  if (/^https?:\/\//i.test(withoutQuery)) {
    try {
      return new URL(withoutQuery).pathname;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 取真实脚本 URL 的文件基名(去 query/hash);拒绝文档 URL、SPA 路由段(`/s/<id>` 等)
 * 及非脚本扩展名,防止 Safari/mobile 文档 URL 污染 `script_ref` 与指纹。
 */
export function scriptRefFromSource(source: unknown, docHref?: unknown): string | undefined {
  if (typeof source !== "string" || source.length === 0) return undefined;
  const withoutQuery = source.split(/[?#]/, 1)[0] ?? "";
  if (withoutQuery.length === 0 || NON_SCRIPT_SCHEME.test(withoutQuery)) return undefined;

  const resolvedDocHref =
    typeof docHref === "string"
      ? docHref
      : typeof location !== "undefined"
        ? location.href
        : undefined;
  if (resolvedDocHref) {
    const docWithoutQuery = resolvedDocHref.split(/[?#]/, 1)[0] ?? "";
    if (docWithoutQuery && withoutQuery === docWithoutQuery) return undefined;
  }
  if (typeof location !== "undefined" && location.pathname && withoutQuery === location.pathname) {
    return undefined;
  }

  const pathname = extractUrlPathname(withoutQuery);
  if (pathname !== null && SPA_ROUTE_PREFIX.test(pathname)) return undefined;

  const base = withoutQuery.split("/").pop() ?? "";
  if (!SAFE_SCRIPT_REF.test(base) || !SCRIPT_FILE_EXT.test(base)) return undefined;
  return base;
}

function boundedErrorName(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_ERROR_NAME.test(value) ? value : undefined;
}

function boundedErrorNameFromMessage(message: unknown): string | undefined {
  if (typeof message !== "string" || message.length === 0) return undefined;
  const match = KNOWN_ERROR_CLASS_RE.exec(message.trim());
  return match ? match[1] : undefined;
}

/** 从错误消息映射到封闭白名单蛇形分类码；绝不透出任何原始错误文本。 */
export function boundedErrorReasonFromMessage(message: unknown): string | undefined {
  if (typeof message !== "string" || message.length === 0) return undefined;
  const reactMinified = /Minified React error #(\d{1,4})\b/.exec(message);
  if (reactMinified) return `react_error_${reactMinified[1]}`;
  for (const [pattern, reason] of BOUNDED_ERROR_REASON_PATTERNS) {
    if (pattern.test(message)) return reason;
  }
  return undefined;
}

export type BoundedStackFrame = {
  scriptRef: string;
  lineNo?: number;
  colNo?: number;
};

/** 从 V8 / Safari / Firefox stack 文本提取首条真实脚本帧（仅返回有界文件名+行列）。 */
export function parseTopStackFrame(stack: unknown, docHref?: unknown): BoundedStackFrame | undefined {
  if (typeof stack !== "string" || stack.length === 0) return undefined;
  const lines = stack.split("\n", 16);
  for (const line of lines) {
    const match = STACK_FRAME_RE.exec(line);
    if (!match) continue;
    const scriptRef = scriptRefFromSource(match[1], docHref);
    if (!scriptRef) continue;
    const lineNo = boundedPositiveInt(Number(match[2]));
    const colNo = match[3] ? boundedPositiveInt(Number(match[3])) : undefined;
    return { scriptRef, lineNo, colNo };
  }
  return undefined;
}

function componentNameToPath(name: string): string | undefined {
  const snake = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()
    .slice(0, 32)
    .replace(/_+$/g, "");
  return boundedFrictionPath(snake);
}

/** 从 React ErrorInfo.componentStack 提取有界顶层组件名与脚本帧（绝不输出原始栈文本）。 */
export function parseComponentStackSummary(
  componentStack: unknown,
  docHref?: unknown,
): {
  topComponentPath?: string;
  componentChain?: string;
  scriptFrame?: BoundedStackFrame;
} {
  if (typeof componentStack !== "string" || componentStack.length === 0) return {};
  const lines = componentStack.split("\n", 20);
  const components: string[] = [];
  let scriptFrame: BoundedStackFrame | undefined;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!scriptFrame) {
      const frameMatch = STACK_FRAME_RE.exec(line);
      if (frameMatch) {
        const scriptRef = scriptRefFromSource(frameMatch[1], docHref);
        if (scriptRef) {
          scriptFrame = {
            scriptRef,
            lineNo: boundedPositiveInt(Number(frameMatch[2])),
            colNo: frameMatch[3] ? boundedPositiveInt(Number(frameMatch[3])) : undefined,
          };
        }
      }
    }
    const compMatch = /^(?:at\s+)?([A-Za-z_$][A-Za-z0-9_$.-]{0,63})(?:\s*\(|@|\s|$)/.exec(line);
    const candidate = compMatch?.[1];
    if (!candidate || !SAFE_COMPONENT_NAME.test(candidate)) continue;
    // Skip intrinsic lowercase DOM tags (div/span/etc.) so React components lead the frame.
    if (/^[a-z][a-z0-9-]*$/.test(candidate)) continue;
    if (components.length < 3 && !components.includes(candidate)) {
      components.push(candidate);
    }
  }
  const preferred =
    components.find((name) => name !== "SessionTimelineBoundary") ?? components[0];
  return {
    topComponentPath: preferred ? componentNameToPath(preferred) : undefined,
    componentChain: components.length > 0 ? components.join(">") : undefined,
    scriptFrame,
  };
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
    correlation: boundedFrictionCorrelation(signal.correlation),
    presentation: boundedFrictionPresentation(signal.presentation),
    path: boundedFrictionPath(signal.path),
    reason: boundedFrictionReason(signal.reason),
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

const onceKeys = new Set<string>();

/** Dedupe conversion-funnel exposures across StrictMode double-mount. */
export function reportClientFrictionOnce(
  key: string,
  signal: ClientFrictionSignal,
  token?: string | null,
): string | null {
  if (!key || onceKeys.has(key)) return null;
  onceKeys.add(key);
  return reportClientFriction(signal, token);
}

export function resetClientFrictionOnceForTests(): void {
  onceKeys.clear();
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

export type BoundedErrorLocation = Pick<
  ClientFrictionSignal,
  "errorName" | "scriptRef" | "lineNo" | "colNo" | "reason"
>;

export type BoundedRenderErrorLocation = Pick<
  ClientFrictionSignal,
  "errorName" | "scriptRef" | "lineNo" | "colNo" | "path" | "reason" | "errorFingerprint"
>;

function currentPathnameSessionId(): string | undefined {
  return typeof location !== "undefined" ? sessionIdFromPathname(location.pathname) : undefined;
}

function reportGlobalClass(
  code: "JS_ERROR" | "UNHANDLED_REJECTION",
  location?: BoundedErrorLocation,
): void {
  if (globallyReportedClasses.has(code) || globallyReportedClasses.size >= GLOBAL_REPORT_CAP) return;
  globallyReportedClasses.add(code);
  const sessionId = currentPathnameSessionId();
  const hasLocation = Boolean(
    location &&
      (location.errorName ||
        location.scriptRef ||
        location.lineNo != null ||
        location.colNo != null),
  );
  reportClientFriction({
    surface: "client",
    stage: "runtime",
    code,
    ...(sessionId ? { sessionId } : {}),
    ...(location?.reason ? { reason: location.reason } : {}),
    ...(hasLocation && location
      ? {
          errorName: location.errorName,
          scriptRef: location.scriptRef,
          lineNo: location.lineNo,
          colNo: location.colNo,
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
  event: Partial<Pick<ErrorEvent, "filename" | "lineno" | "colno" | "message">> & {
    error?: unknown;
  },
  docHref?: unknown,
): BoundedErrorLocation {
  const errCandidate =
    event.error && typeof event.error === "object"
      ? (event.error as {
          name?: unknown;
          message?: unknown;
          stack?: unknown;
          sourceURL?: unknown;
          line?: unknown;
          column?: unknown;
        })
      : undefined;
  const rawMessage =
    typeof event.message === "string" && event.message.length > 0
      ? event.message
      : typeof errCandidate?.message === "string"
        ? errCandidate.message
        : undefined;

  const errorName =
    boundedErrorName(errCandidate?.name) ??
    boundedErrorNameFromMessage(rawMessage) ??
    (event.error != null ? "Error" : undefined);

  const primaryScriptRef = scriptRefFromSource(event.filename, docHref);
  let scriptRef = primaryScriptRef;
  let lineNo = primaryScriptRef ? boundedPositiveInt(event.lineno) : undefined;
  let colNo = primaryScriptRef ? boundedPositiveInt(event.colno) : undefined;

  if (!scriptRef || lineNo == null) {
    const stackFrame = parseTopStackFrame(errCandidate?.stack, docHref);
    if (stackFrame) {
      if (!scriptRef) {
        scriptRef = stackFrame.scriptRef;
        lineNo = stackFrame.lineNo;
        colNo = stackFrame.colNo;
      } else if (stackFrame.scriptRef === scriptRef) {
        lineNo = lineNo ?? stackFrame.lineNo;
        colNo = colNo ?? stackFrame.colNo;
      }
    }
  }

  if (!scriptRef && errCandidate?.sourceURL !== undefined) {
    const safariScriptRef = scriptRefFromSource(errCandidate.sourceURL, docHref);
    if (safariScriptRef) {
      scriptRef = safariScriptRef;
      lineNo = boundedPositiveInt(errCandidate.line);
      colNo = boundedPositiveInt(errCandidate.column);
    }
  }

  const reason = boundedErrorReasonFromMessage(rawMessage);
  return {
    errorName,
    scriptRef,
    lineNo,
    colNo,
    ...(reason ? { reason } : {}),
  };
}

/**
 * 从 React ErrorBoundary 捕获的 `(error, componentStack)` 提取有界定位（OCV5-77）。
 * 严格遵守 0248/0151 红线：只产出类名、真实脚本基名、行列、顶层组件蛇形标识、封闭枚举原因
 * 与派生指纹，绝不携带自由文本/用户消息体；无真实定位字段时不制造假指纹。
 */
export function boundedRenderErrorLocation(
  error: unknown,
  componentStack?: string | null,
  docHref?: unknown,
): BoundedRenderErrorLocation {
  const errObj = error instanceof Error || (error && typeof error === "object") ? error : undefined;
  const base = boundedErrorLocation(
    {
      error: errObj,
      message: typeof error === "string" ? error : undefined,
    },
    docHref,
  );
  const comp = parseComponentStackSummary(componentStack, docHref);
  const scriptRef = base.scriptRef ?? comp.scriptFrame?.scriptRef;
  const lineNo = base.scriptRef ? base.lineNo : (base.lineNo ?? comp.scriptFrame?.lineNo);
  const colNo = base.scriptRef ? base.colNo : (base.colNo ?? comp.scriptFrame?.colNo);
  const path = comp.topComponentPath;
  const reason = base.reason;
  const hasRealLocator = Boolean(
    base.errorName || scriptRef || lineNo != null || colNo != null || path || reason,
  );
  return {
    ...(base.errorName ? { errorName: base.errorName } : {}),
    ...(scriptRef ? { scriptRef } : {}),
    ...(lineNo != null ? { lineNo } : {}),
    ...(colNo != null ? { colNo } : {}),
    ...(path ? { path } : {}),
    ...(reason ? { reason } : {}),
    ...(hasRealLocator
      ? {
          errorFingerprint: errorLocationFingerprint([
            base.errorName,
            scriptRef,
            lineNo,
            colNo,
            comp.componentChain ?? path,
            reason,
          ]),
        }
      : {}),
  };
}

export function installGlobalClientFrictionHandlers(): void {
  if (globalHandlersInstalled) return;
  globalHandlersInstalled = true;
  window.addEventListener("error", (event) => {
    reportGlobalClass("JS_ERROR", boundedErrorLocation(event));
  });
  window.addEventListener("unhandledrejection", (event) => {
    const rejectionReason = (event as { reason?: unknown }).reason;
    const err =
      rejectionReason instanceof Error ||
      (rejectionReason && typeof rejectionReason === "object")
        ? rejectionReason
        : undefined;
    reportGlobalClass(
      "UNHANDLED_REJECTION",
      boundedErrorLocation({
        error: err,
        message: typeof rejectionReason === "string" ? rejectionReason : undefined,
      }),
    );
  });
}
