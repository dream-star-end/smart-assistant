import { afterEach, expect, test, vi } from "vitest";
import { api, ApiError } from "../../lib/api";
import type { AuthSession } from "../../lib/types";
import { friendlyRiskFlags } from "./riskFlags";

afterEach(() => {
  vi.unstubAllGlobals();
});

function session(): AuthSession {
  return { getToken: () => "tok", setToken: () => {}, onExpired: () => {} };
}
function ok(body: unknown) {
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => body };
}
function fail(status: number, body: unknown) {
  return { ok: false, status, headers: { get: () => null }, json: async () => body };
}

test("searchMarketplace builds the search URL and returns results+method", async () => {
  const fetchMock = vi.fn(async (_url: string) =>
    ok({ results: [{ slug: "x", name: "X", description: "d", tags: ["t"] }], method: "all" }),
  );
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

  const r = await api.searchMarketplace(session(), "翻译", "skill", 30);
  expect(r.method).toBe("all");
  expect(r.results[0].slug).toBe("x");
  const url = String(fetchMock.mock.calls[0][0]);
  expect(url).toContain("/api/marketplace/search?q=");
  expect(url).toContain(encodeURIComponent("翻译"));
  expect(url).toContain("limit=30");
  expect(url).toContain("kind=skill");
});

test("installMarketplace POSTs versionId to the install route", async () => {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    ok({ ok: true, slug: "x", version: "1.0.0", note: "ok" }),
  );
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

  const r = await api.installMarketplace(session(), "42");
  expect(r.ok).toBe(true);
  const url = fetchMock.mock.calls[0][0];
  const init = fetchMock.mock.calls[0][1] as RequestInit;
  expect(String(url)).toBe("/api/marketplace/install");
  expect(init.method).toBe("POST");
  expect(JSON.parse(String(init.body))).toEqual({ versionId: "42" });
});

test("installMarketplace can include selected agentIds", async () => {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    ok({ ok: true, slug: "x", version: "1.0.0", note: "ok" }),
  );
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

  await api.installMarketplace(session(), "42", ["main", "office-assistant"]);
  const init = fetchMock.mock.calls[0][1] as RequestInit;
  expect(JSON.parse(String(init.body))).toEqual({
    versionId: "42",
    agentIds: ["main", "office-assistant"],
  });
});

test("updateMarketplaceInstallAgents PATCHes the installed slug scope", async () => {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    ok({ ok: true, agentIds: ["office-assistant"] }),
  );
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

  const r = await api.updateMarketplaceInstallAgents(session(), "my-skill", ["office-assistant"]);
  expect(r.agentIds).toEqual(["office-assistant"]);
  const url = fetchMock.mock.calls[0][0];
  const init = fetchMock.mock.calls[0][1] as RequestInit;
  expect(String(url)).toBe("/api/marketplace/installed/my-skill");
  expect(init.method).toBe("PATCH");
  expect(JSON.parse(String(init.body))).toEqual({ agentIds: ["office-assistant"] });
});

test("uninstallMarketplace DELETEs the installed slug", async () => {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ok({ ok: true }));
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  await api.uninstallMarketplace(session(), "my-skill");
  const url = fetchMock.mock.calls[0][0];
  const init = fetchMock.mock.calls[0][1] as RequestInit;
  expect(String(url)).toBe("/api/marketplace/installed/my-skill");
  expect(init.method).toBe("DELETE");
});

test("publishMarketplace surfaces a 422 scan block as ApiError with riskFlags on .body", async () => {
  const riskFlags = [
    { category: "secret", severity: "high", code: "api_key", message: "疑似密钥", block: true },
  ];
  const fetchMock = vi.fn(async (_url: string) =>
    fail(422, { error: { code: "SCAN_BLOCKED", message: "被拦截" }, riskFlags }),
  );
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

  await expect(
    api.publishMarketplace(session(), {
      slug: "x",
      version: "1.0.0",
      name: "X",
      description: "d",
      body: "secret=AKIA...",
      tags: [],
    }),
  ).rejects.toMatchObject({ status: 422, code: "SCAN_BLOCKED" });

  // and .body carries the full payload so the UI can render friendly flags
  try {
    await api.publishMarketplace(session(), {
      slug: "x",
      version: "1.0.0",
      name: "X",
      description: "d",
      body: "secret",
      tags: [],
    });
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    const body = (e as ApiError).body as { riskFlags?: unknown[] };
    expect(body.riskFlags).toHaveLength(1);
  }
});

test("friendlyRiskFlags translates categories and dedups same category to most severe", () => {
  const f = friendlyRiskFlags([
    { category: "secret", severity: "high", code: "a", message: "m1", block: true },
    { category: "secret", severity: "low", code: "b", message: "m2", block: false },
    { category: "size", severity: "low", code: "c", message: "too big", block: false },
  ]);
  // secret collapses to one entry (the blocking one → danger); size stays warning
  expect(f).toHaveLength(2);
  const secret = f.find((x) => x.label.includes("密钥"));
  expect(secret?.tone).toBe("danger");
  const size = f.find((x) => x.message === "too big");
  expect(size?.tone).toBe("warning");
});
