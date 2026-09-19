import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createMemoryAuthSession } from "../lib/authSession";
import { projectScopeStorageKey } from "../lib/projectScope";
import { taskboardApi, type Project } from "../lib/taskboard";
import { ProjectScopeProvider, useProjectScope } from "./useProjectScope";

const WORK_ID = "work-project-0001";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function workProject(id: string): Project {
  return { id, key: "WP", name: "工作项目" } as Project;
}

function renderScope(opts: { auth?: ReturnType<typeof createMemoryAuthSession> | null } = {}) {
  const auth = opts.auth === undefined ? createMemoryAuthSession(() => {}, "tok") : opts.auth;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ProjectScopeProvider auth={auth} chatProjects={[]} userId="u1">
      {children}
    </ProjectScopeProvider>
  );
  return renderHook(() => useProjectScope(), { wrapper });
}

// taskboard 审计 T-02（P1）：冷启 URL 带 ?project=<工作项目 id> 时 workProjects 尚未加载，
// 此前 effect 立即把找不到的 token 判成 invalid → setToken('all') 并抹掉 URL 参数、覆写 localStorage 记忆。
describe("useProjectScope 冷启 ?project= 深链", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/");
  });

  test("列表到位前不回落 all：URL 参数与记忆保留，列表到位后 scope=work", async () => {
    window.history.replaceState({}, "", `/?project=${WORK_ID}`);
    localStorage.setItem(projectScopeStorageKey("u1"), WORK_ID);
    const list = deferred<Project[]>();
    vi.spyOn(taskboardApi, "listProjects").mockReturnValue(list.promise);

    const { result } = renderScope();
    await waitFor(() => expect(result.current.loading).toBe(true));
    // 尚未到位：对外 token 已是 all（UI fail-closed），但链接与记忆一根毫毛都没动。
    expect(result.current.scope.kind).toBe("all");
    expect(new URLSearchParams(window.location.search).get("project")).toBe(WORK_ID);
    expect(localStorage.getItem(projectScopeStorageKey("u1"))).toBe(WORK_ID);

    await act(async () => {
      list.resolve([workProject(WORK_ID)]);
      await list.promise;
    });
    await waitFor(() => expect(result.current.scope.kind).toBe("work"));
    expect(result.current.token).toBe(WORK_ID);
    expect(result.current.scope.workProject?.id).toBe(WORK_ID);
    expect(new URLSearchParams(window.location.search).get("project")).toBe(WORK_ID);
    expect(localStorage.getItem(projectScopeStorageKey("u1"))).toBe(WORK_ID);
  });

  test("真失效 token（项目已删）在列表到位后仍回落 all 并清掉 URL 参数", async () => {
    window.history.replaceState({}, "", `/?project=${WORK_ID}`);
    vi.spyOn(taskboardApi, "listProjects").mockResolvedValue([workProject("another-project-1")]);

    const { result } = renderScope();
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("project")).toBeNull());
    expect(result.current.scope.kind).toBe("all");
    expect(result.current.token).toBe("all");
    expect(localStorage.getItem(projectScopeStorageKey("u1"))).toBe("all");
  });

  test("列表请求失败：不判失效、不抹链接，下一次成功刷新后命中", async () => {
    window.history.replaceState({}, "", `/?project=${WORK_ID}`);
    const list = vi
      .spyOn(taskboardApi, "listProjects")
      .mockRejectedValueOnce(new Error("board down"))
      .mockResolvedValueOnce([workProject(WORK_ID)]);

    const { result } = renderScope();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.scope.kind).toBe("all");
    expect(new URLSearchParams(window.location.search).get("project")).toBe(WORK_ID);

    await act(async () => {
      await result.current.refreshWorkProjects();
    });
    await waitFor(() => expect(result.current.scope.kind).toBe("work"));
    expect(result.current.token).toBe(WORK_ID);
    expect(new URLSearchParams(window.location.search).get("project")).toBe(WORK_ID);
  });

  test("未登录（auth=null）不校验：保留 URL 参数等登录后再判", async () => {
    window.history.replaceState({}, "", `/?project=${WORK_ID}`);
    const list = vi.spyOn(taskboardApi, "listProjects");

    const { result } = renderScope({ auth: null });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(list).not.toHaveBeenCalled();
    expect(result.current.scope.kind).toBe("all");
    expect(new URLSearchParams(window.location.search).get("project")).toBe(WORK_ID);
  });
});
