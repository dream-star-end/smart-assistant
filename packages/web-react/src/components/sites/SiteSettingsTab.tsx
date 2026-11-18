import { CheckCircle2, Globe, Lock, PauseCircle, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { apiErrorMessage } from "../../lib/api";
import { type SiteEnvVarItem, sitesApi } from "../../lib/sitesApi";
import type { AuthSession, UserSiteItem, UserSiteVisibility } from "../../lib/types";
import {
  Alert,
  Button,
  Field,
  IconButton,
  Input,
  Modal,
  Select,
  Switch,
  useConfirm,
  useToast,
} from "../ui";

const VISIBILITY_OPTIONS: { value: UserSiteVisibility; label: string }[] = [
  { value: "public", label: "所有人可访问" },
  { value: "password", label: "仅口令保护访问" },
  { value: "disabled", label: "暂停访问（下线）" },
];

export function sharingLabel(v: UserSiteVisibility): string {
  if (v === "public") return "所有人可访问";
  if (v === "password") return "仅口令可见";
  return "已暂停访问";
}

export function SiteSettingsTab({
  auth,
  site,
  baseDomain,
  envVars,
  readOnly = false,
  onSiteUpdated,
  onSiteRenamed,
  onEnvVarsChange,
  onSiteDeleted,
}: {
  auth: AuthSession;
  site: UserSiteItem;
  baseDomain: string;
  envVars: SiteEnvVarItem[];
  readOnly?: boolean;
  onSiteUpdated: (site: UserSiteItem) => void;
  onSiteRenamed: (oldSlug: string, updated: UserSiteItem) => void;
  onEnvVarsChange: (envVars: SiteEnvVarItem[]) => void;
  onSiteDeleted: (slug: string) => void;
}) {
  const toast = useToast();
  const [confirmDialog, confirmDialogEl] = useConfirm();
  const mountedRef = useRef(true);
  const siteGenRef = useRef(0);

  // Inline title editing
  const [titleDraft, setTitleDraft] = useState(site.title);
  const [savingTitle, setSavingTitle] = useState(false);

  // URL rename modal
  const [renameOpen, setRenameOpen] = useState(false);
  const [slugDraft, setSlugDraft] = useState(site.slug);
  const [renaming, setRenaming] = useState(false);
  const [renameErr, setRenameErr] = useState<string | null>(null);

  // Custom domain modal + verification
  const [domainOpen, setDomainOpen] = useState(false);
  const [domainDraft, setDomainDraft] = useState(site.customDomain ?? "");
  const [savingDomain, setSavingDomain] = useState(false);
  const [verifyingDomain, setVerifyingDomain] = useState(false);
  const [domainErr, setDomainErr] = useState<string | null>(null);

  // Sharing settings modal
  const [shareOpen, setShareOpen] = useState(false);
  const [shareVisibility, setShareVisibility] = useState<UserSiteVisibility>(site.visibility);
  const [sharePassword, setSharePassword] = useState("");
  const [shareSpaMode, setShareSpaMode] = useState(site.spaMode);
  const [savingShare, setSavingShare] = useState(false);
  const [shareErr, setShareErr] = useState<string | null>(null);

  // Env vars state
  const [plainEdits, setPlainEdits] = useState<Record<string, string>>({});
  const [replacingKey, setReplacingKey] = useState<string | null>(null);
  const [replaceValue, setReplaceValue] = useState("");
  const [addingEnv, setAddingEnv] = useState(false);
  const [newEnvKey, setNewEnvKey] = useState("");
  const [newEnvVal, setNewEnvVal] = useState("");
  const [newEnvSecret, setNewEnvSecret] = useState(true);
  const [envBusyKey, setEnvBusyKey] = useState<string | null>(null);

  const [deletingSite, setDeletingSite] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    siteGenRef.current += 1;
    setRenameOpen(false);
    setDomainOpen(false);
    setShareOpen(false);
    setRenameErr(null);
    setDomainErr(null);
    setShareErr(null);
    setReplacingKey(null);
    setReplaceValue("");
    setAddingEnv(false);
    setNewEnvKey("");
    setNewEnvVal("");
    setNewEnvSecret(true);
    setEnvBusyKey(null);
    setSavingTitle(false);
    setRenaming(false);
    setSavingDomain(false);
    setVerifyingDomain(false);
    setSavingShare(false);
    setDeletingSite(false);
  }, [site.id, site.slug]);

  useEffect(() => {
    setTitleDraft(site.title);
    setSlugDraft(site.slug);
    setDomainDraft(site.customDomain ?? "");
    setShareVisibility(site.visibility);
    setShareSpaMode(site.spaMode);
    setSharePassword("");
    const nextPlain: Record<string, string> = {};
    for (const v of envVars) {
      if (!v.isSecret) nextPlain[v.key] = v.value ?? "";
    }
    setPlainEdits(nextPlain);
  }, [site, envVars]);

  function isCurrentSiteGen(expectedGen: number): boolean {
    return mountedRef.current && expectedGen === siteGenRef.current;
  }

  async function saveTitle() {
    if (readOnly || savingTitle) return;
    const trimmed = titleDraft.trim();
    if (!trimmed || trimmed === site.title) {
      setTitleDraft(site.title);
      return;
    }
    const gen = siteGenRef.current;
    setSavingTitle(true);
    try {
      const res = await sitesApi.updateSite(auth, site.slug, { title: trimmed });
      if (!isCurrentSiteGen(gen)) return;
      onSiteUpdated(res.site);
      toast("站点名称已保存", "success");
    } catch (e) {
      if (!isCurrentSiteGen(gen)) return;
      setTitleDraft(site.title);
      toast(apiErrorMessage(e, "保存名称失败"), "error");
    } finally {
      if (isCurrentSiteGen(gen)) setSavingTitle(false);
    }
  }

  async function submitRename(e: FormEvent) {
    e.preventDefault();
    if (readOnly || renaming) return;
    const target = slugDraft.trim().toLowerCase();
    if (!target || target === site.slug) {
      setRenameOpen(false);
      return;
    }
    const gen = siteGenRef.current;
    const originSlug = site.slug;
    setRenaming(true);
    setRenameErr(null);
    try {
      const res = await sitesApi.renameSite(auth, originSlug, target);
      if (!isCurrentSiteGen(gen)) return;
      setRenameOpen(false);
      onSiteRenamed(originSlug, res.site);
      toast(`站点地址已变更为 ${res.site.slug}.${baseDomain}`, "success");
    } catch (err) {
      if (!isCurrentSiteGen(gen)) return;
      setRenameErr(apiErrorMessage(err, "更改 URL 失败"));
    } finally {
      if (isCurrentSiteGen(gen)) setRenaming(false);
    }
  }

  async function saveCustomDomain(domainValue: string | null) {
    if (readOnly || savingDomain) return;
    const gen = siteGenRef.current;
    setSavingDomain(true);
    setDomainErr(null);
    try {
      const res = await sitesApi.updateSite(auth, site.slug, { customDomain: domainValue });
      if (!isCurrentSiteGen(gen)) return;
      setDomainOpen(false);
      onSiteUpdated(res.site);
      toast(
        domainValue
          ? `已保存域名 ${res.site.customDomain}，请按提示完成 DNS TXT 验证`
          : "已解绑自定义域名",
        "success",
      );
    } catch (err) {
      if (!isCurrentSiteGen(gen)) return;
      setDomainErr(apiErrorMessage(err, "更新自定义域名失败"));
    } finally {
      if (isCurrentSiteGen(gen)) setSavingDomain(false);
    }
  }

  async function verifyDomainDns() {
    if (readOnly || verifyingDomain || !site.customDomain) return;
    const gen = siteGenRef.current;
    setVerifyingDomain(true);
    setDomainErr(null);
    try {
      const res = await sitesApi.verifyCustomDomain(auth, site.slug);
      if (!isCurrentSiteGen(gen)) return;
      onSiteUpdated(res.site);
      toast(`自定义域名 ${res.site.customDomain} 验证通过并已启用`, "success");
    } catch (err) {
      if (!isCurrentSiteGen(gen)) return;
      toast(apiErrorMessage(err, "DNS 验证尚未生效，请稍后重试"), "error");
    } finally {
      if (isCurrentSiteGen(gen)) setVerifyingDomain(false);
    }
  }

  async function submitShare(e: FormEvent) {
    e.preventDefault();
    if (readOnly || savingShare) return;
    const gen = siteGenRef.current;
    setSavingShare(true);
    setShareErr(null);
    try {
      const res = await sitesApi.updateSite(auth, site.slug, {
        visibility: shareVisibility,
        spaMode: shareSpaMode,
        ...(shareVisibility === "password" && sharePassword.trim()
          ? { password: sharePassword }
          : {}),
      });
      if (!isCurrentSiteGen(gen)) return;
      setShareOpen(false);
      setSharePassword("");
      onSiteUpdated(res.site);
      toast("共享设置已更新", "success");
    } catch (err) {
      if (!isCurrentSiteGen(gen)) return;
      setShareErr(apiErrorMessage(err, "保存共享设置失败"));
    } finally {
      if (isCurrentSiteGen(gen)) setSavingShare(false);
    }
  }

  async function saveEnvVar(key: string, value: string, isSecret: boolean) {
    if (readOnly) return;
    const gen = siteGenRef.current;
    setEnvBusyKey(key);
    try {
      const res = await sitesApi.setSiteEnvVar(auth, site.slug, { key, value, isSecret });
      if (!isCurrentSiteGen(gen)) return;
      onEnvVarsChange(res.envVars);
      setReplacingKey((cur) => (cur === key ? null : cur));
      setReplaceValue("");
      if (addingEnv) {
        setAddingEnv(false);
        setNewEnvKey("");
        setNewEnvVal("");
      }
      toast(`环境变量 ${key} 已保存`, "success");
    } catch (err) {
      if (!isCurrentSiteGen(gen)) return;
      toast(apiErrorMessage(err, `保存环境变量 ${key} 失败`), "error");
    } finally {
      if (isCurrentSiteGen(gen)) setEnvBusyKey(null);
    }
  }

  async function removeEnvVar(key: string) {
    if (readOnly) return;
    const gen = siteGenRef.current;
    setEnvBusyKey(key);
    try {
      const res = await sitesApi.deleteSiteEnvVar(auth, site.slug, key);
      if (!isCurrentSiteGen(gen)) return;
      onEnvVarsChange(res.envVars);
      toast(`已删除 ${key}`, "info");
    } catch (err) {
      if (!isCurrentSiteGen(gen)) return;
      toast(apiErrorMessage(err, `删除 ${key} 失败`), "error");
    } finally {
      if (isCurrentSiteGen(gen)) setEnvBusyKey(null);
    }
  }

  async function handleDeleteSite() {
    if (readOnly || deletingSite) return;
    const gen = siteGenRef.current;
    const originSlug = site.slug;
    const originTitle = site.title;
    const choice = await confirmDialog({
      title: `永久删除站点「${originTitle}」？`,
      body: `删除后 ${originSlug}.${baseDomain} 将立即失效，站点静态文件、SQLite 数据库与环境变量将一并清空且无法恢复。`,
      confirmText: "删除站点",
      danger: true,
    });
    if (choice !== true || !isCurrentSiteGen(gen)) return;
    setDeletingSite(true);
    try {
      await sitesApi.deleteSite(auth, originSlug);
      if (!isCurrentSiteGen(gen)) return;
      toast(`已删除站点「${originTitle}」`, "success");
      onSiteDeleted(originSlug);
    } catch (err) {
      if (!isCurrentSiteGen(gen)) return;
      toast(apiErrorMessage(err, "删除站点失败"), "error");
    } finally {
      if (isCurrentSiteGen(gen)) setDeletingSite(false);
    }
  }

  const primaryHost = `${site.slug}.${baseDomain}`;

  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <h3 className="text-section font-semibold text-fg">常规</h3>
        <div className="divide-y divide-border/70 border-y border-border/70">
          <div className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-body font-medium text-fg">名称</p>
              <p className="text-caption text-muted">你的站点名称</p>
            </div>
            <div className="w-full sm:w-80">
              <Input
                aria-label="站点名称"
                value={titleDraft}
                disabled={readOnly || savingTitle}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={() => void saveTitle()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void saveTitle();
                  }
                }}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 py-4">
            <div>
              <p className="text-body font-medium text-fg">URL</p>
              <p className="text-caption text-muted">网址</p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-mono text-body text-muted">{primaryHost}</span>
              <Button
                variant="secondary"
                size="sm"
                className="rounded-full"
                disabled={readOnly}
                onClick={() => {
                  setSlugDraft(site.slug);
                  setRenameErr(null);
                  setRenameOpen(true);
                }}
              >
                更改
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-3 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-body font-medium text-fg">自定义域名</p>
                <p className="text-caption text-muted">绑定你自己的独立域名</p>
              </div>
              <div className="flex flex-wrap items-center gap-2.5">
                {site.customDomain && (
                  <>
                    <span className="font-mono text-body text-fg">{site.customDomain}</span>
                    {site.customDomainStatus === "verified" ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-caption font-medium text-emerald-700 dark:text-emerald-300">
                        <CheckCircle2 size={12} aria-hidden="true" />
                        已验证
                      </span>
                    ) : (
                      <span className="rounded-full bg-amber-500/15 px-2.5 py-0.5 text-caption font-medium text-amber-700 dark:text-amber-300">
                        待验证 DNS
                      </span>
                    )}
                  </>
                )}
                {site.customDomain && site.customDomainStatus !== "verified" && (
                  <Button
                    variant="primary"
                    size="sm"
                    className="rounded-full"
                    disabled={readOnly || verifyingDomain}
                    onClick={() => void verifyDomainDns()}
                  >
                    {verifyingDomain ? "验证中…" : "验证域名"}
                  </Button>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  className="rounded-full"
                  disabled={readOnly}
                  onClick={() => {
                    setDomainDraft(site.customDomain ?? "");
                    setDomainErr(null);
                    setDomainOpen(true);
                  }}
                >
                  {site.customDomain ? "更改自定义域名" : "添加自定义域名"}
                </Button>
              </div>
            </div>
            {site.customDomain &&
              site.customDomainStatus !== "verified" &&
              site.customDomainTxtName &&
              site.customDomainTxtValue && (
                <div className="rounded-lg border border-border/80 bg-bg-subtle/60 px-3.5 py-2.5 text-caption text-muted">
                  <p className="font-medium text-fg">
                    验证所有权后才会启用路由与 TLS 证书。请添加以下 DNS 记录：
                  </p>
                  <p className="mt-1 font-mono text-[12px]">
                    1) TXT 记录名：{site.customDomainTxtName} → 值：{site.customDomainTxtValue}
                  </p>
                  <p className="font-mono text-[12px]">
                    2) CNAME 记录：{site.customDomain} → {primaryHost}
                  </p>
                </div>
              )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 py-4">
            <div>
              <p className="text-body font-medium text-fg">共享设置</p>
              <p className="text-caption text-muted">谁可以查看你的站点</p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <span className="inline-flex items-center gap-1.5 text-body text-muted">
                {site.visibility === "public" ? (
                  <Globe size={14} aria-hidden="true" />
                ) : site.visibility === "password" ? (
                  <Lock size={14} aria-hidden="true" />
                ) : (
                  <PauseCircle size={14} aria-hidden="true" />
                )}
                {sharingLabel(site.visibility)}
              </span>
              <Button
                variant="secondary"
                size="sm"
                className="rounded-full"
                disabled={readOnly}
                onClick={() => {
                  setShareVisibility(site.visibility);
                  setShareSpaMode(site.spaMode);
                  setSharePassword("");
                  setShareErr(null);
                  setShareOpen(true);
                }}
              >
                管理
              </Button>
            </div>
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-section font-semibold text-fg">环境变量</h3>
            <p className="text-caption text-muted">添加站点所需的 API 密钥和其他环境变量</p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            className="rounded-full"
            disabled={readOnly}
            onClick={() => setAddingEnv(true)}
          >
            <Plus size={14} aria-hidden="true" />
            添加变量
          </Button>
        </div>

        {envVars.length === 0 && !addingEnv ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-body text-muted">
            暂无环境变量 — 点击右上角「添加变量」或在命令行运行 `oc-site env-set` 配置密钥。
          </p>
        ) : (
          <div className="space-y-2.5">
            <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_56px_40px] items-center gap-3 px-1 text-caption text-muted sm:grid">
              <span>键</span>
              <span>值</span>
              <span className="text-center">机密</span>
              <span className="sr-only">操作</span>
            </div>

            {envVars.map((envVar) => {
              const busy = envBusyKey === envVar.key;
              const isReplacing = replacingKey === envVar.key;
              return (
                <div
                  key={envVar.key}
                  className="grid grid-cols-1 items-center gap-3 rounded-lg border border-border/70 bg-bg-subtle/40 p-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_56px_40px] sm:border-0 sm:bg-transparent sm:p-0"
                >
                  <Input
                    value={envVar.key}
                    readOnly
                    disabled
                    aria-label={`环境变量名 ${envVar.key}`}
                    className="font-mono text-[13px]"
                  />

                  <div className="flex items-center gap-2">
                    {envVar.isSecret ? (
                      isReplacing ? (
                        <>
                          <Input
                            type="password"
                            value={replaceValue}
                            placeholder="输入新的密钥值…"
                            aria-label={`${envVar.key} 新密钥`}
                            onChange={(e) => setReplaceValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && replaceValue) {
                                e.preventDefault();
                                void saveEnvVar(envVar.key, replaceValue, true);
                              }
                            }}
                          />
                          <Button
                            size="sm"
                            variant="primary"
                            disabled={busy || !replaceValue}
                            onClick={() => void saveEnvVar(envVar.key, replaceValue, true)}
                          >
                            保存
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setReplacingKey(null);
                              setReplaceValue("");
                            }}
                          >
                            取消
                          </Button>
                        </>
                      ) : (
                      <Button
                        variant="secondary"
                        size="sm"
                        className="rounded-full"
                        disabled={readOnly || busy}
                        onClick={() => {
                          setReplacingKey(envVar.key);
                          setReplaceValue("");
                        }}
                      >
                        替换密钥
                      </Button>
                    )
                  ) : (
                    <Input
                      value={plainEdits[envVar.key] ?? envVar.value ?? ""}
                      disabled={readOnly || busy}
                        aria-label={`${envVar.key} 值`}
                        onChange={(e) =>
                          setPlainEdits((prev) => ({ ...prev, [envVar.key]: e.target.value }))
                        }
                        onBlur={() => {
                          const nextVal = plainEdits[envVar.key] ?? "";
                          if (nextVal !== (envVar.value ?? "")) {
                            void saveEnvVar(envVar.key, nextVal, false);
                          }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            const nextVal = plainEdits[envVar.key] ?? "";
                            if (nextVal !== (envVar.value ?? "")) {
                              void saveEnvVar(envVar.key, nextVal, false);
                            }
                          }
                        }}
                      />
                    )}
                  </div>

                  <div className="flex items-center justify-between gap-2 sm:justify-center">
                    <span className="text-caption text-muted sm:hidden">机密</span>
                    <Switch
                      checked={envVar.isSecret}
                      disabled={readOnly || busy || envVar.isSecret}
                      aria-label={`${envVar.key} 设为机密`}
                      onCheckedChange={(checked) => {
                        if (checked && !envVar.isSecret) {
                          void saveEnvVar(
                            envVar.key,
                            plainEdits[envVar.key] ?? envVar.value ?? "",
                            true,
                          );
                        }
                      }}
                    />
                  </div>

                  <div className="flex justify-end sm:justify-center">
                    <IconButton
                      variant="ghost"
                      size="sm"
                      disabled={readOnly || busy}
                      aria-label={`删除环境变量 ${envVar.key}`}
                      onClick={() => void removeEnvVar(envVar.key)}
                    >
                      <Trash2 size={15} className="text-muted" aria-hidden="true" />
                    </IconButton>
                  </div>
                </div>
              );
            })}

            {addingEnv && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (newEnvKey.trim()) {
                    void saveEnvVar(newEnvKey.trim(), newEnvVal, newEnvSecret);
                  }
                }}
                className="grid grid-cols-1 items-center gap-3 rounded-lg border border-border bg-surface p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_56px_auto]"
              >
                <Input
                  value={newEnvKey}
                  placeholder="DEEPSEEK_API_KEY"
                  aria-label="新环境变量名"
                  className="font-mono text-[13px]"
                  onChange={(e) => setNewEnvKey(e.target.value)}
                />
                <Input
                  type={newEnvSecret ? "password" : "text"}
                  value={newEnvVal}
                  placeholder="输入变量值…"
                  aria-label="新环境变量值"
                  onChange={(e) => setNewEnvVal(e.target.value)}
                />
                <div className="flex items-center justify-between gap-2 sm:justify-center">
                  <span className="text-caption text-muted sm:hidden">机密</span>
                  <Switch
                    checked={newEnvSecret}
                    aria-label="新变量设为机密"
                    onCheckedChange={setNewEnvSecret}
                  />
                </div>
                <div className="flex items-center justify-end gap-1.5">
                  <Button
                    type="submit"
                    size="sm"
                    variant="primary"
                    disabled={envBusyKey !== null || !newEnvKey.trim()}
                  >
                    保存
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setAddingEnv(false);
                      setNewEnvKey("");
                      setNewEnvVal("");
                    }}
                  >
                    取消
                  </Button>
                </div>
              </form>
            )}
          </div>
        )}
      </section>

      <section className="space-y-3 border-t border-border/70 pt-6">
        <h3 className="text-section font-semibold text-fg">危险操作区</h3>
        <div className="flex flex-wrap items-center justify-between gap-4 py-2">
          <div>
            <p className="text-body font-medium text-fg">删除站点</p>
            <p className="text-caption text-muted">永久删除此站点</p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            disabled={readOnly || deletingSite}
            onClick={() => void handleDeleteSite()}
            className="rounded-full border-red-500/50 text-red-600 hover:bg-red-500/10 dark:text-red-400"
          >
            删除站点
          </Button>
        </div>
      </section>

      <Modal
        open={renameOpen}
        onOpenChange={(next) => !next && setRenameOpen(false)}
        title="更改站点 URL"
        size="sm"
      >
        <form onSubmit={(e) => void submitRename(e)} className="space-y-4">
          {renameErr && <Alert tone="danger">{renameErr}</Alert>}
          <Field
            label="新的子域名前缀"
            hint={`完整访问地址：https://${slugDraft.trim().toLowerCase() || site.slug}.${baseDomain}。重命名会同步保留 SQLite 数据和环境变量。`}
          >
            <Input
              value={slugDraft}
              onChange={(e) => setSlugDraft(e.target.value)}
              placeholder="my-awesome-site"
              className="font-mono"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setRenameOpen(false)}>
              取消
            </Button>
            <Button type="submit" variant="primary" disabled={renaming || !slugDraft.trim()}>
              {renaming ? "更改中…" : "确认更改"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={domainOpen}
        onOpenChange={(next) => !next && setDomainOpen(false)}
        title="自定义域名"
        size="sm"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void saveCustomDomain(domainDraft.trim() || null);
          }}
          className="space-y-4"
        >
          {domainErr && <Alert tone="danger">{domainErr}</Alert>}
          <Field
            label="域名"
            hint={`请在你的域名 DNS 服务商中添加一条 CNAME 记录指向 ${primaryHost}。`}
          >
            <Input
              value={domainDraft}
              onChange={(e) => setDomainDraft(e.target.value)}
              placeholder="app.example.com"
              className="font-mono"
            />
          </Field>
          <div className="flex flex-wrap items-center justify-between gap-2">
            {site.customDomain ? (
              <Button
                type="button"
                variant="ghost"
                disabled={savingDomain}
                onClick={() => void saveCustomDomain(null)}
                className="text-red-600 dark:text-red-400"
              >
                移除绑定
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={() => setDomainOpen(false)}>
                取消
              </Button>
              <Button type="submit" variant="primary" disabled={savingDomain}>
                {savingDomain ? "保存中…" : "保存"}
              </Button>
            </div>
          </div>
        </form>
      </Modal>

      <Modal
        open={shareOpen}
        onOpenChange={(next) => !next && setShareOpen(false)}
        title="共享设置"
        size="sm"
      >
        <form onSubmit={(e) => void submitShare(e)} className="space-y-4">
          {shareErr && <Alert tone="danger">{shareErr}</Alert>}
          <Field label="访问权限">
            <Select
              value={shareVisibility}
              onValueChange={(v) => setShareVisibility(v as UserSiteVisibility)}
              options={VISIBILITY_OPTIONS}
            />
          </Field>
          {shareVisibility === "password" && (
            <Field
              label="访问口令（4–128 位）"
              hint={site.visibility === "password" ? "留空则保留当前访问口令" : undefined}
            >
              <Input
                type="password"
                value={sharePassword}
                onChange={(e) => setSharePassword(e.target.value)}
                placeholder={
                  site.visibility === "password" ? "留空保持原口令不变" : "输入 4–128 位访问口令"
                }
              />
            </Field>
          )}
          <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5">
            <div>
              <p className="text-body font-medium text-fg">SPA 单页应用路由</p>
              <p className="text-caption text-muted">未匹配静态文件时回退到 index.html</p>
            </div>
            <Switch
              checked={shareSpaMode}
              onCheckedChange={setShareSpaMode}
              aria-label="启用 SPA 单页应用路由"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setShareOpen(false)}>
              取消
            </Button>
            <Button type="submit" variant="primary" disabled={savingShare}>
              {savingShare ? "保存中…" : "保存"}
            </Button>
          </div>
        </form>
      </Modal>

      {confirmDialogEl}
    </div>
  );
}
