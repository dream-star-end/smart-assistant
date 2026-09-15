import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "../components/ui";
import { api } from "../lib/api";
import type { AuthSession, ChatProject } from "../lib/types";

export function projectCollapsedStorageKey(userId: string): string {
  return `oc_v5_sidebar_project_collapsed:${userId}`;
}

export function archivedExpandedStorageKey(userId: string): string {
  return `oc_v5_sidebar_archived_expanded:${userId}`;
}

function readCollapsed(userId: string): Set<string> {
  try {
    const raw = localStorage.getItem(projectCollapsedStorageKey(userId));
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

function writeCollapsed(userId: string, ids: Set<string>): void {
  try {
    localStorage.setItem(projectCollapsedStorageKey(userId), JSON.stringify([...ids]));
  } catch {
    /* private mode / quota */
  }
}

export type UseChatProjectsOptions = {
  demo: boolean;
  auth: AuthSession | null;
  authSession: AuthSession;
  userId: string | undefined;
  promptText: (opts: { title: string; initial?: string; placeholder?: string }) => Promise<
    string | null
  >;
  confirmDialog: (opts: {
    title: string;
    body?: React.ReactNode;
    confirmText?: string;
    altText?: string;
    danger?: boolean;
  }) => Promise<boolean | "alt">;
  /** 项目软删：立刻把其下会话改为未分组，返回被移出的会话 id（失败回滚用）。 */
  onUngroupProjectSessions?: (projectId: string) => string[];
  /** 删除项目失败：把 sessionIds 重新挂回该项目。 */
  onRestoreProjectSessions?: (projectId: string, sessionIds: string[]) => void;
  /** 真实创建成功、乐观行被服务端记录替换后调用（demo 不调）。 */
  onCreated?: (project: ChatProject) => void;
};

/** 项目列表拉取失败后的自动重试间隔（仅在失败态且标签可见时计时）。 */
export const PROJECTS_RETRY_MS = 30_000;

export type UseChatProjects = {
  projects: ChatProject[];
  collapsedIds: Set<string>;
  /** 最近一次列表拉取失败（正在按 PROJECTS_RETRY_MS 自动重试；也可手动 reloadProjects）。 */
  projectsLoadFailed: boolean;
  /** 手动重拉项目列表（失败态的重试入口；成功后清失败态）。 */
  reloadProjects: () => Promise<void>;
  toggleCollapsed: (projectId: string) => void;
  createProjectPrompt: () => Promise<void>;
  renameProjectPrompt: (p: ChatProject) => Promise<void>;
  deleteProjectConfirm: (p: ChatProject) => Promise<void>;
  updateProject: (
    id: string,
    patch: { name?: string; color?: string | null; instructions?: string | null },
  ) => Promise<void>;
  reorderProjects: (orderedIds: string[]) => Promise<void>;
};

/**
 * 侧栏聊天项目：列表拉取 + 新建/重命名/删除 + 折叠态按用户维度落 localStorage。
 * 失败乐观回滚；toast 不可用时 console.warn。
 */
export function useChatProjects(opts: UseChatProjectsOptions): UseChatProjects {
  const { demo, auth, userId } = opts;
  const cbRef = useRef(opts);
  cbRef.current = opts;
  const toast = useToast();

  const [projects, setProjects] = useState<ChatProject[]>([]);
  const [projectsLoadFailed, setProjectsLoadFailed] = useState(false);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() =>
    userId ? readCollapsed(userId) : new Set(),
  );
  // 列表请求代数：登出 / 换号 / 卸载后迟到的响应不再写入。
  const listGenRef = useRef(0);
  const listInflightRef = useRef(false);
  const listFailedRef = useRef(false);

  useEffect(() => {
    setCollapsedIds(userId ? readCollapsed(userId) : new Set());
  }, [userId]);

  const canList = !demo && Boolean(auth) && Boolean(userId);

  // 项目列表拉取。此前一次失败只 console.warn 且不重试：projectId 指向未知项目的会话
  // 整个会话期在侧栏消失（S-12）。现在失败 toast 告知 + 暴露失败态 + 可见时按间隔自动重试。
  const loadProjects = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!canList || listInflightRef.current) return;
      const gen = listGenRef.current;
      listInflightRef.current = true;
      try {
        const list = await api.listChatProjects(cbRef.current.authSession);
        if (gen !== listGenRef.current) return;
        setProjects(
          list.slice().sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt),
        );
        listFailedRef.current = false;
        setProjectsLoadFailed(false);
      } catch (e) {
        if (gen !== listGenRef.current) return;
        console.warn("listChatProjects failed", e);
        // 只在「首次失败」时 toast；自动重试连续失败不刷屏。
        if (!listFailedRef.current && !opts?.silent) {
          toast("项目列表加载失败，会自动重试", "error");
        }
        listFailedRef.current = true;
        setProjectsLoadFailed(true);
      } finally {
        if (gen === listGenRef.current) listInflightRef.current = false;
      }
    },
    [canList, toast],
  );

  useEffect(() => {
    listGenRef.current += 1;
    listInflightRef.current = false;
    listFailedRef.current = false;
    if (demo) return;
    if (!auth || !userId) {
      setProjects([]);
      setProjectsLoadFailed(false);
      return;
    }
    void loadProjects();
  }, [demo, auth, userId, loadProjects]);

  // 失败态下：标签可见时每 PROJECTS_RETRY_MS 重试一次；切回前台 / 窗口聚焦也立刻重试。成功即停。
  useEffect(() => {
    if (!projectsLoadFailed || !canList) return;
    const tick = () => {
      if (document.visibilityState === "visible") void loadProjects({ silent: true });
    };
    const timer = window.setInterval(tick, PROJECTS_RETRY_MS);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("focus", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("focus", tick);
    };
  }, [projectsLoadFailed, canList, loadProjects]);

  const reloadProjects = useCallback(() => loadProjects(), [loadProjects]);

  const toggleCollapsed = useCallback(
    (projectId: string) => {
      setCollapsedIds((cur) => {
        const next = new Set(cur);
        if (next.has(projectId)) next.delete(projectId);
        else next.add(projectId);
        if (userId) writeCollapsed(userId, next);
        return next;
      });
    },
    [userId],
  );

  const createProjectPrompt = useCallback(async () => {
    const name = (
      await cbRef.current.promptText({ title: "新建项目", placeholder: "项目名称" })
    )?.trim();
    if (!name) return;
    const tempId = `local-proj-${Date.now()}`;
    const optimistic: ChatProject = {
      id: tempId,
      name,
      sortOrder: projects.length,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sessionCount: 0,
    };
    setProjects((c) => [...c, optimistic]);
    if (demo || !cbRef.current.auth) return;
    try {
      const created = await api.createChatProject(cbRef.current.authSession, { name });
      setProjects((c) => c.map((p) => (p.id === tempId ? created : p)));
      cbRef.current.onCreated?.(created);
    } catch (e) {
      setProjects((c) => c.filter((p) => p.id !== tempId));
      console.warn("createChatProject failed", e);
      toast("新建项目失败", "error");
    }
  }, [demo, projects.length, toast]);

  const renameProjectPrompt = useCallback(
    async (p: ChatProject) => {
      const name = (
        await cbRef.current.promptText({ title: "重命名项目", initial: p.name })
      )?.trim();
      if (!name || name === p.name) return;
      const prev = p.name;
      setProjects((c) => c.map((x) => (x.id === p.id ? { ...x, name } : x)));
      if (demo) return;
      try {
        const updated = await api.patchChatProject(cbRef.current.authSession, p.id, { name });
        setProjects((c) => c.map((x) => (x.id === p.id ? { ...x, ...updated } : x)));
      } catch (e) {
        setProjects((c) => c.map((x) => (x.id === p.id ? { ...x, name: prev } : x)));
        console.warn("patchChatProject failed", e);
        toast("重命名项目失败，已恢复", "error");
      }
    },
    [demo, toast],
  );

  const deleteProjectConfirm = useCallback(
    async (p: ChatProject) => {
      const ok = await cbRef.current.confirmDialog({
        title: "删除该项目?",
        body: `「${p.name}」将被删除。会话不会被删除，只会移出项目。`,
        confirmText: "删除",
        danger: true,
      });
      if (!ok) return;
      const snapshot = projects;
      setProjects((c) => c.filter((x) => x.id !== p.id));
      const movedIds = cbRef.current.onUngroupProjectSessions?.(p.id) ?? [];
      if (demo) return;
      try {
        await api.deleteChatProject(cbRef.current.authSession, p.id);
      } catch (e) {
        setProjects(snapshot);
        cbRef.current.onRestoreProjectSessions?.(p.id, movedIds);
        console.warn("deleteChatProject failed", e);
        toast("删除项目失败，已恢复", "error");
      }
    },
    [demo, projects, toast],
  );

  const updateProject = useCallback(
    async (
      id: string,
      patch: {
        name?: string;
        color?: string | null;
        instructions?: string | null;
        boardProjectId?: string | null;
      },
    ) => {
      let snapshot: ChatProject[] = [];
      setProjects((c) => {
        snapshot = c;
        return c.map((p) => (p.id === id ? { ...p, ...patch, updatedAt: Date.now() } : p));
      });
      if (demo || !cbRef.current.auth) return;
      try {
        const updated = await api.patchChatProject(cbRef.current.authSession, id, patch);
        setProjects((c) => c.map((x) => (x.id === id ? { ...x, ...updated } : x)));
      } catch (e) {
        setProjects(snapshot);
        console.warn("patchChatProject failed", e);
        toast("更新项目失败，已恢复", "error");
        throw e;
      }
    },
    [demo, toast],
  );

  const reorderProjects = useCallback(
    async (orderedIds: string[]) => {
      const snapshot = projects;
      const byId = new Map(snapshot.map((p) => [p.id, p]));
      const seen = new Set<string>();
      const next: ChatProject[] = [];
      for (const id of orderedIds) {
        const p = byId.get(id);
        if (!p || seen.has(id)) continue;
        seen.add(id);
        next.push({ ...p, sortOrder: seen.size - 1, updatedAt: Date.now() });
      }
      for (const p of snapshot) {
        if (!seen.has(p.id)) next.push(p);
      }
      setProjects(next);
      if (demo || !cbRef.current.auth) return;
      const ids = [...seen];
      try {
        await Promise.all(
          ids.map((id, i) => api.patchChatProject(cbRef.current.authSession, id, { sortOrder: i })),
        );
      } catch (e) {
        setProjects(snapshot);
        void Promise.allSettled(
          snapshot.map((p) =>
            api.patchChatProject(cbRef.current.authSession, p.id, { sortOrder: p.sortOrder }),
          ),
        );
        console.warn("reorderChatProjects failed", e);
        toast("调整项目顺序失败，已恢复", "error");
        throw e;
      }
    },
    [demo, projects, toast],
  );

  return {
    projects,
    collapsedIds,
    projectsLoadFailed,
    reloadProjects,
    toggleCollapsed,
    createProjectPrompt,
    renameProjectPrompt,
    deleteProjectConfirm,
    updateProject,
    reorderProjects,
  };
}
