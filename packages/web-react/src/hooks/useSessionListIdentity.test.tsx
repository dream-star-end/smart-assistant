import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { createMemoryAuthSession } from "../lib/authSession";
import type { AuthSession, SessionMeta, User } from "../lib/types";
import { useAuth } from "./useAuth";
import { useSessionList } from "./useSessionList";

vi.mock("../lib/authHint", () => ({ hasAuthHint: () => false, setAuthHint: vi.fn(), clearAuthHint: vi.fn() }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const alice: User = { id: "alice", displayName: "Alice", roles: ["user"] };
const meta = (id: string): SessionMeta => ({ id, title: id, agentId: "main", pinned: false, createdAt: 1, lastAt: 2000, updatedAt: 2000, messageCount: 1, lastMessagePreview: `${id} preview` });
const callbacks = {
  demo: false, agentId: "main", holdAutoSelect: true, sockRef: { current: null },
  confirmDialog: async () => false as const, promptText: async () => null,
  clearChatError: () => {}, onNewSessionReset: () => {}, onActiveSessionDeleted: () => {},
};
function renderList() {
  const auth = createMemoryAuthSession(() => {}, "alice-a");
  return renderHook((props: { auth: AuthSession | null; user: User }) => useSessionList({ ...callbacks, ...props, authSession: auth }), { initialProps: { auth, user: alice } });
}

it.each(["focus", "visibility", "poll"])("OD-P1 reset retires %s reads without unlocking a newer request", async trigger => {
  if (trigger === "poll") vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const list = vi.spyOn(api, "listSessions").mockResolvedValue([]);
  const view = renderList();
  await waitFor(() => expect(view.result.current.serverListSettled).toBe(true));
  const old = deferred<SessionMeta[]>();
  const fresh = deferred<SessionMeta[]>();
  list.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => fresh.promise);
  act(() => {
    if (trigger === "poll") vi.advanceTimersByTime(60_000);
    else if (trigger === "visibility") document.dispatchEvent(new Event("visibilitychange"));
    else window.dispatchEvent(new Event("focus"));
  });
  expect(list).toHaveBeenCalledTimes(2);
  act(() => view.result.current.reset());
  act(() => window.dispatchEvent(new Event("focus")));
  expect(list).toHaveBeenCalledTimes(3);
  await act(async () => { old.resolve([meta("alice-old")]); await old.promise; });
  expect(view.result.current.sessions).toEqual([]);
  act(() => window.dispatchEvent(new Event("focus")));
  expect(list).toHaveBeenCalledTimes(3);
  await act(async () => { fresh.resolve([meta("current")]); await fresh.promise; });
  expect(view.result.current.sessions.map(s => s.id)).toEqual(["current"]);
});

it("OD-P1 disabling auth retires an in-flight focus read even before reset", async () => {
  const list = vi.spyOn(api, "listSessions").mockResolvedValue([]);
  const view = renderList();
  await waitFor(() => expect(view.result.current.serverListSettled).toBe(true));
  const old = deferred<SessionMeta[]>();
  list.mockImplementationOnce(() => old.promise);
  act(() => window.dispatchEvent(new Event("focus")));
  view.rerender({ auth: null, user: alice });
  await act(async () => { old.resolve([meta("alice-old")]); await old.promise; });
  expect(view.result.current.sessions).toEqual([]);
});

it("OD-P1 resetting an initial list does not let its old completion settle the new lifecycle", async () => {
  const old = deferred<SessionMeta[]>();
  vi.spyOn(api, "listSessions").mockImplementation(() => old.promise);
  const view = renderList();
  act(() => view.result.current.reset());
  await act(async () => { old.resolve([meta("alice-old")]); await old.promise; });
  expect(view.result.current.sessions).toEqual([]);
  expect(view.result.current.serverListSettled).toBe(false);
});

it.each(["page", "archive"])("OD-P1 reset retires a pending %s list", async mode => {
  vi.spyOn(api, "listSessions").mockResolvedValue([meta("initial")]);
  const old = deferred<Awaited<ReturnType<typeof api.listSessionsPage>>>();
  vi.spyOn(api, "listSessionsPage").mockImplementation(() => old.promise);
  const view = renderList();
  await waitFor(() => expect(view.result.current.serverListSettled).toBe(true));
  let request!: Promise<void>;
  act(() => { request = mode === "page" ? view.result.current.loadMoreSessions() : view.result.current.loadArchivedSessions(); });
  act(() => view.result.current.reset());
  await act(async () => { old.resolve({ sessions: [meta("alice-old")] }); await request; });
  expect(view.result.current.sessions).toEqual([]);
  expect(view.result.current.hasMoreSessions).toBe(true);
  expect(view.result.current.loadMoreError).toBe(false);
});

it("OD-P1 explicit account acceptance fences a real old HTTP poll without losing Bob login", async () => {
  const old = deferred<Response>();
  const reply = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
  const wireUser = (id: string) => ({ id, role: "user", email: `${id}@example.invalid`, display_name: id });
  let lists = 0;
  const fetcher = vi.fn<typeof fetch>(async url => {
    if (String(url) === "/api/auth/login") return reply({ access_token: "alice-a", user: wireUser("alice") });
    if (String(url) === "/api/me") return reply({ user: wireUser("bob") });
    if (String(url).startsWith("/api/sessions/list")) return ++lists === 2 ? old.promise : reply({ sessions: lists === 1 ? [] : [meta("bob-current")] });
    return reply({ accepted: true });
  });
  vi.stubGlobal("fetch", fetcher);
  const onClearAuth = vi.fn();
  const view = renderHook(() => {
    const reset = useRef(() => {});
    const auth = useAuth({ demo: false, initialUser: null, onClearAuth, onLoginSuccess: () => reset.current() });
    const list = useSessionList({ ...callbacks, auth: auth.auth, authSession: auth.authRef.current, user: auth.user });
    reset.current = list.reset;
    return { auth, list };
  });
  await act(async () => { await view.result.current.auth.login("fixture", "fixture", "fixture"); });
  await waitFor(() => expect(view.result.current.list.serverListSettled).toBe(true));
  act(() => window.dispatchEvent(new Event("focus")));
  expect(lists).toBe(2);
  act(() => { view.result.current.auth.authRef.current.commitToken(1, "bob-b"); });
  await waitFor(() => expect(view.result.current.auth.pendingAccount?.id).toBe("bob"));
  act(() => view.result.current.auth.acceptAccountSwitch());
  await waitFor(() => expect(view.result.current.list.sessions.map(s => s.id)).toEqual(["bob-current"]));
  await act(async () => { old.resolve(reply({ sessions: [meta("alice-private")] })); await old.promise; });
  expect(view.result.current.list.sessions.map(s => s.id)).toEqual(["bob-current"]);
  expect(view.result.current.auth.authRef.current.snapshot()).toEqual({ token: "bob-b", epoch: 2 });
  expect(view.result.current.auth.resolvedIdentity?.userId).toBe("bob");
  expect(onClearAuth).not.toHaveBeenCalled();
  expect(fetcher.mock.calls.some(([url]) => String(url) === "/api/auth/logout")).toBe(false);
});
