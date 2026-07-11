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

  // OAuth 向导(create)。
  const [oauthState, setOauthState] = useState<string | null>(null);
  const [oauthCode, setOauthCode] = useState("");
  const [step2, setStep2] = useState(false);
  const [oauthHint, setOauthHint] = useState<string | null>(null);
  const [authUrlFallback, setAuthUrlFallback] = useState<string | null>(null);
  const [exchanging, setExchanging] = useState(false);
  const [tokenFilled, setTokenFilled] = useState(false);

  const provider = account?.provider || "claude";
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
    setOauthState(null);
    setOauthCode("");
    setStep2(false);
    setOauthHint(null);
    setAuthUrlFallback(null);
    setTokenFilled(false);
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

  const groupProvider = provider === "codex" ? "codex" : "claude";
  const groupOptions = groups.filter((g) => g.provider === groupProvider);
  const egressInActive = proxies.some((p) => String(p.id) === egressId);

  const startOAuth = useCallback(async () => {
    try {
      const r = await adminSend<{ authUrl?: string; state?: string }>(
        "POST",
        "/accounts/oauth/start",
        { provider: "claude" },
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
  }, [toast]);

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
        toast("oauth_token 必填", "error");
        return;
      }
      if (!egressId) {
        toast("egress 代理池条目 必选", "error");
        return;
      }
      body.oauth_token = tk;
      body.egress_proxy_id = egressId;
      body.provider = provider;
      if (refresh.trim()) body.oauth_refresh_token = isNull(refresh) ? null : refresh.trim();
      if (expires.trim()) body.oauth_expires_at = isNull(expires) ? null : expires.trim();
      if (subEnd.trim()) body.subscription_end_at = isNull(subEnd) ? null : subEnd.trim();
      if (groupId) body.group_id = groupId;
    } else {
      body.status = statusEdit;
      if (token.trim()) body.oauth_token = token.trim();
      if (refresh.trim()) body.oauth_refresh_token = isNull(refresh) ? null : refresh.trim();
      if (expires.trim()) body.oauth_expires_at = isNull(expires) ? null : expires.trim();
      if (subEnd.trim()) body.subscription_end_at = isNull(subEnd) ? null : subEnd.trim();
      if (!egressId) {
        toast("egress 代理池条目 不可清空", "error");
        return;
      }
      if (egressId !== prefillEgress) body.egress_proxy_id = egressId;
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
    statusEdit, prefillEgress, prefillGroup, account, onOpenChange, onSaved, toast,
  ]);

  const defaultGroupLabel = isCreate ? "— 默认 Claude 官方订阅组 —" : "— 未绑定 —";

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
      ) : isCreate && proxies.length === 0 ? (
        <div className="py-8 text-center text-sm text-warning">
          代理池没有 active 条目,请先到「代理池」页新建并启用一条。
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {isCreate && (
            <div className="rounded-lg border border-accent/40 bg-accent-soft/50 p-3.5">
              <div className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-fg">
                <KeyRound size={15} className="text-accent" /> OAuth 授权(推荐)
              </div>
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
              {oauthHint && <p className="mt-2 text-[12px] text-muted">{oauthHint}</p>}
              {tokenFilled && (
                <p className="mt-2 flex items-center gap-1 text-[12px] text-success">
                  <CheckCircle2 size={13} /> token 已写入下方表单,核对 label/plan 后点"创建"。
                </p>
              )}
            </div>
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

          <Field label={`oauth_token ${isCreate ? "(必填)" : "(留空则不修改)"}`}>
            <Textarea
              value={token}
              rows={2}
              onChange={(e) => setToken(e.target.value)}
              placeholder={isCreate ? "粘贴 OAuth access token" : "不动 → 留空"}
            />
          </Field>

          <Field label={`oauth_refresh_token ${isCreate ? "(可选)" : "(留空不改;输入 NULL 清空)"}`}>
            <Input value={refresh} onChange={(e) => setRefresh(e.target.value)} placeholder="可选" />
          </Field>

          <Field label={`oauth_expires_at ${isCreate ? "(可选 ISO 时间)" : "(留空不动;输入 NULL 清空)"}`}>
            <Input
              value={expires}
              onChange={(e) => setExpires(e.target.value)}
              placeholder="如 2026-12-31T00:00:00Z 或 NULL"
            />
          </Field>

          <Field
            label={`subscription_end_at ${isCreate ? "(可选;Anthropic 订阅到期日)" : "(留空不动;输入 NULL 清空)"}`}
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

          <Field
            label={`egress 代理池条目${isCreate ? "(必选)" : "(必选;不可清空)"}`}
            hint={`从「代理池」页维护可用条目;此处仅显示 active 项${
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
          </Field>
        </div>
      )}
    </Modal>
  );
}
