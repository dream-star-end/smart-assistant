import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { verifyTurnstile, TurnstileError } from "../auth/turnstile.js";

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return ((url: string, init: RequestInit) => Promise.resolve(handler(url, init))) as unknown as typeof fetch;
}

describe("auth.turnstile.verifyTurnstile", () => {
  test("returns true on success=true response", async () => {
    const ok = await verifyTurnstile("user-token", "secret", {
      fetchImpl: fakeFetch(() => new Response(JSON.stringify({ success: true }), { status: 200 })),
    });
    assert.equal(ok, true);
  });

  test("returns false on success=false response", async () => {
    const ok = await verifyTurnstile("user-token", "secret", {
      fetchImpl: fakeFetch(() => new Response(JSON.stringify({ success: false, "error-codes": ["invalid"] }), { status: 200 })),
    });
    assert.equal(ok, false);
  });

  test("throws TurnstileError on non-2xx HTTP", async () => {
    await assert.rejects(
      verifyTurnstile("token", "secret", {
        fetchImpl: fakeFetch(() => new Response("oops", { status: 500 })),
      }),
      (err: unknown) => err instanceof TurnstileError && /HTTP 500/.test((err as Error).message),
    );
  });

  test("throws TurnstileError on fetch network error", async () => {
    await assert.rejects(
      verifyTurnstile("token", "secret", {
        fetchImpl: () => Promise.reject(new Error("ENOTFOUND")) as never,
      }),
      TurnstileError,
    );
  });

  test("returns false on empty token without making any HTTP call", async () => {
    let called = false;
    const ok = await verifyTurnstile("", "secret", {
      fetchImpl: fakeFetch(() => {
        called = true;
        return new Response("{}");
      }),
    });
    assert.equal(ok, false);
    assert.equal(called, false);
  });

  test("bypass=true returns true even when secret is missing", async () => {
    const ok = await verifyTurnstile("any-token", undefined, { bypass: true });
    assert.equal(ok, true);
  });

  test("throws TurnstileError when secret is missing and not bypassed", async () => {
    await assert.rejects(
      verifyTurnstile("token", undefined),
      (err: unknown) => err instanceof TurnstileError && /not configured/.test((err as Error).message),
    );
  });

  test("forwards remoteIp to verification request body", async () => {
    let capturedBody = "";
    await verifyTurnstile("token", "secret", {
      remoteIp: "1.2.3.4",
      fetchImpl: fakeFetch((_url, init) => {
        capturedBody = init.body!.toString();
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }),
    });
    assert.match(capturedBody, /remoteip=1\.2\.3\.4/);
    assert.match(capturedBody, /response=token/);
    assert.match(capturedBody, /secret=secret/);
  });
});
