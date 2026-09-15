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
