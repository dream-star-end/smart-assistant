import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/api";
import { createMemoryAuthSession } from "../../lib/authSession";
import { ToastProvider, TooltipProvider } from "../ui";
import { ProjectFolderBrowser } from "./ProjectFolderBrowser";

const listProjectWorkspace = vi.fn();
const fetchProjectWorkspaceFile = vi.fn();
vi.mock("../../lib/taskboard", () => ({
  taskboardApi: {
    listProjectWorkspace: (...args: unknown[]) => listProjectWorkspace(...args),
    fetchProjectWorkspaceFile: (...args: unknown[]) => fetchProjectWorkspaceFile(...args),
  },
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  listProjectWorkspace.mockReset();
  fetchProjectWorkspaceFile.mockReset();
});

const BOARD = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ROOT = {
  kind: "isolated",
  shared: false,
  path: "",
  truncated: false,
  entries: [
    { name: "docs", type: "dir", size: null, mtime: 1 },
    { name: "README.md", type: "file", size: 4, mtime: 1 },
  ],
};

function renderBrowser(onPinned = vi.fn()) {
  const auth = createMemoryAuthSession(() => {}, "tok");
  render(
    <ToastProvider>
      <TooltipProvider>
        <ProjectFolderBrowser chatProjectId="p1" boardProjectId={BOARD} authSession={auth} onPinned={onPinned} />
      </TooltipProvider>
    </ToastProvider>,
  );
  return { onPinned };
}

describe("ProjectFolderBrowser", () => {
  it("浏览：点文件夹进入，面包屑回到根目录", async () => {
    listProjectWorkspace.mockImplementation(async (_a: unknown, _id: string, path: string) =>
      path === "docs"
        ? { ...ROOT, path: "docs", entries: [{ name: "plan.md", type: "file", size: 4, mtime: 1 }] }
        : ROOT,
    );
    renderBrowser();
    fireEvent.click(await screen.findByRole("button", { name: "docs" }));
    expect(await screen.findByText("plan.md")).toBeInTheDocument();
    expect(listProjectWorkspace).toHaveBeenLastCalledWith(expect.anything(), BOARD, "docs");
    fireEvent.click(screen.getByRole("button", { name: "根目录" }));
    expect(await screen.findByText("README.md")).toBeInTheDocument();
  });

  it("加入常用：取回文件、作为项目文件上传并设为常用", async () => {
    listProjectWorkspace.mockResolvedValue(ROOT);
    fetchProjectWorkspaceFile.mockResolvedValue(new Blob(["# hi"], { type: "text/markdown" }));
    const upload = vi.spyOn(api, "uploadFile").mockResolvedValue({ url: "/api/media/x.md", size: 4 });
    const create = vi.spyOn(api, "createProjectAsset").mockResolvedValue({ id: "a1" } as never);
    const patch = vi.spyOn(api, "patchProjectAsset").mockResolvedValue({ id: "a1" } as never);
    const { onPinned } = renderBrowser();
    fireEvent.click(await screen.findByRole("button", { name: "把 README.md 加入常用" }));
    await waitFor(() => expect(onPinned).toHaveBeenCalled());
    expect(fetchProjectWorkspaceFile).toHaveBeenCalledWith(expect.anything(), BOARD, "README.md");
    expect(upload).toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ projectId: "p1", name: "README.md" }));
    expect(patch).toHaveBeenCalledWith(expect.anything(), "a1", { pinned: true });
  });

  it("没有自己的文件夹（404）时给出说明而不是报错", async () => {
    listProjectWorkspace.mockRejectedValue(Object.assign(new Error("no_workspace"), { status: 404 }));
    renderBrowser();
    expect(await screen.findByText(/这个项目没有自己的文件夹/)).toBeInTheDocument();
  });

  it("共用默认工作区时标明", async () => {
    listProjectWorkspace.mockResolvedValue({ ...ROOT, kind: "default", shared: true });
    renderBrowser();
    expect(await screen.findByText(/共用的默认工作区/)).toBeInTheDocument();
  });
});
