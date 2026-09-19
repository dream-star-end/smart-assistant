import { act, cleanup, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ToastProvider } from "../components/ui";
import { ApiError, api } from "../lib/api";
import { createMemoryAuthSession } from "../lib/authSession";
import type { ChatProject } from "../lib/types";
import { PROJECTS_RETRY_MS, useChatProjects } from "./useChatProjects";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function proj(id: string, sortOrder = 0): ChatProject {
  return { id, name: id, sortOrder, createdAt: 1, updatedAt: 1, sessionCount: 0 };
}

// S-12：项目列表一次失败此前只 console.warn 且不重试 → 分组会话整个会话期在侧栏消失。
describe("useChatProjects 列表拉取失败", () => {
  test("失败 → toast 告知 + projectsLoadFailed；到点自动重试成功后回填并清失败态", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const list = vi
      .spyOn(api, "listChatProjects")
      .mockRejectedValueOnce(new ApiError({ status: 503, message: "cold start" }))
      .mockResolvedValueOnce([proj("p-b", 1), proj("p-a", 0)]);
    const auth = createMemoryAuthSession(() => {}, "tok");
    const { result } = renderHook(
      () =>
        useChatProjects({
          demo: false,
          auth,
          authSession: auth,
          userId: "u1",
          promptText: async () => null,
          confirmDialog: async () => true,
        }),
      { wrapper: ToastProvider },
    );
    await waitFor(() => expect(result.current.projectsLoadFailed).toBe(true));
    expect(screen.getByRole("alert").textContent).toContain("项目列表加载失败");
    expect(result.current.projects).toEqual([]);

    await act(async () => {
      vi.advanceTimersByTime(PROJECTS_RETRY_MS + 10);
    });
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.projectsLoadFailed).toBe(false));
    expect(result.current.projects.map((p) => p.id)).toEqual(["p-a", "p-b"]);
    // 连续失败不刷屏：只有首次失败的一条 alert。
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  test("切回前台（visibilitychange）立刻重试；reloadProjects 可手动重拉", async () => {
    const list = vi
      .spyOn(api, "listChatProjects")
      .mockRejectedValueOnce(new ApiError({ status: 500, message: "boom" }))
      .mockRejectedValueOnce(new ApiError({ status: 500, message: "boom again" }))
      .mockResolvedValue([proj("p-a")]);
    const auth = createMemoryAuthSession(() => {}, "tok");
    const { result } = renderHook(() =>
      useChatProjects({
        demo: false,
        auth,
        authSession: auth,
        userId: "u1",
        promptText: async () => null,
        confirmDialog: async () => true,
      }),
    );
    await waitFor(() => expect(result.current.projectsLoadFailed).toBe(true));
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      // 让第二次（仍失败）的请求完全落定，再手动重拉。
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(list).toHaveBeenCalledTimes(2);
    expect(result.current.projectsLoadFailed).toBe(true);
    await act(async () => {
      await result.current.reloadProjects();
    });
    expect(list).toHaveBeenCalledTimes(3);
    expect(result.current.projectsLoadFailed).toBe(false);
    expect(result.current.projects.map((p) => p.id)).toEqual(["p-a"]);
  });

  test("成功路径不进入失败态，也不装重试计时器", async () => {
    const list = vi.spyOn(api, "listChatProjects").mockResolvedValue([proj("p-a")]);
    const auth = createMemoryAuthSession(() => {}, "tok");
    const { result } = renderHook(() =>
      useChatProjects({
        demo: false,
        auth,
        authSession: auth,
        userId: "u1",
        promptText: async () => null,
        confirmDialog: async () => true,
      }),
    );
    await waitFor(() => expect(result.current.projects).toHaveLength(1));
    expect(result.current.projectsLoadFailed).toBe(false);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(list).toHaveBeenCalledTimes(1);
  });
});

// UCP-01：项目排序此前对 N 个项目并发 N 个 PATCH，任一失败再并发 N 个回滚（请求风暴 + 服务端中间态）。
describe("useChatProjects reorderProjects 串行写入", () => {
  function setup(initial: ChatProject[]) {
    vi.spyOn(api, "listChatProjects").mockResolvedValue(initial);
    const auth = createMemoryAuthSession(() => {}, "tok");
    return renderHook(
      () =>
        useChatProjects({
          demo: false,
          auth,
          authSession: auth,
          userId: "u1",
          promptText: async () => null,
          confirmDialog: async () => true,
        }),
      { wrapper: ToastProvider },
    );
  }

  test("只 PATCH sortOrder 真变了的项目，且一条接一条串行发出", async () => {
    const { result } = setup([proj("p-a", 0), proj("p-b", 1), proj("p-c", 2)]);
    await waitFor(() => expect(result.current.projects).toHaveLength(3));
    let inFlight = 0;
    let maxInFlight = 0;
    const patch = vi.spyOn(api, "patchChatProject").mockImplementation(async (_a, id, body) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 0));
      inFlight -= 1;
      return { ...proj(id), ...body } as ChatProject;
    });
    await act(async () => {
      // 把 p-c 挪到最前：p-a / p-b 各后移一位，三条都变了。
      await result.current.reorderProjects(["p-c", "p-a", "p-b"]);
    });
    expect(patch).toHaveBeenCalledTimes(3);
    expect(maxInFlight).toBe(1);
    expect(patch.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ["p-c", { sortOrder: 0 }],
      ["p-a", { sortOrder: 1 }],
      ["p-b", { sortOrder: 2 }],
    ]);
    expect(result.current.projects.map((p) => p.id)).toEqual(["p-c", "p-a", "p-b"]);

    patch.mockClear();
    await act(async () => {
      // 只交换后两位：p-c 位置不变，不再为它发一次无意义的 PATCH。
      await result.current.reorderProjects(["p-c", "p-b", "p-a"]);
    });
    expect(patch.mock.calls.map((c) => c[1])).toEqual(["p-b", "p-a"]);
  });

  test("中途失败：在失败点停下，只回滚已改成功的那几条，本地顺序恢复并 toast", async () => {
    const { result } = setup([proj("p-a", 0), proj("p-b", 1), proj("p-c", 2)]);
    await waitFor(() => expect(result.current.projects).toHaveLength(3));
    const patch = vi.spyOn(api, "patchChatProject").mockImplementation(async (_a, id, body) => {
      if (id === "p-a" && body.sortOrder === 1) {
        throw new ApiError({ status: 500, message: "boom" });
      }
      return { ...proj(id), ...body } as ChatProject;
    });
    await act(async () => {
      await expect(result.current.reorderProjects(["p-c", "p-a", "p-b"])).rejects.toThrow("boom");
      await new Promise((r) => setTimeout(r, 0));
    });
    // 正向：p-c 成功、p-a 失败即停，p-b 根本没发；回滚：只回滚 p-c 到原来的 2。
    expect(patch.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ["p-c", { sortOrder: 0 }],
      ["p-a", { sortOrder: 1 }],
      ["p-c", { sortOrder: 2 }],
    ]);
    expect(result.current.projects.map((p) => p.id)).toEqual(["p-a", "p-b", "p-c"]);
    expect(screen.getByRole("alert").textContent).toContain("调整项目顺序失败");
  });
});

describe("useChatProjects onCreated", () => {
  test("创建成功后 onCreated 收到 created", async () => {
    const created: ChatProject = {
      id: "p-real",
      name: "新项目",
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
      sessionCount: 0,
    };
    vi.spyOn(api, "listChatProjects").mockResolvedValue([]);
    vi.spyOn(api, "createChatProject").mockResolvedValue(created);
    const onCreated = vi.fn();
    const auth = createMemoryAuthSession(() => {}, "tok");
    const { result } = renderHook(() =>
      useChatProjects({
        demo: false,
        auth,
        authSession: auth,
        userId: "u1",
        promptText: async () => "新项目",
        confirmDialog: async () => true,
        onCreated,
      }),
    );
    await waitFor(() => expect(api.listChatProjects).toHaveBeenCalled());
    await act(async () => {
      await result.current.createProjectPrompt();
    });
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledWith(created);
  });

  test("demo 分支创建不调用 onCreated", async () => {
    const onCreated = vi.fn();
    const auth = createMemoryAuthSession(() => {}, "tok");
    const { result } = renderHook(() =>
      useChatProjects({
        demo: true,
        auth,
        authSession: auth,
        userId: "u1",
        promptText: async () => "演示项目",
        confirmDialog: async () => true,
        onCreated,
      }),
    );
    await act(async () => {
      await result.current.createProjectPrompt();
    });
    expect(onCreated).not.toHaveBeenCalled();
  });
});
