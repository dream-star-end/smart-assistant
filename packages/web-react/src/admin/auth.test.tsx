import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { useAdminAuth } from "./auth";

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("admin boot recovers from a transient refresh failure without becoming unauthenticated", async () => {
  let refreshCalls = 0;
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes("/api/auth/refresh")) {
      refreshCalls += 1;
      if (refreshCalls === 1) {
        return response({ error: { code: "UPSTREAM_UNAVAILABLE", message: "temporary outage" } }, 503);
      }
      return response({ access_token: "admin-token", access_exp: 999, remember: true });
    }
    if (String(url).includes("/api/me")) {
      return response({ user: { id: "admin-1", email: "admin@example.com", role: "admin", credits: "0" } });
    }
    return response({});
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

  const { result } = renderHook(() => useAdminAuth());
  expect(result.current.ready).toBe(false);
  await waitFor(() => expect(result.current.authed).toBe(true), { timeout: 4_000 });
  expect(result.current.ready).toBe(true);
  expect(result.current.user?.id).toBe("admin-1");
  expect(refreshCalls).toBe(2);
});

test("admin StrictMode effect replay shares one boot refresh flight", async () => {
  let refreshCalls = 0;
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes("/api/auth/refresh")) {
      refreshCalls += 1;
      return response({ access_token: "admin-token", access_exp: 999, remember: true });
    }
    if (String(url).includes("/api/me")) {
      return response({ user: { id: "admin-1", email: "admin@example.com", role: "admin", credits: "0" } });
    }
    return response({});
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

  const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
  const { result } = renderHook(() => useAdminAuth(), { wrapper });
  await waitFor(() => expect(result.current.authed).toBe(true));
  expect(refreshCalls).toBe(1);
});

test("admin boot ends unauthenticated only for an explicit invalid refresh", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response({ error: { code: "VALIDATION", message: "refresh_token is required" } }, 400)) as unknown as typeof fetch,
  );

  const { result } = renderHook(() => useAdminAuth());
  await waitFor(() => expect(result.current.ready).toBe(true));
  expect(result.current.authed).toBe(false);
  expect(result.current.user).toBeNull();
});

test("admin logout hides privileged UI and waits for server revoke before navigation completes", async () => {
  let releaseLogout!: () => void;
  const logoutGate = new Promise<void>((resolve) => {
    releaseLogout = resolve;
  });
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes("/api/auth/refresh")) {
      return response({ access_token: "admin-token", access_exp: 999, remember: true });
    }
    if (String(url).includes("/api/me")) {
      return response({ user: { id: "admin-1", email: "admin@example.com", role: "admin", credits: "0" } });
    }
    if (String(url).includes("/api/auth/logout")) {
      await logoutGate;
      return response({});
    }
    return response({});
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

  const { result } = renderHook(() => useAdminAuth());
  await waitFor(() => expect(result.current.authed).toBe(true));

  let settled = false;
  let loggingOut!: Promise<void>;
  act(() => {
    loggingOut = result.current.logout();
    void loggingOut.then(() => {
      settled = true;
    });
  });
  expect(result.current.ready).toBe(false);
  expect(result.current.authed).toBe(false);
  await Promise.resolve();
  expect(settled).toBe(false);

  releaseLogout();
  await act(async () => {
    await loggingOut;
  });
  expect(settled).toBe(true);
});
