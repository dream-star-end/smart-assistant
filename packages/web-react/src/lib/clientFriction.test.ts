import { afterEach, describe, expect, test, vi } from "vitest";

import {
  boundedErrorLocation,
  errorLocationFingerprint,
  installGlobalClientFrictionHandlers,
  reportClientFriction,
  reportClientFrictionBatch,
  scriptRefFromSource,
} from "./clientFriction";

afterEach(() => {
  document.querySelector('meta[name="oc-build"]')?.remove();
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
});
