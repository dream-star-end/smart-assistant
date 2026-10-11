import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../lib/api";
import { useResponseRatings, type UseResponseRatingsArgs } from "./useResponseRatings";

afterEach(() => {
  vi.restoreAllMocks();
});

// App passes useRef objects, which keep their identity across renders; so do these.
const refs = {
  authRef: { current: null } as unknown as UseResponseRatingsArgs["authRef"],
  sockRef: { current: null },
  stoppedTurnRef: { current: false },
};

function args(over: Partial<UseResponseRatingsArgs> = {}): UseResponseRatingsArgs {
  return { demo: false, signedIn: true, activeId: "s1", modelId: "m1", sending: false, ...refs, ...over };
}

describe("useResponseRatings", () => {
  test("loads the session's ratings and clears them when the session changes", async () => {
    const get = vi.spyOn(api, "getSessionRatings").mockImplementation(async (_auth, sessionId) =>
      sessionId === "s1"
        ? { ratings: { m9: { rating: "up", tags: ["准确"] } }, nudges: {} }
        : { ratings: {}, nudges: {} },
    );
    const { result, rerender } = renderHook((p: UseResponseRatingsArgs) => useResponseRatings(p), {
      initialProps: args(),
    });
    await waitFor(() => expect(result.current.ratingCtx?.ratings.get("m9")).toEqual({ rating: "up", tags: ["准确"] }));
    rerender(args({ activeId: "s2" }));
    await waitFor(() => expect(get).toHaveBeenCalledWith(null, "s2"));
    expect(result.current.ratingCtx?.ratings.size).toBe(0);
    expect(result.current.ratingCtx?.sessionId).toBe("s2");
  });

  test("a rating shows at once and is posted with the session and model", async () => {
    vi.spyOn(api, "getSessionRatings").mockResolvedValue({ ratings: {}, nudges: {} });
    const post = vi.spyOn(api, "submitResponseRating").mockResolvedValue(undefined as never);
    const { result } = renderHook((p: UseResponseRatingsArgs) => useResponseRatings(p), { initialProps: args() });
    await waitFor(() => expect(api.getSessionRatings).toHaveBeenCalled());
    act(() => result.current.ratingCtx?.submit({ messageId: "m1", rating: "down", tags: ["跑题"] }));
    expect(result.current.ratingCtx?.ratings.get("m1")).toEqual({ rating: "down", tags: ["跑题"] });
    expect(post).toHaveBeenCalledWith(null, expect.objectContaining({ messageId: "m1", rating: "down", sessionId: "s1", model: "m1" }));
  });

  test("an implicit report is sent once per message and never over an explicit rating", async () => {
    vi.spyOn(api, "getSessionRatings").mockResolvedValue({ ratings: { rated: { rating: "up", tags: [] } }, nudges: {} });
    const post = vi.spyOn(api, "submitResponseRating").mockResolvedValue(undefined as never);
    const { result } = renderHook((p: UseResponseRatingsArgs) => useResponseRatings(p), { initialProps: args() });
    await waitFor(() => expect(result.current.ratingCtx?.ratings.has("rated")).toBe(true));
    act(() => {
      result.current.sendImplicitRating({ messageId: "x", traceId: null }, { reason: "中途打断" });
      result.current.sendImplicitRating({ messageId: "x", traceId: null }, { reason: "中途打断" });
      result.current.sendImplicitRating({ messageId: "rated", traceId: null }, { reason: "改写重发" });
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(null, expect.objectContaining({ messageId: "x", rating: "down", tags: ["implicit", "中途打断"] }));
  });

  test("demo and signed-out sessions expose no rating context and send nothing", () => {
    const get = vi.spyOn(api, "getSessionRatings");
    const post = vi.spyOn(api, "submitResponseRating");
    const { result: demo } = renderHook((p: UseResponseRatingsArgs) => useResponseRatings(p), { initialProps: args({ demo: true }) });
    const { result: anon } = renderHook((p: UseResponseRatingsArgs) => useResponseRatings(p), { initialProps: args({ signedIn: false }) });
    expect(demo.current.ratingCtx).toBeNull();
    expect(anon.current.ratingCtx).toBeNull();
    act(() => anon.current.sendImplicitRating({ messageId: "x", traceId: null }, { reason: "中途打断" }));
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
});
