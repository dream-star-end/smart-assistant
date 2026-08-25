import { CheckCircle2, KeyRound } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button, Input, Modal, Spinner, Textarea, useToast } from "../../../components/ui";
import { adminGet, adminSend, apiErrorMessage } from "../../lib/adminApi";
import { Field, Select } from "./form";
import {
  ACCOUNT_PLANS,
  ACCOUNT_STATUSES,
  type AccountRow,
  type ActiveProxy,
  type OAuthGroup,
} from "./types";

type Mode = "create" | "edit";

function errMsg(e: unknown): string {
  return apiErrorMessage(e, "请求失败");
}

const isNull = (v: string) => v.trim().toUpperCase() === "NULL";

/**
 * 账号创建 / 编辑模态。
 *  - create:provider 单选(v5 ccb-only 仅 claude)+ OAuth 接入向导(start→授权→粘 code→exchange 自动回填 token)+ 表单。
 *  - edit:无向导,含 status 字段;token/refresh/expires/subEnd 留空=不改,输入 NULL=显式清空。
 * egress 代理池条目必选(0055);官方 OAuth 分组可选。依赖(active 代理 + official_oauth 分组)开窗时拉取。
 */
export function AccountFormModal({
  open,
  onOpenChange,
  mode,
  account,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: Mode;
  account?: AccountRow;
  onSaved: () => void;
}) {
  const toast = useToast();
  const isCreate = mode === "create";

  const [depsLoading, setDepsLoading] = useState(true);
  const [depsError, setDepsError] = useState<string | null>(null);
  const [proxies, setProxies] = useState<ActiveProxy[]>([]);
  const [groups, setGroups] = useState<OAuthGroup[]>([]);

  // 表单字段(raw string;NULL/留空语义在提交时解释)。
  const [label, setLabel] = useState("");
  const [plan, setPlan] = useState("pro");
  const [statusEdit, setStatusEdit] = useState("active");
  const [token, setToken] = useState("");
  const [refresh, setRefresh] = useState("");
  const [expires, setExpires] = useState("");
  const [subEnd, setSubEnd] = useState("");
  const [groupId, setGroupId] = useState("");
  const [egressId, setEgressId] = useState("");
  const [saving, setSaving] = useState(false);
  const [providerCreate, setProviderCreate] = useState<"claude" | "codex" | "grok" | "cursor">("claude");
  const [cursorSandEnabled, setCursorSandEnabled] = useState(false);
  const [cursorQuotaClass, setCursorQuotaClass] = useState<"unknown" | "other_ok" | "cursor_only">("unknown");

  // OAuth 向导(create)。
  const [oauthState, setOauthState] = useState<string | null>(null);
  const [oauthCode, setOauthCode] = useState("");
  const [step2, setStep2] = useState(false);
  const [oauthHint, setOauthHint] = useState<string | null>(null);
  const [authUrlFallback, setAuthUrlFallback] = useState<string | null>(null);
  const [exchanging, setExchanging] = useState(false);
  const [tokenFilled, setTokenFilled] = useState(false);
  const [grokSessionId, setGrokSessionId] = useState<string | null>(null);
  const [grokUserCode, setGrokUserCode] = useState<string | null>(null);
  const [grokVerificationUrl, setGrokVerificationUrl] = useState<string | null>(null);
  const [grokPrincipalType, setGrokPrincipalType] = useState<string | null>(null);
  const [grokPrincipalId, setGrokPrincipalId] = useState<string | null>(null);

  const provider = isCreate ? providerCreate : account?.provider || "claude";
  const prefillEgress = account?.egress_proxy_id != null ? String(account.egress_proxy_id) : "";
  const prefillGroup = account?.group_id != null ? String(account.group_id) : "";

  // 开窗:重置表单 + 拉依赖。
  useEffect(() => {
    if (!open) return;
    setLabel(account?.label ?? "");
    setPlan(account?.plan || "pro");
    setStatusEdit(account?.status || "active");
    setToken("");
    setRefresh("");
    setExpires(account?.oauth_expires_at ?? "");
    setSubEnd(account?.subscription_end_at ?? "");
    setGroupId(prefillGroup);
    setEgressId(prefillEgress);
    setCursorSandEnabled(account?.cursor_sand_enabled === true);
    setCursorQuotaClass((account?.cursor_quota_class as "unknown" | "other_ok" | "cursor_only") || "unknown");
    setOauthState(null);
    setOauthCode("");
    setStep2(false);
    setOauthHint(null);
    setAuthUrlFallback(null);
    setTokenFilled(false);
    setProviderCreate("claude");
    setGrokSessionId(null);
    setGrokUserCode(null);
    setGrokVerificationUrl(null);
    setGrokPrincipalType(null);
    setGrokPrincipalId(null);
    setDepsError(null);
    setDepsLoading(true);
    let alive = true;
    void Promise.all([
      adminGet<{ rows: ActiveProxy[] }>("/egress-proxies", { status: "active", limit: 500 }),
      adminGet<{ rows: OAuthGroup[] }>("/account-groups"),
    ])
      .then(([p, g]) => {
        if (!alive) return;
        setProxies(Array.isArray(p.rows) ? p.rows : []);
        setGroups((Array.isArray(g.rows) ? g.rows : []).filter((x) => x.kind === "official_oauth"));
      })
      .catch((e) => {
        if (alive) setDepsError(errMsg(e));
      })
      .finally(() => {
        if (alive) setDepsLoading(false);
      });
    return () => {
      alive = false;
    };
    // account 引用变化即重置;prefill* 由 account 派生,不单列。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, account]);

  const groupOptions = groups.filter((g) => g.provider === provider);
  const egressInActive = proxies.some((p) => String(p.id) === egressId);

  const startOAuth = useCallback(async () => {
    try {
      const r = await adminSend<{ authUrl?: string; state?: string }>(
        "POST",
        "/accounts/oauth/start",
        { provider },
      );
      if (!r.authUrl || !r.state) {
        toast("OAuth 启动返回不完整", "error");
        return;
      }
      setOauthState(r.state);
      setStep2(true);
      const win = window.open(r.authUrl, "_blank", "noopener");
      if (!win) {
        setAuthUrlFallback(r.authUrl);
        setOauthHint("弹窗被拦截,请手动复制下方链接到新页签打开。");
      } else {
        setAuthUrlFallback(null);
        setOauthHint("授权页已在新 tab 打开,完成后回来粘 code。");
      }
    } catch (e) {
      toast(`OAuth 启动失败: ${errMsg(e)}`, "error");
    }
  }, [provider, toast]);

  const startGrokOAuth = useCallback(async () => {
    if (!egressId) {
      toast("请先选择 egress 代理池条目", "error");
      return;
    }
    setExchanging(true);
    try {
      const r = await adminSend<{
        status?: string;
        session_id?: string;
        verification_url?: string;
        user_code?: string;
      }>("POST", "/accounts/grok-device/start", { egress_proxy_id: egressId });
      if (!r.session_id || !r.verification_url || !r.user_code) {
        toast("Grok 设备授权启动返回不完整", "error");
        return;
      }
      setGrokSessionId(r.session_id);
      setGrokVerificationUrl(r.verification_url);
      setGrokUserCode(r.user_code);
      const win = window.open(r.verification_url, "_blank", "noopener");
      setOauthHint(win ? "授权页已打开，确认页面上的设备码后，本页会自动回填 token。" : "弹窗被拦截，请手动打开下方链接。");
    } catch (e) {
      toast(`Grok 授权启动失败: ${errMsg(e)}`, "error");
    } finally {
      setExchanging(false);
    }
  }, [egressId, toast]);

  useEffect(() => {
    if (!open || !grokSessionId) return;
    let alive = true;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const r = await adminGet<{
          status: "pending" | "complete" | "failed";
          access_token?: string;
          refresh_token?: string;
          expires_at?: string;
          principal_type?: string;
          principal_id?: string;
          error?: string;
        }>(`/accounts/grok-device/${encodeURIComponent(grokSessionId)}`);
        if (!alive || r.status === "pending") return;
        if (r.status === "complete" && r.access_token && r.refresh_token && r.expires_at) {
          setToken(r.access_token);
          setRefresh(r.refresh_token);
          setExpires(r.expires_at);
          setGrokPrincipalType(r.principal_type ?? null);
          setGrokPrincipalId(r.principal_id ?? null);
          setTokenFilled(true);
          setGrokSessionId(null);
          toast('Grok OAuth 已完成，token 已写入表单。', "success");
          return;
        }
        setGrokSessionId(null);
        toast(`Grok 授权失败: ${r.error || "未知错误"}`, "error");
      } catch (e) {
        if (alive) {
          setGrokSessionId(null);
          toast(`Grok 授权状态读取失败: ${errMsg(e)}`, "error");
        }
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1500);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [open, grokSessionId, toast]);

  useEffect(() => {
    if (open || !grokSessionId) return;
    void adminSend("DELETE", `/accounts/grok-device/${encodeURIComponent(grokSessionId)}`).catch(() => {});
    setGrokSessionId(null);
  }, [open, grokSessionId]);

  const changeProvider = useCallback((next: "claude" | "codex" | "grok" | "cursor") => {
    if (grokSessionId) {
      void adminSend("DELETE", `/accounts/grok-device/${encodeURIComponent(grokSessionId)}`).catch(() => {});
    }
    setProviderCreate(next);
    setCursorSandEnabled(false);
    setCursorQuotaClass("unknown");
    setGroupId("");
    setToken("");
    setRefresh("");
    setExpires("");
    setOauthState(null);
    setStep2(false);
    setTokenFilled(false);
    setGrokSessionId(null);
    setGrokUserCode(null);
    setGrokVerificationUrl(null);
    setGrokPrincipalType(null);
    setGrokPrincipalId(null);
    setOauthHint(null);
  }, [grokSessionId]);

  const exchangeOAuth = useCallback(async () => {
    if (!oauthState) {
      toast('请先点"打开授权页",再粘 code', "error");
      return;
    }
    let code = oauthCode.trim();
    if (!code) {
      toast("请粘 code 或 URL", "error");
      return;
    }
    try {
      if (code.startsWith("http")) code = new URL(code).searchParams.get("code") || code;
    } catch {
      /* 非合法 URL,当 code 用 */
    }
    if (code.includes("#")) code = code.split("#")[0];
    setExchanging(true);
    try {
      const r = await adminSend<{ access_token?: string; refresh_token?: string; expires_at?: string }>(
        "POST",
        "/accounts/oauth/exchange",
        { code, state: oauthState },
      );
      setToken(r.access_token || "");
      setRefresh(r.refresh_token || "");
      setExpires(r.expires_at || "");
      setOauthState(null);
      setStep2(false);
      setTokenFilled(true);
      toast('Token 已自动填好,核对 label/plan 后点"创建"', "success");
    } catch (e) {
      toast(`Token 交换失败: ${errMsg(e)}`, "error");
    } finally {
      setExchanging(false);
    }
  }, [oauthState, oauthCode, toast]);

  const submit = useCallback(async () => {
    const lbl = label.trim();
    if (!lbl) {
      toast("label 必填", "error");
      return;
    }
    const body: Record<string, unknown> = { label: lbl, plan };
    if (isCreate) {
      const tk = token.trim();
      if (!tk) {
        toast(provider === "cursor" ? "Cursor API Key 必填" : "oauth_token 必填", "error");
        return;
      }
      if (provider !== "cursor" && !egressId) {
        toast("egress 代理池条目 必选", "error");
        return;
      }
      body.oauth_token = tk;
      if (provider !== "cursor") body.egress_proxy_id = egressId;
      body.provider = provider;
      if (refresh.trim()) body.oauth_refresh_token = isNull(refresh) ? null : refresh.trim();
      if (expires.trim()) body.oauth_expires_at = isNull(expires) ? null : expires.trim();
      if (provider === "grok" && grokPrincipalType && grokPrincipalId) {
        body.oauth_principal_type = grokPrincipalType;
        body.oauth_principal_id = grokPrincipalId;
      }
      if (subEnd.trim()) body.subscription_end_at = isNull(subEnd) ? null : subEnd.trim();
      if (groupId) body.group_id = groupId;
      if (provider === "cursor") {
        body.cursor_sand_enabled = cursorSandEnabled;
        body.cursor_quota_class = cursorQuotaClass;
      }
    } else {
      if (provider === "cursor") {
        body.cursor_sand_enabled = cursorSandEnabled;
        body.cursor_quota_class = cursorQuotaClass;
      }
      body.status = statusEdit;
      if (token.trim()) body.oauth_token = token.trim();
      if (refresh.trim()) body.oauth_refresh_token = isNull(refresh) ? null : refresh.trim();
      if (expires.trim()) body.oauth_expires_at = isNull(expires) ? null : expires.trim();
      if (subEnd.trim()) body.subscription_end_at = isNull(subEnd) ? null : subEnd.trim();
      if (provider !== "cursor" && !egressId) {
        toast("egress 代理池条目 不可清空", "error");
        return;
      }
      if (provider !== "cursor" && egressId !== prefillEgress) body.egress_proxy_id = egressId;
      if (groupId !== prefillGroup) body.group_id = groupId || null;
    }
    setSaving(true);
    try {
      if (isCreate) {
        const r = await adminSend<{ account?: { id?: string } }>("POST", "/accounts", body);
        toast(`已创建账号 ${r.account?.id ?? ""}`, "success");
      } else {
        await adminSend("PATCH", `/accounts/${encodeURIComponent(account!.id)}`, body);
        toast(`#${account!.id} 已保存`, "success");
      }
      onOpenChange(false);
      onSaved();
    } catch (e) {
      toast(`${isCreate ? "创建" : "保存"}失败: ${errMsg(e)}`, "error");
    } finally {
      setSaving(false);
    }
  }, [
    label, plan, isCreate, token, egressId, provider, refresh, expires, subEnd, groupId,
    grokPrincipalType, grokPrincipalId,
    statusEdit, prefillEgress, prefillGroup, account, cursorSandEnabled, cursorQuotaClass, onOpenChange, onSaved, toast,
  ]);

  const defaultGroupLabel = isCreate ? `— 默认 ${provider} 官方订阅组 —` : "— 未绑定 —";

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={isCreate ? "新建账号" : `编辑账号 #${account?.id ?? ""}`}
      className="max-w-xl"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button variant="primary" onClick={submit} disabled={saving || depsLoading || !!depsError}>
            {saving ? <Spinner className="size-4" /> : isCreate ? "创建" : "保存"}
          </Button>
        </>
      }
    >
      {depsLoading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
          <Spinner className="size-4" /> 加载表单依赖…
        </div>
      ) : depsError ? (
        <div className="py-8 text-center text-sm text-danger">加载失败:{depsError}</div>
      ) : isCreate && provider !== "cursor" && proxies.length === 0 ? (
        <div className="flex flex-col gap-4">
          <Field label="provider">
            <Select value={provider} onChange={(e) => changeProvider(e.target.value as "claude" | "codex" | "grok" | "cursor")}>
              <option value="cursor">Cursor</option>
              <option value="claude">CCB</option>
              <option value="codex">Codex</option>
              <option value="grok">Grok Build</option>
            </Select>
          </Field>
          <div className="py-6 text-center text-sm text-warning">
            该 provider 需要代理池 active 条目。可先切到 Cursor，或到「代理池」页新建并启用一条。
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {isCreate && (
            <Field label="provider">
              <Select value={provider} onChange={(e) => changeProvider(e.target.value as "claude" | "codex" | "grok" | "cursor")}>
                <option value="cursor">Cursor</option>
                <option value="claude">CCB</option>
                <option value="codex">Codex</option>
                <option value="grok">Grok Build</option>
              </Select>
            </Field>
          )}

          {provider !== "cursor" && <Field
            label={`egress 代理池条目${isCreate ? "(必选)" : "(必选;不可清空)"}`}
            hint={`OAuth 登录与后续模型请求固定走同一条账号出口;此处仅显示 active 项${
              !isCreate && egressId && !egressInActive ? ",当前条目已被禁用" : ""
            }。`}
          >
            <Select value={egressId} onChange={(e) => setEgressId(e.target.value)}>
              {isCreate && (
                <option value="" disabled>
                  — 请选择代理池条目 —
                </option>
              )}
              {proxies.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} &lt;{p.url_masked || ""}&gt;
                </option>
              ))}
              {!isCreate && egressId && !egressInActive && (
                <option value={egressId}>
                  {account?.egress_proxy_pool_label || `#${egressId}`}(已禁用)
                </option>
              )}
            </Select>
          </Field>}

          {isCreate && provider === "cursor" && (
            <div className="rounded-lg border border-accent/40 bg-accent-soft/50 p-3.5 text-[13px] text-muted">
              Cursor 使用官方订阅 API Key（`crsr_…`）。密钥加密进账号池，再物化到宿主机 auth 目录供 oc-cursor 轮询，与 CCB 账号池同一套启用 / 冷却 / 分组。
            </div>
          )}

          {isCreate && provider !== "cursor" && (
            <div className="rounded-lg border border-accent/40 bg-accent-soft/50 p-3.5">
              <div className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-fg">
                <KeyRound size={15} className="text-accent" /> OAuth 授权(推荐)
              </div>
              {provider === "grok" ? (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="accent" onClick={startGrokOAuth} disabled={exchanging || !!grokSessionId}>
                      {exchanging || grokSessionId ? <Spinner className="size-4" /> : "打开 Grok 设备授权"}
                    </Button>
                    <span className="text-[12px] text-muted">使用 xAI 订阅账号登录，完成后自动回填。授权请求直连 x.ai，不走上方 egress（后续对话仍走该代理）。</span>
                  </div>
                  {grokVerificationUrl && (
                    <p className="mt-2 break-all font-mono text-[11px] text-muted">{grokVerificationUrl}</p>
                  )}
                  {grokUserCode && (
                    <p className="mt-2 text-[12px] text-muted">
                      页面确认码: <strong className="font-mono text-fg">{grokUserCode}</strong>
                    </p>
                  )}
                </>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="accent" onClick={startOAuth} disabled={exchanging}>
                      ① 打开授权页
                    </Button>
                    <span className="text-[12px] text-muted">新页签授权 → 复制回调 URL 里的 code</span>
                  </div>
                  {authUrlFallback && (
                    <p className="mt-2 break-all font-mono text-[11px] text-muted">{authUrlFallback}</p>
                  )}
                  {step2 && (
                    <div className="mt-3 flex flex-col gap-1.5">
                      <span className="text-[12px] text-muted">② 粘贴 code(或整段回调 URL,自动抽 code):</span>
                      <div className="flex gap-2">
                        <Input
                          value={oauthCode}
                          onChange={(e) => setOauthCode(e.target.value)}
                          placeholder="粘 code 或 URL"
                          className="flex-1"
                        />
                        <Button size="sm" variant="accent" onClick={exchangeOAuth} disabled={exchanging}>
                          {exchanging ? <Spinner className="size-4" /> : "③ 换 token"}
                        </Button>
                      </div>
                    </div>
                  )}
                </>
              )}
              {oauthHint && <p className="mt-2 text-[12px] text-muted">{oauthHint}</p>}
              {tokenFilled && (
                <p className="mt-2 flex items-center gap-1 text-[12px] text-success">
                  <CheckCircle2 size={13} /> token 已写入下方表单,核对 label/plan 后点"创建"。
                </p>
              )}
            </div>
          )}

          {provider === "cursor" && (
            <div className="flex items-center justify-between rounded-lg border border-border bg-subtle p-3">
              <div className="flex flex-col">
                <span className="text-[13px] font-medium text-fg">启用 Sand 客户端模式</span>
                <span className="text-[11px] text-muted">
                  调用 Cursor Agent CLI 时携带 Sand 客户端请求头 (x-cursor-client-type: sand)
                </span>
              </div>
              <label className="relative inline-flex cursor-pointer items-center">
                <input
                  type="checkbox"
                  checked={cursorSandEnabled}
                  onChange={(e) => setCursorSandEnabled(e.target.checked)}
                  className="size-4 rounded border-border text-accent focus:ring-accent"
                />
              </label>
            </div>
          )}

          {provider === "cursor" && (
            <Field
              label="Cursor 配额分类 (Quota Class)"
              hint="两池调度控制：cursor_only 会跳过 Opus 等高级模型；手动切为「未观察」或「全部可用」可直接放开调度限制。"
            >
              <Select
                value={cursorQuotaClass}
                onChange={(e) => setCursorQuotaClass(e.target.value as "unknown" | "other_ok" | "cursor_only")}
              >
                <option value="unknown">未观察 (unknown - 允许全模型调度)</option>
                <option value="other_ok">全部可用 (other_ok - 已验证全模型可用)</option>
                <option value="cursor_only">仅 Cursor Models (cursor_only - 跳过 Opus/GPT-5.6)</option>
              </Select>
            </Field>
          )}

          <Field label="label(账号标签,必填)">
            <Input value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="plan">
              <Select value={plan} onChange={(e) => setPlan(e.target.value)}>
                {ACCOUNT_PLANS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </Select>
            </Field>
            {!isCreate && (
              <Field label="status">
                <Select value={statusEdit} onChange={(e) => setStatusEdit(e.target.value)}>
                  {ACCOUNT_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>

          <Field label={provider === "cursor"
            ? `Cursor API Key ${isCreate ? "(必填)" : "(留空则不修改)"}`
            : `oauth_token ${isCreate ? "(必填)" : "(留空则不修改)"}`}>
            <Textarea
              value={token}
              rows={2}
              onChange={(e) => setToken(e.target.value)}
              placeholder={isCreate
                ? (provider === "cursor" ? "粘贴 crsr_ 开头的 Cursor API Key" : "粘贴 OAuth access token")
                : "不动 → 留空"}
            />
          </Field>

          {provider !== "cursor" && <Field label={`oauth_refresh_token ${isCreate ? "(可选)" : "(留空不改;输入 NULL 清空)"}`}>
            <Input value={refresh} onChange={(e) => setRefresh(e.target.value)} placeholder="可选" />
          </Field>}

          {provider !== "cursor" && <Field label={`oauth_expires_at ${isCreate ? "(可选 ISO 时间)" : "(留空不动;输入 NULL 清空)"}`}>
            <Input
              value={expires}
              onChange={(e) => setExpires(e.target.value)}
              placeholder="如 2026-12-31T00:00:00Z 或 NULL"
            />
          </Field>}

          <Field
            label={`subscription_end_at ${isCreate ? "(可选;订阅到期日)" : "(留空不动;输入 NULL 清空)"}`}
            hint="管理员手填;NULL = 未知(调度器中性 1.0)。快到期账号 WRH 自动加权,订阅到期前榨干额度。"
          >
            <Input
              value={subEnd}
              onChange={(e) => setSubEnd(e.target.value)}
              placeholder="如 2026-12-31 或 2026-12-31T00:00:00Z 或 NULL"
            />
          </Field>

          <Field label="账号分组(官方 OAuth)" hint="绑定该 provider 的 official_oauth 分组。">
            <Select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
              <option value="">{defaultGroupLabel}</option>
              {groupOptions.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.label} #{g.id}
                  {g.enabled ? "" : " (disabled)"}
                </option>
              ))}
            </Select>
          </Field>

        </div>
      )}
    </Modal>
  );
}
