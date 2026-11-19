import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ToastProvider } from "../ui";
import type { AuthSession, SitesSummaryResponse, UserSiteItem } from "../../lib/types";
import { SitesWorkspaceView } from "./SitesWorkspaceView";

const AUTH: AuthSession = {
  snapshot: () => ({
    token: "tok-test",
    epoch: 1,
    user: {
      id: "1",
      email: "user@example.com",
      emailVerified: true,
      role: "user",
      displayName: "Tester",
      avatarUrl: null,
      credits: "100",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }),
  getAccessGeneration: () => 1,
  subscribeAccessGeneration: () => () => {},
  beginIdentity: () => 1,
  commitToken: () => true,
  expire: () => true,
};

const SITE_PUBLIC: UserSiteItem = {
  id: "site-1",
  slug: "demo-app",
  url: "https://demo-app.congjianai.com",
  customDomain: null,
  customDomainStatus: "none",
  customDomainTxtName: null,
  customDomainTxtValue: null,
  originSessionId: "agent:main:webchat:dm:sess-origin",
  hasServerApi: true,
  title: "知行实验室",
  visibility: "public",
  spaMode: true,
  fileCount: 4,
  sizeBytes: 12040,
  contentSha256: "a".repeat(64),
  edgeRevision: 3,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-21T00:00:00.000Z",
  lastPublishedAt: "2026-10-21T00:00:00.000Z",
};

const SITE_PRIVATE: UserSiteItem = {
  ...SITE_PUBLIC,
  id: "site-2",
  slug: "vip-notes",
  url: "https://vip-notes.congjianai.com",
  customDomain: "notes.example.com",
  customDomainStatus: "pending",
  customDomainTxtName: "_oc-site-verify.notes.example.com",
  customDomainTxtValue: "oc-site-verify=site-2.tok",
  title: "私人笔记站",
  visibility: "password",
  hasServerApi: false,
};

const SUMMARY: SitesSummaryResponse = {
  enabled: true,
  baseDomain: "congjianai.com",
  maxPerUser: 20,
  maxSiteBytes: 25 * 1024 * 1024,
  sites: [SITE_PUBLIC, SITE_PRIVATE],
};

function okJson(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe("SitesWorkspaceView", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/sites" && method === "GET") return okJson(SUMMARY);
      if (url === "/api/sites/vip-notes" && method === "GET") {
        return okJson({ site: SITE_PRIVATE, envVars: [] });
      }
      if (url === "/api/sites/vip-notes/verify-domain" && method === "POST") {
        return okJson({ site: { ...SITE_PRIVATE, customDomainStatus: "verified" } });
      }
      if ((url === "/api/sites/demo-app" || url === "/api/sites/demo-app-v2") && method === "GET") {
        const isV2 = url.endsWith("demo-app-v2");
        return okJson({
          site: isV2
            ? { ...SITE_PUBLIC, slug: "demo-app-v2", url: "https://demo-app-v2.congjianai.com" }
            : SITE_PUBLIC,
          envVars: [
            {
              key: "AI_ENABLED",
              value: "true",
              isSecret: false,
              hasValue: true,
              updatedAt: "2026-10-21T00:00:00.000Z",
            },
            {
              key: "DEEPSEEK_API_KEY",
              value: null,
              isSecret: true,
              hasValue: true,
              updatedAt: "2026-10-21T00:00:00.000Z",
            },
          ],
        });
      }
      if (url === "/api/sites/demo-app/env" && method === "PUT") {
        return okJson({
          envVar: {
            key: "DEEPSEEK_API_KEY",
            value: null,
            isSecret: true,
            hasValue: true,
            updatedAt: "2026-10-21T01:00:00.000Z",
          },
          envVars: [
            {
              key: "AI_ENABLED",
              value: "true",
              isSecret: false,
              hasValue: true,
              updatedAt: "2026-10-21T00:00:00.000Z",
            },
            {
              key: "DEEPSEEK_API_KEY",
              value: null,
              isSecret: true,
              hasValue: true,
              updatedAt: "2026-10-21T01:00:00.000Z",
            },
          ],
        });
      }
      if (url === "/api/sites/demo-app/rename" && method === "POST") {
        return okJson({
          site: { ...SITE_PUBLIC, slug: "demo-app-v2", url: "https://demo-app-v2.congjianai.com" },
        });
      }
      if (
        (url.startsWith("/api/sites/demo-app/analytics") ||
          url.startsWith("/api/sites/demo-app-v2/analytics")) &&
        method === "GET"
      ) {
        const is7 = url.includes("days=7");
        return okJson({
          analytics: {
            days: is7 ? 7 : 30,
            totals: { uniqueVisitors: is7 ? 3 : 6, requests: is7 ? 15 : 33, pageViews: is7 ? 5 : 12 },
            series: [
              { date: "2026-10-20", uniqueVisitors: 2, requests: 8, pageViews: 3 },
              { date: "2026-10-21", uniqueVisitors: 1, requests: 7, pageViews: 2 },
            ],
          },
        });
      }
      if (
        (url.startsWith("/api/sites/demo-app/db") ||
          url.startsWith("/api/sites/demo-app-v2/db")) &&
        method === "GET"
      ) {
        const wantsNotes = url.includes("table=notes");
        return okJson({
          db: {
            connected: true,
            hasDatabaseFile: true,
            sizeBytes: 12288,
            tables: [
              { name: "ai_requests", rowCount: 2 },
              { name: "notes", rowCount: 1 },
            ],
            selectedTable: wantsNotes ? "notes" : "ai_requests",
            columns: wantsNotes
              ? [{ name: "title", type: "TEXT", pk: false, notnull: true }]
              : [{ name: "id", type: "TEXT", pk: true, notnull: true }],
            rows: wantsNotes ? [{ title: "First note" }] : [{ id: "req-1" }],
          },
        });
      }
      return okJson({ error: { message: "not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function renderWorkspace(overrides: Partial<Parameters<typeof SitesWorkspaceView>[0]> = {}) {
    return render(
      <ToastProvider>
        <SitesWorkspaceView
          auth={AUTH}
          activeSlug={null}
          onSelectSlug={vi.fn()}
          onCreateInChat={vi.fn()}
          onEditSite={vi.fn()}
          {...overrides}
        />
      </ToastProvider>,
    );
  }

  test("renders list/grid, filters by visibility & search, and selects a site", async () => {
    const onSelectSlug = vi.fn();
    renderWorkspace({ onSelectSlug });

    expect(await screen.findByText("知行实验室")).toBeInTheDocument();
    expect(screen.getByText("私人笔记站")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "口令保护" }));
    expect(screen.queryByText("知行实验室")).not.toBeInTheDocument();
    expect(screen.getByText("私人笔记站")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    fireEvent.change(screen.getByPlaceholderText("搜索站点"), { target: { value: "demo" } });
    expect(screen.getByText("知行实验室")).toBeInTheDocument();
    expect(screen.queryByText("私人笔记站")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "网格视图" }));
    fireEvent.click(screen.getByText("知行实验室"));
    expect(onSelectSlug).toHaveBeenCalledWith("demo-app");
  });

  test("detail view manages secret env vars, slug rename, analytics window toggle, and DB tables", async () => {
    const onSelectSlug = vi.fn();
    const onEditSite = vi.fn();
    function StatefulHost() {
      const [slug, setSlug] = useState<string | null>("demo-app");
      return (
        <ToastProvider>
          <SitesWorkspaceView
            auth={AUTH}
            activeSlug={slug}
            onSelectSlug={(next) => {
              onSelectSlug(next);
              setSlug(next);
            }}
            onCreateInChat={vi.fn()}
            onEditSite={onEditSite}
          />
        </ToastProvider>
      );
    }
    render(<StatefulHost />);

    expect(await screen.findByRole("heading", { name: "知行实验室" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(onEditSite).toHaveBeenCalledWith(expect.objectContaining({ slug: "demo-app" }));

    // Secret env var masked -> 替换密钥 -> PUT /env
    expect(screen.getByDisplayValue("DEEPSEEK_API_KEY")).toBeInTheDocument();
    expect(screen.getByDisplayValue("true")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "替换密钥" }));
    fireEvent.change(screen.getByLabelText("DEEPSEEK_API_KEY 新密钥"), {
      target: { value: "sk-new-key-123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/sites/demo-app/env",
        expect.objectContaining({ method: "PUT" }),
      );
    });

    // Rename slug via 更改 modal
    fireEvent.click(screen.getByRole("button", { name: "更改" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByPlaceholderText("my-awesome-site"), {
      target: { value: "demo-app-v2" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认更改" }));
    await waitFor(() => {
      expect(onSelectSlug).toHaveBeenCalledWith("demo-app-v2");
    });

    // Analytics tab + 7-day toggle
    fireEvent.click(screen.getByRole("tab", { name: "分析" }));
    expect(await screen.findByText("33")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "7 天" }));
    expect(await screen.findByText("15")).toBeInTheDocument();

    // Database tab + table switching
    fireEvent.click(screen.getByRole("tab", { name: "数据库" }));
    expect(await screen.findByText("req-1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /notes/ }));
    expect(await screen.findByText("First note")).toBeInTheDocument();
  });

  test("switching activeSlug unmounts drafts/modals cleanly (P1 #17) and triggers custom domain DNS verify", async () => {
    function SwitchHost() {
      const [slug, setSlug] = useState<string | null>("demo-app");
      return (
        <ToastProvider>
          <button type="button" onClick={() => setSlug("vip-notes")}>
            switch-to-vip
          </button>
          <SitesWorkspaceView
            auth={AUTH}
            activeSlug={slug}
            onSelectSlug={setSlug}
            onCreateInChat={vi.fn()}
            onEditSite={vi.fn()}
          />
        </ToastProvider>
      );
    }
    render(<SwitchHost />);
    expect(await screen.findByRole("heading", { name: "知行实验室" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "添加变量" }));
    fireEvent.change(screen.getByLabelText("新环境变量名"), { target: { value: "LEAK_KEY" } });
    fireEvent.change(screen.getByLabelText("新环境变量值"), { target: { value: "secret-a" } });

    fireEvent.click(screen.getByRole("button", { name: "switch-to-vip" }));
    expect(await screen.findByRole("heading", { name: "私人笔记站" })).toBeInTheDocument();
    expect(screen.queryByLabelText("新环境变量名")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("LEAK_KEY")).not.toBeInTheDocument();

    expect(screen.getByText("待验证 DNS")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "验证域名" }));
    expect(await screen.findByText("已验证")).toBeInTheDocument();
  });
});
