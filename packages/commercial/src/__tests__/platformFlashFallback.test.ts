/**
 * OCV5-482 — DeepSeek V4 Flash: OpenCode Go first, official DeepSeek as automatic fallback.
 * Protocol fallback table + the platform-direct helper (marketplace review / voice polish / Knowledge Planet).
 *
 * 跑法: npx tsx --test src/__tests__/platformFlashFallback.test.ts
 */
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { staticRouteFallback } from "@openclaude/protocol";
import { fetchPlatformFlash, setPlatformFlashFallbackKey } from "../http/proxy/shared.js";

const GO = "https://opencode.ai/zen/go/v1/messages";
const DS = "https://api.deepseek.com/anthropic/v1/messages";

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
function recorder(responses: Array<Response | Error>) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    const next = responses.shift();
    if (!next) throw new Error("unexpected call");
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, fetchImpl };
}
const goLimit = () => new Response(
  '{"type":"error","error":{"type":"GoUsageLimitError","message":"Go usage limit exceeded"}}',
  { status: 429 },
);
const ok = () => new Response('{"content":[{"type":"text","text":"ok"}]}', { status: 200 });
const body = { model: "deepseek-v4-flash", max_tokens: 8, messages: [{ role: "user", content: "hi" }] };

afterEach(() => setPlatformFlashFallbackKey(undefined));

describe("staticRouteFallback", () => {
  test("Go DeepSeek Flash falls back to official deepseek-flash; other Go models have none", () => {
    assert.deepEqual(staticRouteFallback("opencodego", "deepseek-v4.1-flash"),
      { providerId: "deepseek", upstreamModel: "deepseek-flash" });
    assert.deepEqual(staticRouteFallback("opencodego", "DeepSeek-V4-Flash"),
      { providerId: "deepseek", upstreamModel: "deepseek-flash" });
    assert.equal(staticRouteFallback("opencodego", "deepseek-v4-pro"), undefined);
    assert.equal(staticRouteFallback("opencodego", "qwen3.7-plus"), undefined);
    assert.equal(staticRouteFallback("deepseek", "deepseek-flash"), undefined);
  });
});

describe("fetchPlatformFlash", () => {
  test("Go 200 → Go only, body unchanged", async () => {
    setPlatformFlashFallbackKey("DS-KEY");
    const r = recorder([ok()]);
    const res = await fetchPlatformFlash(r.fetchImpl, { goKey: "GO-KEY", body, init: {} });
    assert.equal(res.status, 200);
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0]!.url, GO);
    assert.equal(r.calls[0]!.headers["x-api-key"], "GO-KEY");
    // OpenCode Go 缺 x-opencode-session 即 400 MissingSessionID(且不回落)。
    assert.match(r.calls[0]!.headers["x-opencode-session"] ?? "", /^[0-9a-f-]{36}$/);
    assert.equal(r.calls[0]!.body.model, "deepseek-v4-flash");
  });

  test("Go weekly limit 429 → same call on official DeepSeek with Bearer key and deepseek-flash", async () => {
    setPlatformFlashFallbackKey("DS-KEY");
    const r = recorder([goLimit(), ok()]);
    const res = await fetchPlatformFlash(r.fetchImpl, { goKey: "GO-KEY", body, accept: "text/event-stream", init: {} });
    assert.equal(res.status, 200);
    assert.deepEqual(r.calls.map((c) => c.url), [GO, DS]);
    assert.equal(r.calls[1]!.headers.Authorization, "Bearer DS-KEY");
    assert.equal(r.calls[1]!.headers.Accept, "text/event-stream");
    assert.equal(r.calls[1]!.headers["x-api-key"], undefined);
    assert.deepEqual(r.calls[1]!.body, { ...body, model: "deepseek-flash" });
  });

  test("Go network error → fallback; Go 400 → no fallback", async () => {
    setPlatformFlashFallbackKey("DS-KEY");
    const a = recorder([new Error("socket hang up"), ok()]);
    await fetchPlatformFlash(a.fetchImpl, { goKey: "GO-KEY", body, init: {} });
    assert.deepEqual(a.calls.map((c) => c.url), [GO, DS]);
    const b = recorder([new Response("bad", { status: 400 })]);
    const res = await fetchPlatformFlash(b.fetchImpl, { goKey: "GO-KEY", body, init: {} });
    assert.equal(res.status, 400);
    assert.equal(b.calls.length, 1);
  });

  test("no fallback key → Go answer returned as is (old behaviour)", async () => {
    const r = recorder([goLimit()]);
    const res = await fetchPlatformFlash(r.fetchImpl, { goKey: "GO-KEY", body, init: {} });
    assert.equal(res.status, 429);
    assert.equal(r.calls.length, 1);
  });

  test("no Go key → official DeepSeek directly", async () => {
    setPlatformFlashFallbackKey("DS-KEY");
    const r = recorder([ok()]);
    await fetchPlatformFlash(r.fetchImpl, { body, init: {} });
    assert.deepEqual(r.calls.map((c) => c.url), [DS]);
  });
});
