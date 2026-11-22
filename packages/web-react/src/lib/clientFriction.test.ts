import { afterEach, describe, expect, test, vi } from "vitest";

import {
  boundedErrorLocation,
  boundedErrorReasonFromMessage,
  boundedRenderErrorLocation,
  errorLocationFingerprint,
  installGlobalClientFrictionHandlers,
  parseComponentStackSummary,
  parseTopStackFrame,
  reportClientFriction,
  reportClientFrictionBatch,
  reportClientFrictionOnce,
  resetClientFrictionOnceForTests,
  scriptRefFromSource,
  sessionIdFromPathname,
} from "./clientFriction";

afterEach(() => {
  document.querySelector('meta[name="oc-build"]')?.remove();
  window.history.replaceState({}, "", "/");
  resetClientFrictionOnceForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("client friction reporter", () => {
  test("sends bounded classifications without raw error fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 Chrome/140.0 Safari/537.36");
    const meta = document.createElement("meta");
    meta.name = "oc-build";
    meta.content = "build-abc";
    document.head.append(meta);

    const eventId = reportClientFriction({
      eventId: "event_1", surface: "auth", stage: "refresh", code: "REFRESH_RACE",
      outcome: "recovered", attempts: 2, latencyMs: 180, traceId: "trace_1",
      entitySlug: "academic-translate",
      // Prove extra fields cannot flow into the explicit wire projection.
      message: "DO_NOT_SEND", stack: "DO_NOT_SEND", url: "DO_NOT_SEND",
    } as never, "token");

    expect(eventId).toBe("event_1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.headers).toMatchObject({ Authorization: "Bearer token" });
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      event_id: "event_1", surface: "auth", stage: "refresh", code: "REFRESH_RACE",
      outcome: "recovered", attempts: 2, latency_ms: 180, trace_id: "trace_1",
      entity_slug: "academic-translate",
      client_build: "build-abc", browser_family: "chrome", device_class: "desktop",
    });
    expect(JSON.stringify(body)).not.toContain("DO_NOT_SEND");
    expect(body).not.toHaveProperty("message");
    expect(body).not.toHaveProperty("stack");
    expect(body).not.toHaveProperty("url");
    expect(body).not.toHaveProperty("user_agent");
  });

  test("global handlers install once, dedupe bursts and report at most the two stable classes", () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    installGlobalClientFrictionHandlers();
    installGlobalClientFrictionHandlers();

    const error = Object.assign(new Event("error"), {
      message: "DO_NOT_SEND runtime secret", filename: "https://private/path", error: new Error("DO_NOT_SEND"),
    });
    const rejection = Object.assign(new Event("unhandledrejection"), {
      reason: new Error("DO_NOT_SEND promise secret"),
    });
    window.dispatchEvent(error);
    window.dispatchEvent(error);
    window.dispatchEvent(error);
    window.dispatchEvent(rejection);
    window.dispatchEvent(rejection);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)));
    expect(bodies.map((b) => b.code)).toEqual(["JS_ERROR", "UNHANDLED_REJECTION"]);
    expect(JSON.stringify(bodies)).not.toContain("DO_NOT_SEND");
  });

  test("bounded error location (0246): basename/line/col/fingerprint only, never text", () => {
    expect(scriptRefFromSource("https://oc.example/assets/index-Ab3xY9.js?v=1#frag")).toBe(
      "index-Ab3xY9.js",
    );
    expect(scriptRefFromSource("")).toBeUndefined();
    expect(scriptRefFromSource("https://oc.example/assets/")).toBeUndefined();
    // 含非法字符(空格/引号)的基名整体丢弃,不截断保留
    expect(scriptRefFromSource("https://x/inline 'secret'.js")).toBeUndefined();

    const location = boundedErrorLocation({
      filename: "https://oc.example/assets/index-Ab3xY9.js",
      lineno: 120,
      colno: 7,
      error: new TypeError("DO_NOT_SEND user content"),
    });
    expect(location).toEqual({
      errorName: "TypeError",
      scriptRef: "index-Ab3xY9.js",
      lineNo: 120,
      colNo: 7,
    });
    expect(JSON.stringify(location)).not.toContain("DO_NOT_SEND");

    // 指纹只依赖有界字段,稳定可复现
    const fp = errorLocationFingerprint(["TypeError", "index-Ab3xY9.js", 120, 7]);
    expect(fp).toMatch(/^[a-f0-9]{8}$/);
    expect(errorLocationFingerprint(["TypeError", "index-Ab3xY9.js", 120, 7])).toBe(fp);
    expect(errorLocationFingerprint(["RangeError", "index-Ab3xY9.js", 120, 7])).not.toBe(fp);
  });

  test("global JS_ERROR report carries bounded location on the wire", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    // 全局去重状态是模块级的,前序用例已消耗 JS_ERROR 名额——取全新模块实例。
    vi.resetModules();
    const fresh = await import("./clientFriction");
    fresh.installGlobalClientFrictionHandlers();

    const error = Object.assign(new Event("error"), {
      message: "DO_NOT_SEND details",
      filename: "https://oc.example/assets/vendor-9x.js",
      lineno: 42,
      colno: 3,
      error: new RangeError("DO_NOT_SEND"),
    });
    window.dispatchEvent(error);

    const jsErrorBody = fetchMock.mock.calls
      .map((call) => JSON.parse(String((call[1] as RequestInit).body)))
      .find((body) => body.code === "JS_ERROR");
    expect(jsErrorBody).toBeDefined();
    expect(jsErrorBody).toMatchObject({
      error_name: "RangeError",
      script_ref: "vendor-9x.js",
      line_no: 42,
      col_no: 3,
    });
    expect(jsErrorBody.error_fingerprint).toMatch(/^[a-f0-9]{8}$/);
    expect(JSON.stringify(jsErrorBody)).not.toContain("DO_NOT_SEND");
  });

  test("batches per-entity exposures into one telemetry request", () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));

    const ids = reportClientFrictionBatch([
      { eventId: "exposure_1", surface: "marketplace", stage: "catalog_exposure", code: "CATALOG_EXPOSURE", outcome: "succeeded", entitySlug: "skill.one" },
      { eventId: "exposure_2", surface: "marketplace", stage: "catalog_exposure", code: "CATALOG_EXPOSURE", outcome: "succeeded", entitySlug: "skill.two" },
    ], "token");

    expect(ids).toEqual(["exposure_1", "exposure_2"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(body.events.map((event: { entity_slug: string }) => event.entity_slug)).toEqual([
      "skill.one",
      "skill.two",
    ]);
  });

  test("problem_card dims pass through; invalid path/reason/presentation dropped", () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));

    reportClientFriction({
      eventId: "pc_1",
      surface: "chat",
      stage: "problem_card",
      code: "upstream_failed",
      outcome: "failed",
      correlation: "sess-1:u-root",
      presentation: "red",
      path: "immediate",
      reason: "checkpoint_unsafe",
      attempts: 1,
    }, "token");
    reportClientFriction({
      eventId: "pc_2",
      surface: "chat",
      stage: "problem_card",
      code: "upstream_failed",
      outcome: "failed",
      correlation: "sess-1:u-root",
      presentation: "purple" as never,
      path: "NOT VALID",
      reason: "Has Spaces",
    }, "token");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const valid = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(valid).toMatchObject({
      event_id: "pc_1",
      surface: "chat",
      stage: "problem_card",
      code: "upstream_failed",
      outcome: "failed",
      correlation: "sess-1:u-root",
      presentation: "red",
      path: "immediate",
      reason: "checkpoint_unsafe",
      attempts: 1,
    });
    const dropped = JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body));
    expect(dropped.correlation).toBe("sess-1:u-root");
    expect(dropped).not.toHaveProperty("path");
    expect(dropped).not.toHaveProperty("reason");
    expect(dropped).not.toHaveProperty("presentation");
  });

  test("reportClientFrictionOnce dedupes the same key", () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));

    const first = reportClientFrictionOnce("billing:pricing_exposure", {
      surface: "billing", stage: "pricing_exposure", code: "PRICING_EXPOSURE", outcome: "succeeded",
    }, "token");
    const second = reportClientFrictionOnce("billing:pricing_exposure", {
      surface: "billing", stage: "pricing_exposure", code: "PRICING_EXPOSURE", outcome: "succeeded",
    }, "token");

    expect(first).toBeTruthy();
    expect(second).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(body).toMatchObject({
      surface: "billing", stage: "pricing_exposure", code: "PRICING_EXPOSURE", outcome: "succeeded",
    });
  });

  test("OCV5-39: rejects document URLs, /s/<id> SPA routes, and non-script refs from scriptRef", () => {
    expect(sessionIdFromPathname("/s/webmtd63p5mm747zh")).toBe("webmtd63p5mm747zh");
    expect(sessionIdFromPathname("/s/webmtd63p5mm747zh/")).toBe("webmtd63p5mm747zh");
    expect(sessionIdFromPathname("/s/webmtd63p5mm747zh?token=secret#frag")).toBe("webmtd63p5mm747zh");
    expect(sessionIdFromPathname("/")).toBeUndefined();
    expect(sessionIdFromPathname("/board")).toBeUndefined();
    expect(sessionIdFromPathname("/p/proj-1")).toBeUndefined();
    expect(sessionIdFromPathname("/s/bad space")).toBeUndefined();
    expect(sessionIdFromPathname("/s/nested/extra")).toBeUndefined();

    const docHref = "https://oc.example/s/webmtd63p5mm747zh?token=secret#frag";
    expect(scriptRefFromSource("https://oc.example/s/webmtd63p5mm747zh", docHref)).toBeUndefined();
    expect(scriptRefFromSource("https://oc.example/s/webmtd63p5mm747zh?foo=1", docHref)).toBeUndefined();
    expect(scriptRefFromSource("https://oc.example/s/fake-session.js", docHref)).toBeUndefined();
    expect(scriptRefFromSource("webmtd63p5mm747zh", docHref)).toBeUndefined();
    expect(scriptRefFromSource("https://oc.example/p/proj_1", docHref)).toBeUndefined();
    expect(scriptRefFromSource("https://oc.example/index.html", docHref)).toBeUndefined();
    expect(scriptRefFromSource("blob:https://oc.example/550e8400-e29b.js", docHref)).toBeUndefined();
    expect(scriptRefFromSource("chrome-extension://ext/inject.js", docHref)).toBeUndefined();
    expect(scriptRefFromSource("https://oc.example/assets/index-Ab3xY9.mjs?v=2#h", docHref)).toBe(
      "index-Ab3xY9.mjs",
    );
  });

  test("OCV5-39: Safari mobile /s/<id> ErrorEvent attaches session_id, drops fake script_ref/fingerprint, keeps bounded reason", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    window.history.replaceState({}, "", "/s/webmtd63p5mm747zh?token=SECRET_TOKEN#hash");

    vi.resetModules();
    const fresh = await import("./clientFriction");
    fresh.installGlobalClientFrictionHandlers();

    // Exact Safari mobile shape observed on OCV5-39 (f26ae76a): document URL as filename, lineno=0, error=null.
    const safariEvent = Object.assign(new Event("error"), {
      message: "ResizeObserver loop completed with undelivered notifications.",
      filename: `${window.location.origin}/s/webmtd63p5mm747zh?token=SECRET_TOKEN`,
      lineno: 0,
      colno: 0,
      error: null,
    });
    window.dispatchEvent(safariEvent);

    const body = fetchMock.mock.calls
      .map((call) => JSON.parse(String((call[1] as RequestInit).body)))
      .find((item) => item.code === "JS_ERROR");
    expect(body).toBeDefined();
    expect(body.session_id).toBe("webmtd63p5mm747zh");
    expect(body.reason).toBe("resize_observer_loop");
    expect(body.script_ref).toBeUndefined();
    expect(body.line_no).toBeUndefined();
    expect(body.col_no).toBeUndefined();
    expect(body.error_name).toBeUndefined();
    expect(body.error_fingerprint).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("SECRET_TOKEN");
    expect(JSON.stringify(body)).not.toContain("undelivered notifications");
  });

  test("OCV5-39: same error across two /s/<id> sessions produces distinct session_id and identical error_fingerprint", async () => {
    const capture = async (sessionId: string) => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
      window.history.replaceState({}, "", `/s/${sessionId}?invite=PRIVATE`);

      vi.resetModules();
      const fresh = await import("./clientFriction");
      fresh.installGlobalClientFrictionHandlers();

      const err = new TypeError("undefined is not an object (evaluating 'msg.PRIVATE_TEXT')");
      err.stack = [
        `global code@${window.location.origin}/s/${sessionId}:1:1`,
        "renderRow@https://oc.example/assets/index-Ab3xY9.js:120:7",
      ].join("\n");
      const event = Object.assign(new Event("error"), {
        message: err.message,
        filename: `${window.location.origin}/s/${sessionId}`,
        lineno: 0,
        colno: 0,
        error: err,
      });
      window.dispatchEvent(event);
      return fetchMock.mock.calls
        .map((call) => JSON.parse(String((call[1] as RequestInit).body)))
        .find((item) => item.code === "JS_ERROR");
    };

    const first = await capture("webmt_alpha_1");
    const second = await capture("webmt_beta_2");
    expect(first.session_id).toBe("webmt_alpha_1");
    expect(second.session_id).toBe("webmt_beta_2");
    expect(first).toMatchObject({
      error_name: "TypeError",
      script_ref: "index-Ab3xY9.js",
      line_no: 120,
      col_no: 7,
      reason: "undefined_dereference",
    });
    expect(first.error_fingerprint).toMatch(/^[a-f0-9]{8}$/);
    expect(second.error_fingerprint).toBe(first.error_fingerprint);
    expect(JSON.stringify(first)).not.toContain("PRIVATE");
  });

  test("OCV5-39: Safari sourceURL/line/col fallback, message-only class allowlist, and UNHANDLED_REJECTION stack extraction", async () => {
    const safariErr = Object.assign(new RangeError("Maximum call stack size exceeded"), {
      stack: undefined,
      sourceURL: "https://oc.example/assets/chat-9z.js?v=3",
      line: 88,
      column: 14,
    });
    expect(
      boundedErrorLocation({
        filename: "https://oc.example/s/webmt123",
        lineno: 0,
        colno: 0,
        error: safariErr,
      }),
    ).toEqual({
      errorName: "RangeError",
      scriptRef: "chat-9z.js",
      lineNo: 88,
      colNo: 14,
      reason: "max_call_stack",
    });

    expect(
      boundedErrorLocation({
        filename: "",
        lineno: 0,
        colno: 0,
        error: null,
        message: "Uncaught TypeError: Cannot read properties of null (reading 'SECRET_KEY')",
      }),
    ).toEqual({
      errorName: "TypeError",
      scriptRef: undefined,
      lineNo: undefined,
      colNo: undefined,
      reason: "null_dereference",
    });
    expect(boundedErrorReasonFromMessage("Script error.")).toBe("cross_origin_script_error");
    expect(boundedErrorReasonFromMessage("random user prompt text")).toBeUndefined();
    expect(
      parseTopStackFrame("at fn (https://oc.example/assets/chunk-1.js:33:9)\n", "https://oc.example/s/x"),
    ).toEqual({ scriptRef: "chunk-1.js", lineNo: 33, colNo: 9 });

    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
    window.history.replaceState({}, "", "/s/webmt_rej_1");
    vi.resetModules();
    const fresh = await import("./clientFriction");
    fresh.installGlobalClientFrictionHandlers();

    const rejErr = new TypeError("Failed to fetch dynamically imported module: https://oc.example/assets/lazy.js");
    rejErr.stack = "TypeError: ...\n    at loadChunk (https://oc.example/assets/main-abc.js:55:12)";
    window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: rejErr }));

    const rejBody = fetchMock.mock.calls
      .map((call) => JSON.parse(String((call[1] as RequestInit).body)))
      .find((item) => item.code === "UNHANDLED_REJECTION");
    expect(rejBody).toMatchObject({
      session_id: "webmt_rej_1",
      error_name: "TypeError",
      script_ref: "main-abc.js",
      line_no: 55,
      col_no: 12,
      reason: "chunk_load_failed",
    });
    expect(rejBody.error_fingerprint).toMatch(/^[a-f0-9]{8}$/);
  });

  test("OCV5-77: boundedRenderErrorLocation extracts component path, stack frame, and avoids fake fingerprints on empty input", () => {
    const err = new TypeError("Cannot read properties of undefined (reading 'USER_PII')");
    err.stack = "TypeError: ...\n    at ToolCardSlot (https://oc.example/assets/cards-123.js:210:15)";
    const componentStack = "\n    at div\n    at ToolCardSlot\n    at MessageRenderer\n    at SessionTimelineBoundary";
    const loc = boundedRenderErrorLocation(err, componentStack);
    expect(loc).toMatchObject({
      errorName: "TypeError",
      scriptRef: "cards-123.js",
      lineNo: 210,
      colNo: 15,
      path: "tool_card_slot",
      reason: "undefined_dereference",
    });
    expect(loc.errorFingerprint).toMatch(/^[a-f0-9]{8}$/);
    expect(JSON.stringify(loc)).not.toContain("USER_PII");

    // Empty/null error + empty componentStack must NOT emit a fake fingerprint.
    expect(boundedRenderErrorLocation(null, "")).toEqual({});
    expect(
      parseComponentStackSummary("\n    at span\n    at ProcessDisclosure (https://oc.example/assets/pd-1.js:9:4)"),
    ).toEqual({
      topComponentPath: "process_disclosure",
      componentChain: "ProcessDisclosure",
      scriptFrame: { scriptRef: "pd-1.js", lineNo: 9, colNo: 4 },
    });
  });
});
