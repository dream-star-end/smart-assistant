import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createMemoryAuthSession } from "../lib/authSession";
import { SERVER_FEATURES_OFF, loadServerFeatures, useServerFeatures } from "./useServerFeatures";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("useServerFeatures", () => {
  test("reads /api/features once per identity and caches it", async () => {
    const fetchMock = vi.fn(async () => json({ features: { chips: true, recipeSchedule: false, unfiledSuggest: true } }));
    vi.stubGlobal("fetch", fetchMock);
    const auth = createMemoryAuthSession(() => {}, "tok");
    const a = renderHook(() => useServerFeatures(auth, false));
    expect(a.result.current).toEqual(SERVER_FEATURES_OFF);
    await waitFor(() => expect(a.result.current.chips).toBe(true));
    expect(a.result.current).toEqual({ chips: true, recipeSchedule: false, unfiledSuggest: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe("/api/features");

    // A second consumer starts with the cached value and does not fetch again.
    const b = renderHook(() => useServerFeatures(auth, false));
    expect(b.result.current.chips).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("fails closed on network error, non-2xx and malformed bodies; a failure is not cached", async () => {
    for (const make of [
      () => Promise.reject(new TypeError("Failed to fetch")),
      async () => json({ error: "boom" }, 500),
      async () => json({ features: { chips: "true" } }),
      async () => new Response("not json", { status: 200 }),
    ]) {
      vi.stubGlobal("fetch", vi.fn(make));
      const auth = createMemoryAuthSession(() => {}, "tok");
      await expect(loadServerFeatures(auth)).resolves.toEqual(SERVER_FEATURES_OFF);
    }
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(json({ features: { chips: true } }));
    vi.stubGlobal("fetch", fetchMock);
    const auth = createMemoryAuthSession(() => {}, "tok");
    expect((await loadServerFeatures(auth)).chips).toBe(false);
    expect((await loadServerFeatures(auth)).chips).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("demo and signed-out read nothing and stay off", async () => {
    const fetchMock = vi.fn(async () => json({ features: { chips: true } }));
    vi.stubGlobal("fetch", fetchMock);
    const auth = createMemoryAuthSession(() => {}, "tok");
    const demo = renderHook(() => useServerFeatures(auth, true));
    const out = renderHook(() => useServerFeatures(null, false));
    await new Promise((r) => setTimeout(r, 0));
    expect(demo.result.current).toEqual(SERVER_FEATURES_OFF);
    expect(out.result.current).toEqual(SERVER_FEATURES_OFF);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("an identity switch drops the old flags and reads again", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ features: { chips: true } }))
      .mockResolvedValueOnce(json({ features: { chips: false, recipeSchedule: true } }));
    vi.stubGlobal("fetch", fetchMock);
    const auth = createMemoryAuthSession(() => {}, "tok");
    const h = renderHook(() => useServerFeatures(auth, false));
    await waitFor(() => expect(h.result.current.chips).toBe(true));
    const epoch = auth.beginIdentity();
    auth.commitToken(epoch, "tok-b");
    h.rerender();
    expect(h.result.current).toEqual(SERVER_FEATURES_OFF);
    await waitFor(() => expect(h.result.current.recipeSchedule).toBe(true));
    expect(h.result.current.chips).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
