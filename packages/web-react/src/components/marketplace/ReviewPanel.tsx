import { Check, ChevronRight, Loader2, ShieldX, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { AuthSession, MarketplacePending } from "../../lib/types";
import { Alert, Badge, Button, Input, Spinner } from "../ui";
import { friendlyRiskFlags } from "./riskFlags";

/** 管理员审核：待审队列(批准/拒绝)+ 下架(kill-switch)。后端 requireAdminVerifyDb 二次把关。 */
export function ReviewPanel({ auth }: { auth: AuthSession }) {
  const [rows, setRows] = useState<MarketplacePending[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    api
      .adminMarketplacePending(auth)
      .then((r) => alive && setRows(r))
      .catch((e) => alive && setErr((e as Error).message || "加载待审失败"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [auth, reload]);

  const review = useCallback(
    async (versionId: string, decision: "approve" | "reject") => {
      if (decision === "reject" && !confirm("拒绝该版本？")) return;
      setBusy(versionId);
      setErr(null);
      try {
        await api.adminMarketplaceReview(auth, versionId, decision);
        setReload((n) => n + 1);
      } catch (e) {
        setErr((e as Error).message || "审核失败");
      } finally {
        setBusy(null);
      }
    },
    [auth],
  );

  return (
    <div className="flex flex-col">
      {err && (
        <div className="px-4 pt-3">
          <Alert tone="danger">{err}</Alert>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-faint">
          <Spinner /> 加载待审…
        </div>
      ) : !rows || rows.length === 0 ? (
        <p className="px-5 py-10 text-center text-[13px] text-faint">暂无待审版本。</p>
      ) : (
        <ul className="flex flex-col gap-2 px-4 py-4">
          {rows.map((r) => {
            const isOpen = open === r.versionId;
            const flags = friendlyRiskFlags(r.riskFlags);
            return (
              <li
                key={r.versionId}
                className="overflow-hidden rounded-xl border border-border bg-elevated"
              >
                <div className="flex items-center gap-2 px-3.5 py-3">
                  <button
                    type="button"
                    onClick={() => setOpen(isOpen ? null : r.versionId)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none"
                  >
                    <ChevronRight
                      size={15}
                      className={`shrink-0 text-faint transition-transform ${isOpen ? "rotate-90" : ""}`}
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[13.5px] font-medium text-fg">{r.name}</span>
                        <Badge tone="neutral">v{r.version}</Badge>
                        {flags.length > 0 && <Badge tone="warning">{flags.length} 项提示</Badge>}
                      </div>
                      <p className="truncate text-[12px] text-muted">
                        {r.slug} · 提交者 #{r.submittedBy}
                      </p>
                    </div>
                  </button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => review(r.versionId, "reject")}
                    disabled={busy === r.versionId}
                    aria-label="拒绝"
                  >
                    <X size={15} />
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => review(r.versionId, "approve")}
                    disabled={busy === r.versionId}
                  >
                    {busy === r.versionId ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Check size={14} />
                    )}
                    批准
                  </Button>
                </div>

                {isOpen && (
                  <div className="border-t border-border px-3.5 py-3">
                    <p className="mb-2 text-[12.5px] text-fg">{r.description}</p>
                    {flags.length > 0 && (
                      <div className="mb-2 flex flex-col gap-1.5">
                        {flags.map((f) => (
                          <Alert key={f.label} tone={f.tone}>
                            <span className="font-medium">{f.label}：</span>
                            {f.message}
                          </Alert>
                        ))}
                      </div>
                    )}
                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-code px-3 py-2 font-mono text-[12px] leading-relaxed text-fg">
                      {r.rawSkillMd}
                    </pre>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <RevokeBox auth={auth} />
    </div>
  );
}

/** 下架(kill-switch)：撤销一个已上架条目,下次容器同步自动从所有用户移除。 */
function RevokeBox({ auth }: { auth: AuthSession }) {
  const [slug, setSlug] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  const revoke = async () => {
    if (!slug.trim()) return;
    if (!confirm(`下架「${slug}」？所有已安装用户将在下次会话被移除该技能。`)) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.adminMarketplaceRevoke(auth, slug.trim(), reason.trim() || undefined);
      setMsg({ tone: "success", text: `已下架，影响 ${r.affectedInstalls} 个已安装用户。` });
      setSlug("");
      setReason("");
    } catch (e) {
      setMsg({ tone: "danger", text: (e as Error).message || "下架失败" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="m-4 mt-2 rounded-xl border border-danger/30 bg-danger-soft/40 p-3.5">
      <div className="mb-2 flex items-center gap-1.5 text-[13px] font-medium text-danger">
        <ShieldX size={15} /> 下架已上架条目（kill-switch）
      </div>
      {msg && (
        <div className="mb-2">
          <Alert tone={msg.tone}>{msg.text}</Alert>
        </div>
      )}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="slug" />
        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="下架原因（可选）"
        />
        <Button variant="danger" onClick={revoke} disabled={busy || !slug.trim()}>
          {busy ? <Loader2 size={15} className="animate-spin" /> : "下架"}
        </Button>
      </div>
    </div>
  );
}
