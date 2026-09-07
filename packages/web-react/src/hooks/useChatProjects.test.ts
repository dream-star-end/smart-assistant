import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../lib/api";
import { createMemoryAuthSession } from "../lib/authSession";
import type { ChatProject } from "../lib/types";
import { useChatProjects } from "./useChatProjects";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
