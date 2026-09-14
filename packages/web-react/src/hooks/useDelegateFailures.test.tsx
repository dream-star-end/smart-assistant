import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { createMemoryAuthSession } from "../lib/authSession";
import { useDelegateFailures } from "./useDelegateFailures";

afterEach(() => vi.unstubAllGlobals());
const summary = (n: number) => new Response(JSON.stringify({ version: 1, available: true, running: 0, queued: 0, unacknowledgedFailures: n }));

test("account hook requests global summary without an active session and retains scope on token refresh", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => summary(7)));
  const auth = createMemoryAuthSession(() => {}, "a");
  const { result, rerender, unmount } = renderHook(() => useDelegateFailures(auth, "user-a", true));
  await waitFor(() => expect(result.current.state.summary?.unacknowledgedFailures).toBe(7));
  const controller = result.current.controller;
  auth.commitToken(auth.snapshot().epoch, "a-refreshed"); rerender();
  expect(result.current.controller).toBe(controller);
  expect(vi.mocked(fetch).mock.calls.every(([url]) => String(url) === "/api/delegates/summary")).toBe(true);
  unmount();
});

test("same AuthSession object changes identity: old hook results and old action handles cannot reach B", async () => {
  let finishA!: (res: Response) => void;
  const a = new Promise<Response>(resolve => { finishA = resolve; });
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
    (init?.headers as Record<string, string>).Authorization === "Bearer a" ? a : summary(2));
  vi.stubGlobal("fetch", fetcher);
  const auth = createMemoryAuthSession(() => {}, "a");
  const { result, rerender, unmount } = renderHook(({ user }) => useDelegateFailures(auth, user, true), { initialProps: { user: "user-a" } });
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  const old = result.current.controller!;
  auth.commitToken(auth.beginIdentity(), "b"); rerender({ user: "user-b" });
  expect(result.current.state.summary).toBeNull();
  await waitFor(() => expect(result.current.state.summary?.unacknowledgedFailures).toBe(2));
  await act(async () => { finishA(summary(99)); await old.refresh(); });
  expect(result.current.state.summary?.unacknowledgedFailures).toBe(2);
  expect(old.getSnapshot().summary).toBeNull();
  const calls = fetcher.mock.calls.length;
  await old.acknowledge({ jobId: "job-a", generation: 1, parentSessionKey: "a", failedAt: 1, summaryCode: "delegate_failed", summaryText: "", retry: { available: true, reason: null } });
  expect(fetcher.mock.calls).toHaveLength(calls);
  unmount();
});

test("logout hides loaded account failures in the same render and releases the old controller", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => summary(9)));
  const auth = createMemoryAuthSession(() => {}, "a");
  const { result, rerender, unmount } = renderHook(({ enabled }) => useDelegateFailures(auth, "user-a", enabled), { initialProps: { enabled: true } });
  await waitFor(() => expect(result.current.state.summary?.unacknowledgedFailures).toBe(9));
  auth.beginIdentity(); rerender({ enabled: false });
  expect(result.current.state.summary).toBeNull(); expect(result.current.controller).toBeNull();
  unmount();
});
