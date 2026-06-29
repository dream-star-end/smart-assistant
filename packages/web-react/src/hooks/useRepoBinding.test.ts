import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AuthSession, RepoSelection } from "../lib/types";

const getRepoSelection = vi.fn();
const putRepoSelection = vi.fn();
const deleteRepoSelection = vi.fn();
vi.mock("../lib/api", () => ({
  api: {
    getRepoSelection: (...a: unknown[]) => getRepoSelection(...a),
    putRepoSelection: (...a: unknown[]) => putRepoSelection(...a),
    deleteRepoSelection: (...a: unknown[]) => deleteRepoSelection(...a),
  },
}));

import { useRepoBinding } from "./useRepoBinding";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const auth: AuthSession = { getToken: () => "t", setToken: () => {}, onExpired: () => {} };

function setup(over: Partial<Parameters<typeof useRepoBinding>[0]> = {}) {
  const sendRepoBind = vi.fn();
  const sendRepoUnbind = vi.fn();
  const toast = vi.fn();
  const hook = renderHook((props: Parameters<typeof useRepoBinding>[0]) => useRepoBinding(props), {
    initialProps: {
      auth,
      activeId: "s1",
      agentId: "main",
      enabled: true,
      sendRepoBind,
      sendRepoUnbind,
      toast,
      ...over,
    },
  });
  return { hook, sendRepoBind, sendRepoUnbind, toast };
}

describe("useRepoBinding", () => {
  test("boot 拉 selection；confirm 走 PUT + sendRepoBind + 本地 pending", async () => {
    getRepoSelection.mockResolvedValue({ selected: false } as RepoSelection);
    putRepoSelection.mockResolvedValue({
      selected: true,
      owner: "o",
      repo: "r",
      branch: "main",
      status: "pending",
      selection_version: 7,
    } as RepoSelection);
    const { hook, sendRepoBind } = setup();
    await waitFor(() => expect(getRepoSelection).toHaveBeenCalled());

    await act(async () => {
      await hook.result.current.confirm("o", "r", "main");
    });
    expect(putRepoSelection).toHaveBeenCalledWith(auth, "s1", { owner: "o", repo: "r", branch: "main" });
    expect(sendRepoBind).toHaveBeenCalledWith("s1", "main", 7);
    expect(hook.result.current.selection).toMatchObject({ selected: true, status: "pending" });
  });

  test("onRepoStatus 版本门控：stale 帧被丢弃，同/新版本更新状态", async () => {
    getRepoSelection.mockResolvedValue({
      selected: true,
      owner: "o",
      repo: "r",
      branch: "main",
      status: "pending",
      selection_version: 5,
    } as RepoSelection);
    const { hook } = setup();
    await waitFor(() => expect(hook.result.current.selection?.selected).toBe(true));

    // stale（version 3 < 已知 5）→ 丢弃，状态保持 pending
    act(() => {
      hook.result.current.onRepoStatus({
        type: "outbound.control.session_repo_status",
        sessionId: "s1",
        selectionVersion: 3,
        status: "ready",
      });
    });
    expect(hook.result.current.selection).toMatchObject({ status: "pending" });

    // 同版本 cloning → 接受
    act(() => {
      hook.result.current.onRepoStatus({
        type: "outbound.control.session_repo_status",
        sessionId: "s1",
        selectionVersion: 5,
        status: "cloning",
      });
    });
    expect(hook.result.current.selection).toMatchObject({ status: "cloning" });
  });

  test("非当前会话的 status 帧不动当前 UI", async () => {
    getRepoSelection.mockResolvedValue({
      selected: true,
      owner: "o",
      repo: "r",
      branch: "main",
      status: "pending",
      selection_version: 2,
    } as RepoSelection);
    const { hook } = setup();
    await waitFor(() => expect(hook.result.current.selection?.selected).toBe(true));
    act(() => {
      hook.result.current.onRepoStatus({
        type: "outbound.control.session_repo_status",
        sessionId: "OTHER",
        selectionVersion: 9,
        status: "ready",
      });
    });
    expect(hook.result.current.selection).toMatchObject({ status: "pending" });
  });

  test("unbind 走 DELETE + sendRepoUnbind + 清 selection", async () => {
    getRepoSelection.mockResolvedValue({
      selected: true,
      owner: "o",
      repo: "r",
      branch: "main",
      status: "ready",
      selection_version: 4,
    } as RepoSelection);
    deleteRepoSelection.mockResolvedValue({ cleared: true });
    const { hook, sendRepoUnbind } = setup();
    await waitFor(() => expect(hook.result.current.selection?.selected).toBe(true));

    await act(async () => {
      await hook.result.current.unbind();
    });
    expect(deleteRepoSelection).toHaveBeenCalledWith(auth, "s1");
    expect(sendRepoUnbind).toHaveBeenCalledWith("s1", 4);
    expect(hook.result.current.selection).toEqual({ selected: false });

    // unbind 后哨兵封顶：迟到的同版本 status 帧被丢弃，不复活 UI
    act(() => {
      hook.result.current.onRepoStatus({
        type: "outbound.control.session_repo_status",
        sessionId: "s1",
        selectionVersion: 4,
        status: "ready",
      });
    });
    expect(hook.result.current.selection).toEqual({ selected: false });
  });
});
