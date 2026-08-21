import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "../components/ui";
import { api, apiErrorMessage } from "../lib/api";
import type { AuthSession, ProjectAsset } from "../lib/types";

/** 项目知识注入上限：超过此数时 UI 提示只注入前 N 条。 */
export const PINNED_INJECT_LIMIT = 20;

export function sortProjectAssets(assets: ProjectAsset[]): ProjectAsset[] {
  return assets.slice().sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

export type UseProjectAssetsOptions = {
  projectId: string | null;
  demo: boolean;
  auth: AuthSession | null;
  authSession: AuthSession;
  /** 为 false 时不拉列表（弹窗未开）。缺省 true。 */
  enabled?: boolean;
  promptText: (opts: { title: string; initial?: string; placeholder?: string }) => Promise<
    string | null
  >;
  confirmDialog: (opts: {
    title: string;
    body?: React.ReactNode;
    confirmText?: string;
    danger?: boolean;
  }) => Promise<boolean>;
};

export type UseProjectAssets = {
  assets: ProjectAsset[];
  loading: boolean;
  error: string | null;
  uploading: boolean;
  reload: () => void;
  uploadFiles: (files: File[]) => Promise<void>;
  setPinned: (id: string, pinned: boolean) => Promise<void>;
  renameAsset: (asset: ProjectAsset) => Promise<void>;
  deleteAsset: (asset: ProjectAsset) => Promise<void>;
};

/**
 * 项目资产：按 projectId 拉取 + 上传 / pin / 重命名 / 删除。
 * 乐观更新 + 失败回滚，写法对齐 useChatProjects.updateProject。
 */
export function useProjectAssets(opts: UseProjectAssetsOptions): UseProjectAssets {
  const { projectId, demo, auth, enabled = true } = opts;
  const cbRef = useRef(opts);
  cbRef.current = opts;
  const toast = useToast();

  const [assets, setAssets] = useState<ProjectAsset[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) return;
    if (demo) {
      setAssets([]);
      setLoading(false);
      setError(null);
      return;
    }
    if (!auth) {
      setAssets([]);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .listProjectAssets(cbRef.current.authSession, projectId)
      .then((list) => {
        if (cancelled) return;
        setAssets(sortProjectAssets(list));
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        console.warn("listProjectAssets failed", e);
        setError(apiErrorMessage(e, "加载资产失败"));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [demo, auth, enabled, projectId, reloadToken]);

  const uploadFiles = useCallback(
    async (files: File[]) => {
      const list = Array.from(files).filter((f) => f && f.size >= 0 && f.name);
      if (list.length === 0) return;
      setUploading(true);
      const pid = cbRef.current.projectId;
      for (const file of list) {
        try {
          if (demo) {
            const now = Date.now();
            const local: ProjectAsset = {
              id: `local-asset-${now}-${Math.random().toString(36).slice(2, 8)}`,
              projectId: pid,
              source: "upload",
              sessionId: null,
              name: file.name,
              url: null,
              containerPath: null,
              mime: file.type || null,
              sizeBytes: file.size,
              excerpt: null,
              pinned: false,
              createdAt: now,
              updatedAt: now,
            };
            setAssets((c) => sortProjectAssets([local, ...c]));
            continue;
          }
          if (!cbRef.current.auth) throw new Error("未登录");
          const uploaded = await api.uploadFile(cbRef.current.authSession, file);
          const created = await api.createProjectAsset(cbRef.current.authSession, {
            projectId: pid,
            source: "upload",
            name: file.name,
            url: uploaded.url,
            mime: uploaded.mimeType,
            size: uploaded.size ?? file.size,
            digest: uploaded.digest,
          });
          setAssets((c) => sortProjectAssets([created, ...c.filter((x) => x.id !== created.id)]));
        } catch (e) {
          console.warn("createProjectAsset failed", e);
          toast(apiErrorMessage(e, `「${file.name}」上传失败`), "error");
        }
      }
      setUploading(false);
    },
    [demo, toast],
  );

  const setPinned = useCallback(
    async (id: string, pinned: boolean) => {
      let snapshot: ProjectAsset[] = [];
      setAssets((c) => {
        snapshot = c;
        return sortProjectAssets(
          c.map((a) => (a.id === id ? { ...a, pinned, updatedAt: Date.now() } : a)),
        );
      });
      if (demo || !cbRef.current.auth) return;
      try {
        const updated = await api.patchProjectAsset(cbRef.current.authSession, id, { pinned });
        setAssets((c) => sortProjectAssets(c.map((x) => (x.id === id ? { ...x, ...updated } : x))));
      } catch (e) {
        setAssets(snapshot);
        console.warn("patchProjectAsset failed", e);
        toast("更新项目知识失败，已恢复", "error");
        throw e;
      }
    },
    [demo, toast],
  );

  const renameAsset = useCallback(
    async (asset: ProjectAsset) => {
      const name = (
        await cbRef.current.promptText({ title: "重命名资产", initial: asset.name })
      )?.trim();
      if (!name || name === asset.name) return;
      let snapshot: ProjectAsset[] = [];
      setAssets((c) => {
        snapshot = c;
        return c.map((x) => (x.id === asset.id ? { ...x, name, updatedAt: Date.now() } : x));
      });
      if (demo || !cbRef.current.auth) return;
      try {
        const updated = await api.patchProjectAsset(cbRef.current.authSession, asset.id, { name });
        setAssets((c) =>
          sortProjectAssets(c.map((x) => (x.id === asset.id ? { ...x, ...updated } : x))),
        );
      } catch (e) {
        setAssets(snapshot);
        console.warn("rename project asset failed", e);
        toast("重命名失败，已恢复", "error");
        throw e;
      }
    },
    [demo, toast],
  );

  const deleteAsset = useCallback(
    async (asset: ProjectAsset) => {
      const ok = await cbRef.current.confirmDialog({
        title: "从资产列表移除？",
        body: `「${asset.name}」只会从资产列表移除，不会删除磁盘上的文件。`,
        confirmText: "移除",
        danger: true,
      });
      if (!ok) return;
      let snapshot: ProjectAsset[] = [];
      setAssets((c) => {
        snapshot = c;
        return c.filter((x) => x.id !== asset.id);
      });
      if (demo || !cbRef.current.auth) return;
      try {
        await api.deleteProjectAsset(cbRef.current.authSession, asset.id);
      } catch (e) {
        setAssets(snapshot);
        console.warn("deleteProjectAsset failed", e);
        toast("移除失败，已恢复", "error");
        throw e;
      }
    },
    [demo, toast],
  );

  return {
    assets,
    loading,
    error,
    uploading,
    reload,
    uploadFiles,
    setPinned,
    renameAsset,
    deleteAsset,
  };
}
