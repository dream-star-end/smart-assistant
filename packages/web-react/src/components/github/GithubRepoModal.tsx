import { Check, GitBranch, Lock, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, apiErrorMessage } from "../../lib/api";
import { githubErrorText } from "../../lib/github";
import { PRODUCT_CAPABILITIES } from "../../lib/productCapabilities";
import type {
  AuthSession,
  GithubBranch,
  GithubLink,
  GithubRepo,
  RepoSelection,
} from "../../lib/types";
import { cn } from "../../lib/utils";
import type { ToastTone } from "../ui";
import { Avatar, Badge, Button, Input, Modal, Spinner } from "../ui";

/**
 * GitHub 仓库绑定 modal（对齐 v3 github.js openGithubModal）。
 *
 * 顶部账号栏：未关联→"连接 GitHub"(POST /auth/github/start + 跳转 OAuth)；已关联→
 * avatar/@login/scopes + 解绑(DELETE /me/github，级联清所有会话选择)。
 * 主体：仓库列表(GET /me/github/repos，搜索过滤、private 标记) + 分支列表(default 顶置)。
 * 底部：确认绑定(经 onConfirm → PUT + WS bind) / 解除当前会话绑定(onUnbind)。
 */
export function GithubRepoModal({
  open,
  auth,
  sessionId,
  selection,
  onClose,
  onConfirm,
  onUnbind,
  onAccountUnlinked,
  toast,
}: {
  open: boolean;
  auth: AuthSession | null;
  sessionId: string | undefined;
  /** 当前会话已有的绑定（决定是否显示"解除绑定"）。*/
  selection: RepoSelection | null;
  onClose: () => void;
  onConfirm: (owner: string, repo: string, branch: string) => Promise<void>;
  onUnbind: () => Promise<void>;
  /** 账号解绑后回调：后端已级联清所有会话选择 → 重新权威化当前会话 selection（清 pill/banner/版本）。*/
  onAccountUnlinked?: () => void;
  toast: (message: string, tone?: ToastTone) => void;
}) {
  const [link, setLink] = useState<GithubLink | null>(null);
  const [linkLoading, setLinkLoading] = useState(false);
  const [linkErr, setLinkErr] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [unlinking, setUnlinking] = useState(false);

  const [repos, setRepos] = useState<GithubRepo[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [reposErr, setReposErr] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const [selRepo, setSelRepo] = useState<GithubRepo | null>(null);
  const [branches, setBranches] = useState<GithubBranch[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [selBranch, setSelBranch] = useState<string | null>(null);

  const [confirming, setConfirming] = useState(false);
  const [unbinding, setUnbinding] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);

  const linked = link?.linked === true;
  const hasBinding = !!selection && selection.selected;

  const loadLink = useCallback(() => {
    if (!auth) return;
    setLinkLoading(true);
    setLinkErr(null);
    return api
      .getGithubLink(auth)
      .then((l) => {
        setLink(l);
        setLinkErr(null);
      })
      .catch((e) => {
        setLinkErr(apiErrorMessage(e, "账号状态加载失败"));
      })
      .finally(() => {
        setLinkLoading(false);
      });
  }, [auth]);

  // 打开：复位瞬态 + 拉账号关联状态。
  useEffect(() => {
    if (!open || !auth) {
      setSearch("");
      setSelRepo(null);
      setBranches([]);
      setSelBranch(null);
      setConfirmUnlink(false);
      return;
    }
    let alive = true;
    setLinkLoading(true);
    setLinkErr(null);
    api
      .getGithubLink(auth)
      .then((l) => {
        if (alive) setLink(l);
      })
      .catch((e) => {
        if (alive) setLinkErr(apiErrorMessage(e, "账号状态加载失败"));
      })
      .finally(() => {
        if (alive) setLinkLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, auth]);

  // 已关联：拉仓库列表。
  useEffect(() => {
    if (!open || !auth || !linked) return;
    let alive = true;
    setReposLoading(true);
    setReposErr(null);
    api
      .listGithubRepos(auth)
      .then((r) => {
        if (alive) setRepos(r);
      })
      .catch((e) => {
        if (alive) setReposErr(apiErrorMessage(e, "加载仓库失败"));
      })
      .finally(() => {
        if (alive) setReposLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, auth, linked]);

  const onPickRepo = useCallback(
    (repo: GithubRepo) => {
      if (!auth) return;
      setSelRepo(repo);
      setSelBranch(null);
      setBranches([]);
      setBranchesLoading(true);
      api
        .listGithubBranches(auth, repo.owner.login, repo.name)
        .then((bs) => {
          // default 分支顶置。
          const sorted = [...bs].sort((a, b) =>
            a.name === repo.default_branch
              ? -1
              : b.name === repo.default_branch
                ? 1
                : 0,
          );
          setBranches(sorted);
          setSelBranch(repo.default_branch);
        })
        .catch((e) => toast(apiErrorMessage(e, "加载分支失败"), "error"))
        .finally(() => setBranchesLoading(false));
    },
    [auth, toast],
  );

  const startLink = useCallback(async () => {
    if (!auth || linking) return;
    setLinking(true);
    try {
      const { authorizeUrl } = await api.startGithubOAuth(auth);
      window.location.href = authorizeUrl; // 跳 GitHub 授权页，回调后 302 回 /?github_linked=1
    } catch (e) {
      const code = (e as { code?: string }).code;
      toast(
        code ? githubErrorText(code) : apiErrorMessage(e, "连接失败"),
        "error",
      );
      setLinking(false);
    }
  }, [auth, linking, toast]);

  const doUnlink = useCallback(async () => {
    if (!auth || unlinking) return;
    setUnlinking(true);
    try {
      const r = await api.unlinkGithub(auth);
      setLink({ linked: false });
      setRepos([]);
      setSelRepo(null);
      setBranches([]);
      setSelBranch(null);
      setConfirmUnlink(false);
      // 后端已级联清所有会话选择 → 通知上层重拉当前会话 selection（清 pill/banner + 升版本哨兵，
      // 防迟到 status 复活已清 UI；对齐 v3 解绑后 refreshGithubPill）。
      onAccountUnlinked?.();
      toast(`已解绑 GitHub · ${r.sessionsCleared} 个会话已清空`, "success");
    } catch (e) {
      const code = (e as { code?: string }).code;
      toast(
        code ? githubErrorText(code) : apiErrorMessage(e, "解绑失败"),
        "error",
      );
    } finally {
      setUnlinking(false);
    }
  }, [auth, unlinking, toast]);

  const doConfirm = useCallback(async () => {
    if (!selRepo || !selBranch || confirming) return;
    setConfirming(true);
    try {
      await onConfirm(selRepo.owner.login, selRepo.name, selBranch);
      onClose();
    } catch (e) {
      const code = (e as { code?: string }).code;
      toast(
        code ? githubErrorText(code) : apiErrorMessage(e, "绑定失败"),
        "error",
      );
    } finally {
      setConfirming(false);
    }
  }, [selRepo, selBranch, confirming, onConfirm, onClose, toast]);

  const doUnbind = useCallback(async () => {
    if (unbinding) return;
    setUnbinding(true);
    try {
      await onUnbind();
      onClose();
    } catch (e) {
      toast(apiErrorMessage(e, "解除绑定失败"), "error");
    } finally {
      setUnbinding(false);
    }
  }, [unbinding, onUnbind, onClose, toast]);

  const filteredRepos = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter((r) => r.full_name.toLowerCase().includes(q));
  }, [repos, search]);

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="绑定 GitHub 仓库"
      size="lg"
      mobile="sheet"
      data-product-feature={PRODUCT_CAPABILITIES.github.id}
      bodyClassName="flex min-h-0 flex-col overflow-hidden p-0"
      footer={
        <div className="flex w-full justify-between gap-2">
          <div>
            {hasBinding && (
              <Button
                variant="subtle"
                size="sm"
                onClick={doUnbind}
                disabled={unbinding}
              >
                {unbinding ? "解除中…" : "解除当前绑定"}
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={doConfirm}
              disabled={
                !linked || !selRepo || !selBranch || confirming || !sessionId
              }
            >
              {confirming ? "绑定中…" : "确认绑定"}
            </Button>
          </div>
        </div>
      }
    >
          {/* 账号栏 */}
          <div className="border-b border-border bg-hover/30 px-5 py-3">
            {!auth || linkLoading ? (
              <div className="flex items-center gap-2 text-body text-faint">
                <Spinner /> 加载账号状态…
              </div>
            ) : linkErr ? (
              <div className="flex items-center justify-between gap-3">
                <span className="text-body text-danger">{linkErr}</span>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void loadLink()}
                >
                  重试
                </Button>
              </div>
            ) : link && !link.linked ? (
              <div className="flex items-center justify-between gap-3">
                <span className="text-body text-muted">
                  连接 GitHub 账号后即可把仓库绑定到当前会话
                </span>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={startLink}
                  disabled={linking}
                >
                  <GitBranch size={14} /> {linking ? "跳转中…" : "连接 GitHub"}
                </Button>
              </div>
            ) : link && link.linked ? (
              <div className="flex items-center gap-3">
                <Avatar
                  size="sm"
                  src={link.avatar_url || undefined}
                  fallback={link.login?.[0]?.toUpperCase() || "G"}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-section font-medium text-fg">
                    @{link.login}
                  </div>
                  <div className="truncate text-caption text-faint">
                    {link.scopes || "已连接"}
                  </div>
                </div>
                {confirmUnlink ? (
                  <div className="flex items-center gap-1.5">
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={doUnlink}
                      disabled={unlinking}
                    >
                      {unlinking ? "解绑中…" : "确认解绑"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setConfirmUnlink(false)}
                    >
                      取消
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="subtle"
                    size="sm"
                    onClick={() => setConfirmUnlink(true)}
                  >
                    解绑
                  </Button>
                )}
              </div>
            ) : null}
          </div>

          {/* 选仓 + 分支 */}
          {linked && (
            <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 overflow-hidden sm:grid-cols-[1.4fr_1fr]">
              {/* 仓库列 */}
              <div className="flex min-h-0 flex-col border-border sm:border-r">
                <div className="px-3 pt-3">
                  <div className="relative">
                    <Search
                      size={14}
                      className="absolute left-3 top-1/2 -translate-y-1/2 text-faint"
                    />
                    <Input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="搜索仓库…"
                      className="h-9 pl-9 text-body"
                    />
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                  {reposLoading ? (
                    <div className="flex items-center justify-center gap-2 py-10 text-body text-faint">
                      <Spinner /> 加载仓库…
                    </div>
                  ) : reposErr ? (
                    <p className="px-2 py-8 text-center text-body text-danger">
                      {reposErr}
                    </p>
                  ) : filteredRepos.length === 0 ? (
                    <p className="px-2 py-8 text-center text-body text-faint">
                      无匹配仓库
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-0.5">
                      {filteredRepos.map((r) => {
                        const active = selRepo?.full_name === r.full_name;
                        return (
                          <li key={r.full_name}>
                            <button
                              onClick={() => onPickRepo(r)}
                              className={cn(
                                "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                                active
                                  ? "bg-accent-soft text-accent"
                                  : "hover:bg-hover",
                              )}
                            >
                              <span className="min-w-0 flex-1 truncate text-body">
                                <span className="text-faint">
                                  {r.owner.login}/
                                </span>
                                <span className="font-medium text-fg">
                                  {r.name}
                                </span>
                              </span>
                              {r.private && (
                                <Lock
                                  size={12}
                                  className="shrink-0 text-faint"
                                  aria-label="私有"
                                />
                              )}
                              {active && (
                                <Check size={14} className="shrink-0" />
                              )}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </div>

              {/* 分支列 */}
              <div className="flex min-h-0 flex-col border-t border-border sm:border-t-0">
                <div className="px-3 pt-3 text-caption font-medium uppercase tracking-wide text-faint">
                  分支
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                  {!selRepo ? (
                    <p className="px-2 py-8 text-center text-meta text-faint">
                      先选择左侧仓库
                    </p>
                  ) : branchesLoading ? (
                    <div className="flex items-center justify-center gap-2 py-10 text-body text-faint">
                      <Spinner /> 加载分支…
                    </div>
                  ) : branches.length === 0 ? (
                    <p className="px-2 py-8 text-center text-meta text-faint">
                      无分支
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-0.5">
                      {branches.map((b) => {
                        const active = selBranch === b.name;
                        return (
                          <li key={b.name}>
                            <button
                              onClick={() => setSelBranch(b.name)}
                              className={cn(
                                "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                                active
                                  ? "bg-accent-soft text-accent"
                                  : "hover:bg-hover",
                              )}
                            >
                              <span className="min-w-0 flex-1 truncate text-body font-medium text-fg">
                                {b.name}
                              </span>
                              {b.name === selRepo.default_branch && (
                                <Badge tone="neutral">default</Badge>
                              )}
                              {active && (
                                <Check size={14} className="shrink-0" />
                              )}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          )}
    </Modal>
  );
}
