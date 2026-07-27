import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  bindClientFrictionTokenProvider,
  describeClientRuntimeError,
  fingerprintClientRuntimeError,
  installGlobalClientFrictionHandlers,
  reportClientFriction,
} from "./clientFriction";

const providerCleanups: Array<() => void> = [];

afterEach(() => {
  while (providerCleanups.length) providerCleanups.pop()?.();
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
      client_build: "build-abc", browser_family: "chrome", device_class: "desktop",
    });
    expect(JSON.stringify(body)).not.toContain("DO_NOT_SEND");
    expect(body).not.toHaveProperty("message");
    expect(body).not.toHaveProperty("stack");
    expect(body).not.toHaveProperty("url");
    expect(body).not.toHaveProperty("user_agent");
  });

  test("token getter follows refresh and owner cleanup cannot erase a newer provider", () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
    let token = "token-a";
    const cleanupA = bindClientFrictionTokenProvider(() => token);
    providerCleanups.push(cleanupA);

    reportClientFriction({ surface: "client", stage: "runtime", code: "JS_ERROR" });
    token = "token-a2";
    reportClientFriction({ surface: "client", stage: "runtime", code: "JS_ERROR" });

    const cleanupB = bindClientFrictionTokenProvider(() => "token-b");
    providerCleanups.push(cleanupB);
    cleanupA();
    reportClientFriction({ surface: "client", stage: "runtime", code: "JS_ERROR" });
    cleanupB();
    reportClientFriction({ surface: "client", stage: "runtime", code: "JS_ERROR" });

    const auth = fetchMock.mock.calls.map(
      (call) => (call[1] as RequestInit).headers as Record<string, string>,
    );
    expect(auth.map((headers) => headers.Authorization ?? null)).toEqual([
      "Bearer token-a",
      "Bearer token-a2",
      "Bearer token-b",
      null,
    ]);
  });

  test("v1 fingerprint normalizes dynamic PII and Vite hashes across Chrome/Safari stacks", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const chromeError = new TypeError(
      "Failed for a@example.com request 123 at https://private.example/a 'secret-a' 550e8400-e29b-41d4-a716-446655440000",
    );
    chromeError.stack = [
      chromeError.toString(),
      "    at render (https://claudeai.chat/assets/main-CuPX4CBJ.js:12:34)",
    ].join("\n");
    const safariError = new TypeError(
      'Failed for b@example.net request 987 at https://private.example/b "secret-b" 123e4567-e89b-42d3-a456-426614174000',
    );
    safariError.stack = [
      safariError.toString(),
      "render@https://claudeai.chat/assets/main-ZZZZZZZZ.js:98:76",
    ].join("\n");

    const chrome = describeClientRuntimeError(
      "JS_ERROR",
      new ErrorEvent("error", { error: chromeError, message: chromeError.message }),
    );
    const safari = describeClientRuntimeError(
      "JS_ERROR",
      new ErrorEvent("error", { error: safariError, message: safariError.message }),
    );
    expect(chrome).toEqual(safari);
    expect(chrome).toMatchObject({ errorName: "type_error", frameBasename: "main.js" });
    const fingerprint = await fingerprintClientRuntimeError(chrome);
    expect(fingerprint).toBe("38f03b4e6a99d01f");
    expect(await fingerprintClientRuntimeError(safari)).toBe(fingerprint);

    const dom = describeClientRuntimeError(
      "UNHANDLED_REJECTION",
      Object.assign(new Event("unhandledrejection"), {
        reason: new DOMException("The operation was aborted for user@example.com", "AbortError"),
      }),
    );
    expect(dom.errorName).toBe("dom_exception");
    const scriptError = describeClientRuntimeError(
      "JS_ERROR",
      new ErrorEvent("error", { message: "Script error." }),
    );
    expect(scriptError).toMatchObject({
      errorName: "error",
      normalizedMessage: "script error.",
      frameBasename: "",
    });
    const stringRejection = describeClientRuntimeError(
      "UNHANDLED_REJECTION",
      Object.assign(new Event("unhandledrejection"), { reason: "private raw rejection" }),
    );
    const objectRejection = describeClientRuntimeError(
      "UNHANDLED_REJECTION",
      Object.assign(new Event("unhandledrejection"), { reason: { secret: "private" } }),
    );
    const spoofedErrorObject = describeClientRuntimeError(
      "UNHANDLED_REJECTION",
      Object.assign(new Event("unhandledrejection"), {
        reason: {
          name: "TypeError",
          message: "private object value",
          stack: "https://private.invalid/spoof.js",
        },
      }),
    );
    expect(stringRejection).toMatchObject({
      errorName: "non_error",
      normalizedMessage: "string_rejection",
    });
    expect(objectRejection).toMatchObject({
      errorName: "non_error",
      normalizedMessage: "object_rejection",
    });
    expect(spoofedErrorObject).toEqual(objectRejection);

    const quotedA = new Error(`Failed for "${"a".repeat(200)}" and "Alice's private token"`);
    const quotedB = new Error(`Failed for "${"b".repeat(220)}" and "Bob's different secret"`);
    expect(describeClientRuntimeError(
      "UNHANDLED_REJECTION",
      Object.assign(new Event("unhandledrejection"), { reason: quotedA }),
    ).normalizedMessage).toBe(describeClientRuntimeError(
      "UNHANDLED_REJECTION",
      Object.assign(new Event("unhandledrejection"), { reason: quotedB }),
    ).normalizedMessage);
  });

  test("global handlers freeze the event identity before digest and fall back without WebCrypto", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    const digestResolvers: Array<(value: ArrayBuffer) => void> = [];
    const digest = vi
      .fn()
      .mockImplementationOnce(() => new Promise<ArrayBuffer>((resolve) => {
        digestResolvers.push(resolve);
      }))
      .mockRejectedValueOnce(new Error("WebCrypto unavailable"));
    vi.stubGlobal("crypto", {
      randomUUID: () => "11111111-2222-4333-8444-555555555555",
      subtle: { digest },
    });
    let token = "token-user-a";
    providerCleanups.push(bindClientFrictionTokenProvider(() => token));
    installGlobalClientFrictionHandlers();
    installGlobalClientFrictionHandlers();

    const runtimeError = new TypeError("DO_NOT_SEND runtime secret");
    runtimeError.stack = "TypeError: DO_NOT_SEND\n at run (https://private.invalid/main-ABCDEFGH.js:1:2)";
    const error = new ErrorEvent("error", {
      message: "DO_NOT_SEND runtime secret",
      filename: "https://private.invalid/main-ABCDEFGH.js",
      error: runtimeError,
    });
    window.dispatchEvent(error);
    token = "token-user-b";
    digestResolvers[0]!(new Uint8Array(32).buffer);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const rejection = Object.assign(new Event("unhandledrejection"), {
      reason: "DO_NOT_SEND promise secret",
    });
    window.dispatchEvent(rejection);
    window.dispatchEvent(rejection);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)));
    expect(bodies.map((b) => b.code)).toEqual(["JS_ERROR", "UNHANDLED_REJECTION"]);
    expect(bodies[0]).toMatchObject({
      error_name: "type_error",
      error_fingerprint: "0000000000000000",
    });
    expect(bodies[1]).toMatchObject({ error_name: "non_error" });
    expect(bodies[1]).not.toHaveProperty("error_fingerprint");
    const headers = fetchMock.mock.calls.map(
      (call) => (call[1] as RequestInit).headers as Record<string, string>,
    );
    expect(headers.map((value) => value.Authorization)).toEqual([
      "Bearer token-user-a",
      "Bearer token-user-b",
    ]);
    expect(JSON.stringify(bodies)).not.toContain("DO_NOT_SEND");
    expect(JSON.stringify(bodies)).not.toContain("private.invalid");
    expect(bodies.every((body) => !("message" in body) && !("stack" in body))).toBe(true);
  });
});
