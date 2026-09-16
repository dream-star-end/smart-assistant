import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AuthSession } from "../../lib/types";
import { createMemoryAuthSession } from "../../lib/authSession";

const getGithubLink = vi.fn();
const listGithubRepos = vi.fn();
const listGithubBranches = vi.fn();
const startGithubOAuth = vi.fn();
vi.mock("../../lib/api", () => ({
  api: {
    getGithubLink: (...a: unknown[]) => getGithubLink(...a),
    listGithubRepos: (...a: unknown[]) => listGithubRepos(...a),
    listGithubBranches: (...a: unknown[]) => listGithubBranches(...a),
    startGithubOAuth: (...a: unknown[]) => startGithubOAuth(...a),
    unlinkGithub: vi.fn(),
  },
  apiErrorMessage: (_e: unknown, fallback: string) => fallback,
}));

import { GithubRepoModal } from "./GithubRepoModal";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const auth: AuthSession = createMemoryAuthSession(() => {}, "t");

function renderModal(over: Partial<Parameters<typeof GithubRepoModal>[0]> = {}) {
  const onConfirm = vi.fn().mockResolvedValue(undefined);
  const onUnbind = vi.fn().mockResolvedValue(undefined);
  render(
    <GithubRepoModal
      open
      auth={auth}
      sessionId="s1"
      selection={null}
      onClose={() => {}}
      onConfirm={onConfirm}
      onUnbind={onUnbind}
      toast={() => {}}
      {...over}
    />,
  );
  return { onConfirm, onUnbind };
}

describe("GithubRepoModal", () => {
  test("未关联账号：显示「连接 GitHub」", async () => {
    getGithubLink.mockResolvedValue({ linked: false });
    renderModal();
    expect(await screen.findByRole("button", { name: /连接 GitHub/ })).toBeInTheDocument();
    expect(listGithubRepos).not.toHaveBeenCalled();
  });

  test("role=dialog 带 data-product-feature=github-repository", async () => {
    getGithubLink.mockResolvedValue({ linked: false });
    renderModal();
    expect(await screen.findByRole("dialog")).toHaveAttribute(
      "data-product-feature",
      "github-repository",
    );
  });

  test("已关联：列仓库 → 选仓 → 列分支 → 确认绑定回调", async () => {
    getGithubLink.mockResolvedValue({ linked: true, login: "octocat", scopes: "repo" });
    listGithubRepos.mockResolvedValue([
      { owner: { login: "octocat" }, name: "hello", full_name: "octocat/hello", default_branch: "main", private: false },
    ]);
    listGithubBranches.mockResolvedValue([
      { name: "main", commit: { sha: "a" } },
      { name: "dev", commit: { sha: "b" } },
    ]);
    const { onConfirm } = renderModal();

    // 账号展示
    expect(await screen.findByText("@octocat")).toBeInTheDocument();
    // 仓库列表
    const repoBtn = await screen.findByText("hello");
    fireEvent.click(repoBtn);
    // 分支加载后 default 自动选中 → 确认按钮可用
    await waitFor(() => expect(screen.getByText("dev")).toBeInTheDocument());
    const confirmBtn = screen.getByRole("button", { name: "确认绑定" });
    await waitFor(() => expect(confirmBtn).toBeEnabled());
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith("octocat", "hello", "main"));
  });

  test("账号状态加载失败：显示加载失败且没有「连接 GitHub」", async () => {
    getGithubLink.mockRejectedValue(new Error("network down"));
    renderModal();
    expect(await screen.findByText(/加载失败/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /连接 GitHub/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });

  // GH-02：草稿态（无 sessionId）「确认绑定」禁用此前没有任何提示。
  test("草稿态无 sessionId：给出「先发送一条消息」提示，确认按钮禁用并带 title", async () => {
    getGithubLink.mockResolvedValue({ linked: true, login: "octocat", scopes: "repo" });
    listGithubRepos.mockResolvedValue([]);
    renderModal({ sessionId: undefined });
    expect(await screen.findByText(/先发送一条消息创建会话/)).toBeInTheDocument();
    const confirmBtn = screen.getByRole("button", { name: "确认绑定" });
    expect(confirmBtn).toBeDisabled();
    expect(confirmBtn).toHaveAttribute("title", expect.stringContaining("先发送一条消息"));
  });

  test("有 sessionId 时不出现草稿态提示", async () => {
    getGithubLink.mockResolvedValue({ linked: true, login: "octocat", scopes: "repo" });
    listGithubRepos.mockResolvedValue([]);
    renderModal();
    await screen.findByText("@octocat");
    expect(screen.queryByText(/先发送一条消息创建会话/)).toBeNull();
  });

  // GH-03 / GH-04 / GH-05：scope 可读化、搜索框有名、列表按钮语义。
  test("账号栏 scopes 映射为可读文案；搜索框有 aria-label；仓库按钮 type=button 且选中态 aria-pressed", async () => {
    getGithubLink.mockResolvedValue({ linked: true, login: "octocat", scopes: "repo,read:user" });
    listGithubRepos.mockResolvedValue([
      { owner: { login: "octocat" }, name: "hello", full_name: "octocat/hello", default_branch: "main", private: false },
      { owner: { login: "octocat" }, name: "world", full_name: "octocat/world", default_branch: "main", private: true },
    ]);
    listGithubBranches.mockResolvedValue([{ name: "main", commit: { sha: "a" } }]);
    renderModal();
    expect(await screen.findByText("读写仓库 · 读取账号信息")).toBeInTheDocument();
    expect(screen.queryByText("repo,read:user")).toBeNull();
    expect(screen.getByRole("textbox", { name: "搜索仓库" })).toBeInTheDocument();
    const hello = (await screen.findByText("hello")).closest("button")!;
    expect(hello).toHaveAttribute("type", "button");
    expect(hello).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(hello);
    await waitFor(() => expect(hello).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByText("world").closest("button")).toHaveAttribute("aria-pressed", "false");
  });

  test("已有绑定：显示「解除当前绑定」", async () => {
    getGithubLink.mockResolvedValue({ linked: true, login: "octocat", scopes: "repo" });
    listGithubRepos.mockResolvedValue([]);
    renderModal({
      selection: {
        selected: true,
        owner: "octocat",
        repo: "hello",
        branch: "main",
        status: "ready",
        selection_version: 1,
      },
    });
    expect(await screen.findByRole("button", { name: /解除当前绑定/ })).toBeInTheDocument();
  });
});
