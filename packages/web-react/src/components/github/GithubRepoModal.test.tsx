import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AuthSession } from "../../lib/types";

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
}));

import { GithubRepoModal } from "./GithubRepoModal";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const auth: AuthSession = { getToken: () => "t", setToken: () => {}, onExpired: () => {} };

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
