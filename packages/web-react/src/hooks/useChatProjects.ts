import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "../components/ui";
import { api } from "../lib/api";
import type { AuthSession, ChatProject } from "../lib/types";

export function projectCollapsedStorageKey(userId: string): string {
  return `oc_v5_sidebar_project_collapsed:${userId}`;
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
    danger?: boolean;
  }) => Promise<boolean>;
  /** 项目软删：立刻把其下会话改为未分组，返回被移出的会话 id（失败回滚用）。 */
  onUngroupProjectSessions?: (projectId: string) => string[];
  /** 删除项目失败：把 sessionIds 重新挂回该项目。 */
  onRestoreProjectSessions?: (projectId: string, sessionIds: string[]) => void;
};

export type UseChatProjects = {
  projects: ChatProject[];
  collapsedIds: Set<string>;
  toggleCollapsed: (projectId: string) => void;
  createProjectPrompt: () => Promise<void>;
  renameProjectPrompt: (p: ChatProject) => Promise<void>;
  deleteProjectConfirm: (p: ChatProject) => Promise<void>;
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
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() =>
    userId ? readCollapsed(userId) : new Set(),
  );

  useEffect(() => {
    setCollapsedIds(userId ? readCollapsed(userId) : new Set());
  }, [userId]);

  useEffect(() => {
    if (demo) return;
    if (!auth || !userId) {
      setProjects([]);
      return;
    }
    let cancelled = false;
    api
      .listChatProjects(cbRef.current.authSession)
      .then((list) => {
        if (!cancelled)
          setProjects(
            list.slice().sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt),
          );
      })
      .catch((e) => {
        console.warn("listChatProjects failed", e);
      });
    return () => {
      cancelled = true;
    };
  }, [demo, auth, userId]);

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

  return {
    projects,
    collapsedIds,
    toggleCollapsed,
    createProjectPrompt,
    renameProjectPrompt,
    deleteProjectConfirm,
  };
}
