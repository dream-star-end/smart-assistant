import { ChevronRight, Download, File as FileIcon, Folder, FolderOpen, Link2, Pin } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AuthEpochStaleError, api } from "../../lib/api";
import { formatBytes, saveBlob } from "../../lib/chat/download";
import type { ProjectWorkspaceListing } from "../../lib/taskboard";
import type { AuthSession } from "../../lib/types";
import { Alert, Button, Card, EmptyState, IconButton, Skeleton, TimeAgo, useToast } from "../ui";

/**
 * 项目文件夹（只读）：本项目会话干活的那个目录。可以逐级浏览、下载文件、把文件「加入常用」
 * （复制一份到项目文件并设为常用，之后每轮都会带上）。lib/taskboard 动态引入，不进首屏。
 */
export function ProjectFolderBrowser({
  chatProjectId,
  boardProjectId,
  authSession,
  onPinned,
}: {
  chatProjectId: string;
  boardProjectId: string;
  authSession: AuthSession;
  /** 加入常用成功后（让文件列表重拉）。 */
  onPinned?: () => void;
}) {
  const toast = useToast();
  const [path, setPath] = useState("");
  const [listing, setListing] = useState<ProjectWorkspaceListing | null>(null);
  const [error, setError] = useState<"none" | "load" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const authRef = useRef(authSession);
  authRef.current = authSession;

  const load = useCallback(
    async (next: string) => {
      setError(null);
      try {
        const { taskboardApi } = await import("../../lib/taskboard");
        const got = await taskboardApi.listProjectWorkspace(authSession, boardProjectId, next);
        setListing(got);
        setPath(got.path);
      } catch (e) {
        const status = (e as { status?: number }).status;
        setListing(null);
        setError(status === 404 && next === "" ? "none" : "load");
      }
    },
    [authSession, boardProjectId],
  );

  useEffect(() => {
    setPath("");
    setListing(null);
    void load("");
  }, [load]);

  const childPath = (name: string) => (path ? `${path}/${name}` : name);

  const fetchFile = async (rel: string) => {
    const { taskboardApi } = await import("../../lib/taskboard");
    return taskboardApi.fetchProjectWorkspaceFile(authSession, boardProjectId, rel);
  };

  const download = async (name: string) => {
    const rel = childPath(name);
    setBusy(rel);
    try {
      saveBlob(await fetchFile(rel), name);
    } catch {
      toast("下载失败，请稍后再试", "error");
    } finally {
      setBusy(null);
    }
  };

  const pin = async (name: string) => {
    const rel = childPath(name);
    const started = authSession;
    setBusy(rel);
    try {
      const blob = await fetchFile(rel);
      if (authRef.current !== started) return;
      const stored = await api.uploadFile(started, new File([blob], name, { type: blob.type }));
      if (authRef.current !== started) return;
      const asset = await api.createProjectAsset(started, {
        projectId: chatProjectId,
        source: "upload",
        name,
        url: stored.url,
        mime: stored.mimeType,
        size: stored.size ?? blob.size,
        digest: stored.digest,
      });
      await api.patchProjectAsset(started, asset.id, { pinned: true });
      toast(`已把「${name}」加入常用`, "success");
      onPinned?.();
    } catch (e) {
      if (!(e instanceof AuthEpochStaleError)) toast("加入常用失败，请稍后再试", "error");
    } finally {
      setBusy(null);
    }
  };

  const crumbs = path ? path.split("/") : [];

  return (
    <Card padding="md" className="flex min-w-0 flex-col gap-3" data-testid="project-folder">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h2 className="text-section font-semibold text-fg">项目文件夹</h2>
        {listing?.shared && (
          <span className="text-caption text-faint">共用的默认工作区，其他项目的文件也在这里</span>
        )}
      </div>
      {error === "none" ? (
        <p className="text-caption text-faint">这个项目没有自己的文件夹。会话产出的文件在「产出」页签里。</p>
      ) : error === "load" ? (
        <Alert tone="danger" title="项目文件夹没有加载出来">
          <Button size="sm" variant="secondary" onClick={() => void load(path)}>
            重试
          </Button>
        </Alert>
      ) : !listing ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-2/3" />
        </div>
      ) : (
        <>
          <nav aria-label="当前位置" className="flex min-w-0 flex-wrap items-center gap-1 text-meta">
            <button
              type="button"
              className="rounded px-1 text-muted hover:bg-hover hover:text-fg"
              onClick={() => void load("")}
            >
              根目录
            </button>
            {crumbs.map((c, i) => (
              <span key={`${i}-${c}`} className="flex min-w-0 items-center gap-1">
                <ChevronRight size={12} aria-hidden className="text-faint" />
                <button
                  type="button"
                  className="min-w-0 truncate rounded px-1 text-muted hover:bg-hover hover:text-fg"
                  onClick={() => void load(crumbs.slice(0, i + 1).join("/"))}
                >
                  {c}
                </button>
              </span>
            ))}
          </nav>
          {listing.entries.length === 0 ? (
            <EmptyState icon={FolderOpen} title="这个文件夹是空的" />
          ) : (
            <ul className="flex flex-col">
              {listing.entries.map((e) => {
                const rel = childPath(e.name);
                return (
                  <li
                    key={e.name}
                    data-testid="project-folder-entry"
                    className="flex min-h-11 min-w-0 items-center gap-2 rounded-md px-2 hover:bg-hover"
                  >
                    {e.type === "dir" ? (
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        onClick={() => void load(rel)}
                      >
                        <Folder size={16} aria-hidden className="shrink-0 text-muted" />
                        <span className="min-w-0 truncate text-body">{e.name}</span>
                      </button>
                    ) : (
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        {e.type === "link" ? (
                          <Link2 size={16} aria-hidden className="shrink-0 text-faint" />
                        ) : (
                          <FileIcon size={16} aria-hidden className="shrink-0 text-muted" />
                        )}
                        <span className="min-w-0 truncate text-body">{e.name}</span>
                      </span>
                    )}
                    {e.type === "file" && (
                      <>
                        <span className="hidden shrink-0 text-caption text-faint sm:inline">{formatBytes(e.size)}</span>
                        {e.mtime != null && (
                          <TimeAgo value={e.mtime} className="hidden shrink-0 text-caption text-faint sm:inline" />
                        )}
                        <IconButton
                          size="sm"
                          aria-label={`下载 ${e.name}`}
                          disabled={busy === rel}
                          onClick={() => void download(e.name)}
                        >
                          <Download size={14} aria-hidden />
                        </IconButton>
                        <IconButton
                          size="sm"
                          aria-label={`把 ${e.name} 加入常用`}
                          disabled={busy === rel}
                          onClick={() => void pin(e.name)}
                        >
                          <Pin size={14} aria-hidden />
                        </IconButton>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {listing.truncated && <p className="text-caption text-faint">只显示前 500 项。</p>}
        </>
      )}
    </Card>
  );
}
