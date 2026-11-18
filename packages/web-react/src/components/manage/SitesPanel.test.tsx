import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../../lib/api";
import { createMemoryAuthSession } from "../../lib/authSession";
import type { AuthSession, UserSiteItem } from "../../lib/types";
import { ToastProvider, TooltipProvider } from "../ui";
import { SitesPanel } from "./SitesPanel";

const auth: AuthSession = createMemoryAuthSession(() => {}, "tok");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mountPanel(onAskInChat?: (text: string) => void) {
  return render(
    <ToastProvider>
      <TooltipProvider>
        <SitesPanel auth={auth} onAskInChat={onAskInChat} />
      </TooltipProvider>
    </ToastProvider>,
  );
}

const SAMPLE_SITE: UserSiteItem = {
  id: "site-1",
  slug: "demo-app",
  url: "https://demo-app.congjianai.com",
  title: "演示站点",
  visibility: "public",
  spaMode: true,
  fileCount: 4,
  sizeBytes: 24576,
  contentSha256: "abc",
  edgeRevision: 2,
  createdAt: "2026-11-18T09:00:00.000Z",
  updatedAt: "2026-11-18T09:30:00.000Z",
  lastPublishedAt: "2026-11-18T09:30:00.000Z",
};

describe("SitesPanel", () => {
  test("空态时显示引导并支持在对话中创建网站", async () => {
    vi.spyOn(api, "listSites").mockResolvedValue({
      enabled: true,
      baseDomain: "congjianai.com",
      maxPerUser: 50,
      maxSiteBytes: 26214400,
      sites: [],
    });
    const onAskInChat = vi.fn();
    mountPanel(onAskInChat);

    expect(await screen.findByText("还没有已发布的网站")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "在对话中创建网站" }));
    expect(onAskInChat).toHaveBeenCalledWith("帮我创建一个网站并发布到持久化域名");
  });

  test("展示站点列表、支持更新可见性/口令以及确认删除", async () => {
    vi.spyOn(api, "listSites").mockResolvedValue({
      enabled: true,
      baseDomain: "congjianai.com",
      maxPerUser: 50,
      maxSiteBytes: 26214400,
      sites: [SAMPLE_SITE],
    });
    const updatedSite: UserSiteItem = {
      ...SAMPLE_SITE,
      visibility: "password",
      title: "内部测试",
      edgeRevision: 3,
    };
    const updateSpy = vi.spyOn(api, "updateSite").mockResolvedValue({ site: updatedSite });
    const deleteSpy = vi.spyOn(api, "deleteSite").mockResolvedValue({ ok: true, slug: "demo-app" });

    mountPanel();

    expect(await screen.findByText("演示站点")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "https://demo-app.congjianai.com" });
    expect(link).toHaveAttribute("href", "https://demo-app.congjianai.com");
    expect(screen.getByText("4 个文件")).toBeInTheDocument();
    expect(screen.getByText("公开")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "管理「演示站点」" }));
    fireEvent.change(screen.getByLabelText("站点标题"), { target: { value: "内部测试" } });
    fireEvent.change(screen.getByLabelText("访问权限"), { target: { value: "password" } });
    fireEvent.change(screen.getByLabelText("访问口令"), { target: { value: "pass5678" } });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(auth, "demo-app", {
        title: "内部测试",
        visibility: "password",
        password: "pass5678",
        spaMode: true,
      });
    });
    expect(await screen.findByText("内部测试")).toBeInTheDocument();
    expect(screen.getByText("口令保护")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "管理「内部测试」" }));
    fireEvent.click(screen.getByRole("button", { name: "删除站点" }));
    expect(await screen.findByText("删除站点「内部测试」？")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "删除" }));

    await waitFor(() => {
      expect(deleteSpy).toHaveBeenCalledWith(auth, "demo-app");
    });
    await waitFor(() => {
      expect(screen.queryByText("内部测试")).not.toBeInTheDocument();
    });
  });
});
