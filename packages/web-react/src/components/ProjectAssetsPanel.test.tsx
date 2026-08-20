import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ToastProvider, TooltipProvider } from "./ui";
import { api } from "../lib/api";
import { createMemoryAuthSession } from "../lib/authSession";
import type { ProjectAsset } from "../lib/types";
import { ProjectAssetsPanel } from "./ProjectAssetsPanel";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function asset(partial: Partial<ProjectAsset> & Pick<ProjectAsset, "id" | "name">): ProjectAsset {
  return {
    projectId: "p1",
    source: "upload",
    sessionId: null,
    url: "/api/media/aaa.txt",
    containerPath: null,
    mime: "text/plain",
    sizeBytes: 12,
    excerpt: null,
    pinned: false,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...partial,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function renderPanel(opts?: {
  projectId?: string | null;
  list?: ProjectAsset[] | Promise<ProjectAsset[]>;
}) {
  const auth = createMemoryAuthSession(() => {}, "tok");
  vi.spyOn(api, "listProjectAssets").mockImplementation(() =>
    opts?.list instanceof Promise ? opts.list : Promise.resolve(opts?.list ?? []),
  );
  render(
    <ToastProvider>
      <TooltipProvider>
        <ProjectAssetsPanel
          projectId={opts?.projectId === undefined ? "p1" : opts.projectId}
          auth={auth}
          authSession={auth}
        />
      </TooltipProvider>
    </ToastProvider>,
  );
  return { auth };
}

function fileInput(): HTMLInputElement {
  const zone = screen.getByRole("button", { name: "上传参考资料" });
  const input = zone.querySelector("input[type='file']");
  expect(input).toBeTruthy();
  return input as HTMLInputElement;
}

describe("ProjectAssetsPanel", () => {
  test("空状态", async () => {
    renderPanel({ list: [] });
    await waitFor(() => expect(screen.getByText("还没有资产")).toBeTruthy());
    expect(screen.getByText(/设为项目知识的资料/)).toBeTruthy();
    expect(screen.getByText("已注入 0/20")).toBeTruthy();
  });

  test("加载态", async () => {
    const list = deferred<ProjectAsset[]>();
    renderPanel({ list: list.promise });
    expect(screen.getByText("加载中…")).toBeTruthy();
    await act(async () => {
      list.resolve([]);
    });
    await waitFor(() => expect(screen.getByText("还没有资产")).toBeTruthy());
  });

  test("错误态可重试", async () => {
    const list = vi.spyOn(api, "listProjectAssets");
    list.mockRejectedValueOnce(new Error("网关超时"));
    list.mockResolvedValueOnce([]);
    const auth = createMemoryAuthSession(() => {}, "tok");
    render(
      <ToastProvider>
        <TooltipProvider>
          <ProjectAssetsPanel projectId="p1" auth={auth} authSession={auth} />
        </TooltipProvider>
      </ToastProvider>,
    );
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.getByText("还没有资产")).toBeTruthy());
    expect(list).toHaveBeenCalledTimes(2);
  });

  test("列表渲染与排序：pinned 置顶", async () => {
    renderPanel({
      list: [
        asset({ id: "u", name: "late.txt", source: "upload", createdAt: 30, pinned: false }),
        asset({
          id: "o",
          name: "report.pdf",
          source: "output",
          sessionId: "s1",
          createdAt: 20,
          pinned: false,
          mime: "application/pdf",
          sizeBytes: 2048,
        }),
        asset({ id: "p", name: "brief.md", createdAt: 10, pinned: true }),
      ],
    });
    await waitFor(() => expect(screen.getByText("brief.md")).toBeTruthy());
    const names = [...document.querySelectorAll("[data-asset-id] .truncate")].map((el) => el.textContent);
    expect(names[0]).toBe("brief.md");
    expect(screen.getByText("已注入")).toBeTruthy();
    expect(screen.getByText("已注入 1/20")).toBeTruthy();
    expect(screen.getAllByText("上传").length).toBeGreaterThan(0);
    expect(screen.getByText("产出")).toBeTruthy();
    expect(screen.getByText("2 KB")).toBeTruthy();
  });

  test("上传成功后出现在列表", async () => {
    const created = asset({ id: "up1", name: "notes.pdf", createdAt: Date.now() });
    vi.spyOn(api, "uploadFile").mockResolvedValue({
      url: "/api/media/n.pdf",
      digest: "n",
      size: 8,
      mimeType: "application/pdf",
    });
    vi.spyOn(api, "createProjectAsset").mockResolvedValue(created);
    renderPanel({ list: [] });
    await waitFor(() => expect(screen.getByText("还没有资产")).toBeTruthy());
    const file = new File(["hello"], "notes.pdf", { type: "application/pdf" });
    fireEvent.change(fileInput(), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByText("notes.pdf")).toBeTruthy());
    expect(screen.queryByText("还没有资产")).toBeNull();
  });

  test("上传失败提示且不污染列表", async () => {
    vi.spyOn(api, "uploadFile").mockRejectedValue(new Error("磁盘满了"));
    vi.spyOn(api, "createProjectAsset");
    renderPanel({ list: [asset({ id: "keep", name: "keep.txt" })] });
    await waitFor(() => expect(screen.getByText("keep.txt")).toBeTruthy());
    fireEvent.change(fileInput(), { target: { files: [new File(["x"], "bad.bin")] } });
    await waitFor(() => expect(screen.getByText("磁盘满了")).toBeTruthy());
    expect(screen.getByText("keep.txt")).toBeTruthy();
    expect(screen.queryByText("bad.bin")).toBeNull();
    expect(api.createProjectAsset).not.toHaveBeenCalled();
  });

  test("pin 切换乐观更新与失败回滚", async () => {
    const patch = deferred<ProjectAsset>();
    vi.spyOn(api, "patchProjectAsset").mockReturnValue(patch.promise);
    renderPanel({
      list: [asset({ id: "a", name: "doc.txt", pinned: false })],
    });
    await waitFor(() => expect(screen.getByText("doc.txt")).toBeTruthy());
    const sw = screen.getByRole("switch", { name: "设为项目知识" });
    expect(sw).toHaveAttribute("data-state", "unchecked");
    fireEvent.click(sw);
    await waitFor(() => expect(screen.getByRole("switch", { name: "取消项目知识" })).toHaveAttribute("data-state", "checked"));
    await act(async () => {
      patch.reject(new Error("后端拒绝"));
    });
    await waitFor(() => expect(screen.getByRole("switch", { name: "设为项目知识" })).toHaveAttribute("data-state", "unchecked"));
  });

  test("删除二次确认：取消保留，确认后移除", async () => {
    vi.spyOn(api, "deleteProjectAsset").mockResolvedValue(undefined);
    renderPanel({ list: [asset({ id: "a", name: "报告.pdf" })] });
    await waitFor(() => expect(screen.getByText("报告.pdf")).toBeTruthy());
    fireEvent.pointerDown(screen.getByRole("button", { name: "报告.pdf 操作" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    await waitFor(() => expect(screen.getByText(/只会从资产列表移除/)).toBeTruthy());
    expect(screen.getByText(/不会删除磁盘上的文件/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByText(/只会从资产列表移除/)).toBeNull());
    expect(screen.getByText("报告.pdf")).toBeTruthy();
    expect(api.deleteProjectAsset).not.toHaveBeenCalled();

    fireEvent.pointerDown(screen.getByRole("button", { name: "报告.pdf 操作" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "移除" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "移除" }));
    await waitFor(() => expect(screen.queryByText("报告.pdf")).toBeNull());
    expect(api.deleteProjectAsset).toHaveBeenCalled();
  });

  test("default 组 projectId=null 也能拉取与上传", async () => {
    const created = asset({ id: "n1", name: "ref.md", projectId: null, createdAt: 9 });
    vi.spyOn(api, "uploadFile").mockResolvedValue({
      url: "/api/media/ref.md",
      digest: "d",
      size: 2,
      mimeType: "text/markdown",
    });
    vi.spyOn(api, "createProjectAsset").mockResolvedValue(created);
    const { auth } = renderPanel({
      projectId: null,
      list: [asset({ id: "exist", name: "exist.txt", projectId: null })],
    });
    await waitFor(() => expect(screen.getByText("exist.txt")).toBeTruthy());
    expect(api.listProjectAssets).toHaveBeenCalledWith(auth, null);
    fireEvent.change(fileInput(), {
      target: { files: [new File(["#"], "ref.md", { type: "text/markdown" })] },
    });
    await waitFor(() => expect(screen.getByText("ref.md")).toBeTruthy());
    expect(api.createProjectAsset).toHaveBeenCalledWith(
      auth,
      expect.objectContaining({ projectId: null, source: "upload", name: "ref.md" }),
    );
  });
});
