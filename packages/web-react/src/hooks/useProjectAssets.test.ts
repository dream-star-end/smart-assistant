import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../lib/api";
import { createMemoryAuthSession } from "../lib/authSession";
import type { ProjectAsset } from "../lib/types";
import { PINNED_INJECT_LIMIT, sortProjectAssets, useProjectAssets } from "./useProjectAssets";

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

async function renderAssets(opts?: {
  projectId?: string | null;
  confirmResult?: boolean;
  promptResult?: string | null;
  list?: ProjectAsset[] | Promise<ProjectAsset[]>;
}) {
  const confirmCalls: Array<{ title: string; body?: ReactNode }> = [];
  const auth = createMemoryAuthSession(() => {}, "tok");
  vi.spyOn(api, "listProjectAssets").mockImplementation(() =>
    opts?.list instanceof Promise ? opts.list : Promise.resolve(opts?.list ?? []),
  );
  const { result } = renderHook(() =>
    useProjectAssets({
      projectId: opts?.projectId === undefined ? "p1" : opts.projectId,
      demo: false,
      auth,
      authSession: auth,
      promptText: async () => opts?.promptResult ?? null,
      confirmDialog: async (o) => {
        confirmCalls.push(o);
        return opts?.confirmResult ?? true;
      },
    }),
  );
  await waitFor(() => expect(result.current.loading).toBe(false));
  return { result, auth, confirmCalls };
}

describe("sortProjectAssets", () => {
  test("pinned 置顶，组内按 createdAt 倒序", () => {
    const sorted = sortProjectAssets([
      asset({ id: "old", name: "old", createdAt: 1, pinned: false }),
      asset({ id: "new", name: "new", createdAt: 9, pinned: false }),
      asset({ id: "pin-old", name: "pin-old", createdAt: 2, pinned: true }),
      asset({ id: "pin-new", name: "pin-new", createdAt: 8, pinned: true }),
    ]);
    expect(sorted.map((a) => a.id)).toEqual(["pin-new", "pin-old", "new", "old"]);
  });

  test("PINNED_INJECT_LIMIT 为 20", () => {
    expect(PINNED_INJECT_LIMIT).toBe(20);
  });
});

describe("useProjectAssets", () => {
  test("拉取后按 pinned 置顶 + createdAt 倒序", async () => {
    const { result } = await renderAssets({
      list: [
        asset({ id: "a", name: "a", createdAt: 10, pinned: false }),
        asset({ id: "b", name: "b", createdAt: 20, pinned: true }),
        asset({ id: "c", name: "c", createdAt: 30, pinned: false }),
      ],
    });
    expect(result.current.assets.map((a) => a.id)).toEqual(["b", "c", "a"]);
  });

  test("上传成功后出现在列表", async () => {
    const created = asset({ id: "new", name: "notes.pdf", createdAt: Date.now(), pinned: false });
    vi.spyOn(api, "uploadFile").mockResolvedValue({
      url: "/api/media/abc.pdf",
      digest: "abc",
      size: 4,
      mimeType: "application/pdf",
    });
    vi.spyOn(api, "createProjectAsset").mockResolvedValue(created);
    const { result, auth } = await renderAssets({ list: [] });
    const file = new File(["data"], "notes.pdf", { type: "application/pdf" });
    await act(async () => {
      await result.current.uploadFiles([file]);
    });
    expect(api.uploadFile).toHaveBeenCalledWith(auth, file);
    expect(api.createProjectAsset).toHaveBeenCalledWith(
      auth,
      expect.objectContaining({
        projectId: "p1",
        source: "upload",
        name: "notes.pdf",
        url: "/api/media/abc.pdf",
      }),
    );
    expect(result.current.assets.some((a) => a.id === "new")).toBe(true);
  });

  test("上传失败提示且不污染列表", async () => {
    vi.spyOn(api, "uploadFile").mockRejectedValue(new Error("磁盘满了"));
    const create = vi.spyOn(api, "createProjectAsset");
    const { result } = await renderAssets({
      list: [asset({ id: "keep", name: "keep.txt" })],
    });
    await act(async () => {
      await result.current.uploadFiles([new File(["x"], "bad.bin")]);
    });
    expect(result.current.assets.map((a) => a.id)).toEqual(["keep"]);
    expect(create).not.toHaveBeenCalled();
  });

  test("单个失败不影响其它文件", async () => {
    const ok = asset({ id: "ok", name: "ok.txt", createdAt: 50 });
    vi.spyOn(api, "uploadFile").mockImplementation(async (_a, file) => {
      if (file.name === "bad.txt") throw new Error("boom");
      return { url: "/api/media/ok.txt", digest: "ok", size: 1, mimeType: "text/plain" };
    });
    vi.spyOn(api, "createProjectAsset").mockResolvedValue(ok);
    const { result } = await renderAssets({ list: [] });
    await act(async () => {
      await result.current.uploadFiles([
        new File(["b"], "bad.txt"),
        new File(["g"], "ok.txt"),
      ]);
    });
    expect(result.current.assets.map((a) => a.id)).toEqual(["ok"]);
  });

  test("pin 切换乐观更新与失败回滚", async () => {
    const patch = deferred<ProjectAsset>();
    vi.spyOn(api, "patchProjectAsset").mockReturnValue(patch.promise);
    const { result } = await renderAssets({
      list: [asset({ id: "a", name: "a", pinned: false, createdAt: 1 })],
    });
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.setPinned("a", true);
    });
    expect(result.current.assets[0]?.pinned).toBe(true);
    await act(async () => {
      patch.reject(new Error("后端拒绝"));
      await pending.catch(() => undefined);
    });
    expect(result.current.assets[0]?.pinned).toBe(false);
  });

  test("pin 成功后用服务端回写", async () => {
    vi.spyOn(api, "patchProjectAsset").mockResolvedValue(
      asset({ id: "a", name: "a", pinned: true, updatedAt: 99 }),
    );
    const { result } = await renderAssets({
      list: [asset({ id: "a", name: "a", pinned: false })],
    });
    await act(async () => {
      await result.current.setPinned("a", true);
    });
    expect(result.current.assets[0]?.pinned).toBe(true);
    expect(result.current.assets[0]?.updatedAt).toBe(99);
  });

  test("删除需二次确认；取消不发请求", async () => {
    vi.spyOn(api, "deleteProjectAsset").mockResolvedValue(undefined);
    const { result, confirmCalls } = await renderAssets({
      confirmResult: false,
      list: [asset({ id: "a", name: "报告.pdf" })],
    });
    await act(async () => {
      await result.current.deleteAsset(result.current.assets[0]!);
    });
    expect(confirmCalls).toHaveLength(1);
    expect(String(confirmCalls[0]?.body)).toMatch(/只会从资产列表移除/);
    expect(String(confirmCalls[0]?.body)).toMatch(/不会删除磁盘/);
    expect(api.deleteProjectAsset).not.toHaveBeenCalled();
    expect(result.current.assets).toHaveLength(1);
  });

  test("确认删除后乐观移除，失败回滚", async () => {
    const del = deferred<void>();
    vi.spyOn(api, "deleteProjectAsset").mockReturnValue(del.promise);
    const { result } = await renderAssets({
      confirmResult: true,
      list: [asset({ id: "a", name: "a" })],
    });
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.deleteAsset(result.current.assets[0]!);
    });
    await waitFor(() => expect(result.current.assets).toHaveLength(0));
    await act(async () => {
      del.reject(new Error("网络错误"));
      await pending.catch(() => undefined);
    });
    expect(result.current.assets).toHaveLength(1);
  });

  test("default 组 projectId=null 也能拉取与上传", async () => {
    const created = asset({
      id: "u1",
      name: "ref.md",
      projectId: null,
      createdAt: 9,
    });
    vi.spyOn(api, "uploadFile").mockResolvedValue({
      url: "/api/media/ref.md",
      digest: "d",
      size: 2,
      mimeType: "text/markdown",
    });
    vi.spyOn(api, "createProjectAsset").mockResolvedValue(created);
    const { result, auth } = await renderAssets({
      projectId: null,
      list: [asset({ id: "exist", name: "exist.txt", projectId: null })],
    });
    expect(api.listProjectAssets).toHaveBeenCalledWith(auth, null);
    await act(async () => {
      await result.current.uploadFiles([new File(["#"], "ref.md", { type: "text/markdown" })]);
    });
    expect(api.createProjectAsset).toHaveBeenCalledWith(
      auth,
      expect.objectContaining({ projectId: null, source: "upload", name: "ref.md" }),
    );
    expect(result.current.assets.some((a) => a.id === "u1")).toBe(true);
  });
});
