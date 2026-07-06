// 契约注意：createOrgInvoice(auth, orderIds) 期望 orders 表主键 **id**（BIGINT 字符串），
// 但批次 B 的 GET /api/org/orders 当前 OrgOrder 类型只暴露 order_no。批次 B 尚在并行开发。
// 处理：若订单对象带 id 字段则优先用它（orderPk），否则退化用 order_no。若最终仅有
// order_no，需与批次 B 对齐 createInvoiceRequest 入参（后端按 id 或 order_no 二选一定契约）。
import { FileText, ReceiptText } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { api } from "../../lib/api";
import type {
  AuthSession,
  OrgInvoiceProfile,
  OrgInvoiceRequest,
  OrgOrder,
} from "../../lib/types";
import { cn, formatCentsYuan } from "../../lib/utils";
import { Alert, Badge, Button, Input, Spinner, useToast } from "../ui";
import { shortTime } from "../settings/labels";
import { orgErrText } from "../OrgCenter";

/** 订单主键：优先 id（批次 B 可能补），退化 order_no。见文件顶部契约注释。 */
function orderPk(o: OrgOrder): string {
  const id = (o as { id?: string }).id;
  return id != null && id !== "" ? id : o.order_no;
}

/** 发票申请状态 → 中文 + 色调。 */
function reqStatusMeta(status: OrgInvoiceRequest["status"]): {
  label: string;
  tone: "info" | "success" | "danger";
} {
  switch (status) {
    case "pending":
      return { label: "待处理", tone: "info" };
    case "issued":
      return { label: "已开具", tone: "success" };
    case "rejected":
      return { label: "已拒绝", tone: "danger" };
    default:
      return { label: status, tone: "info" };
  }
}

/** 安全求和字符串大数（BigInt 精确，非法项跳过）。 */
function sumCents(vals: string[]): string {
  let acc = 0n;
  for (const v of vals) {
    if (/^-?\d+$/.test(v)) {
      try {
        acc += BigInt(v);
      } catch {
        /* skip */
      }
    }
  }
  return acc.toString();
}

/**
 * 发票：抬头表单（title 必填）+ 按已支付订单勾选申请 + 申请状态列表。
 * 抬头/申请列表走批次 D（本文件权威）；订单列表走批次 B（可能 404/501），失败时该区
 * 独立降级为 Alert，不影响抬头与申请列表。大数（amount_cents）全程字符串。
 */
export function InvoicesTab({ auth }: { auth: AuthSession }) {
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<OrgInvoiceProfile | null>(null);
  const [orders, setOrders] = useState<OrgOrder[]>([]);
  const [ordersErr, setOrdersErr] = useState<string | null>(null);
  const [invoices, setInvoices] = useState<OrgInvoiceRequest[]>([]);
  const [invoicesErr, setInvoicesErr] = useState<string | null>(null);

  // 抬头表单
  const [title, setTitle] = useState("");
  const [taxId, setTaxId] = useState("");
  const [address, setAddress] = useState("");
  const [email, setEmail] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);

  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [submitting, setSubmitting] = useState(false);

  const toast = useToast();

  // 首次挂载并发拉三块；各自独立降级（批次 B 的订单失败不拖垮批次 D 的抬头/申请）。
  // 依赖数组不含 loading，防转圈。
  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.allSettled([
      api.getOrgInvoiceProfile(auth),
      api.listOrgOrders(auth),
      api.listOrgInvoices(auth),
    ]).then(([pr, or, ir]) => {
      if (!alive) return;
      if (pr.status === "fulfilled") {
        const p = pr.value;
        setProfile(p);
        if (p) {
          setTitle(p.title ?? "");
          setTaxId(p.tax_id ?? "");
          setAddress(p.address ?? "");
          setEmail(p.email ?? "");
        }
      }
      if (or.status === "fulfilled") setOrders(or.value);
      else setOrdersErr(orgErrText(or.reason, "加载订单失败"));
      if (ir.status === "fulfilled") setInvoices(ir.value);
      else setInvoicesErr(orgErrText(ir.reason, "加载开票申请失败"));
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [auth]);

  async function reloadInvoices() {
    try {
      setInvoices(await api.listOrgInvoices(auth));
      setInvoicesErr(null);
    } catch (e) {
      setInvoicesErr(orgErrText(e, "刷新开票申请失败"));
    }
  }

  async function saveProfile(e: FormEvent) {
    e.preventDefault();
    if (!title.trim() || savingProfile) return;
    setSavingProfile(true);
    try {
      const p = await api.putOrgInvoiceProfile(auth, {
        title: title.trim(),
        tax_id: taxId.trim() || null,
        address: address.trim() || null,
        email: email.trim() || null,
      });
      setProfile(p);
      toast("发票抬头已保存", "success");
    } catch (err) {
      toast(orgErrText(err, "保存抬头失败"), "error");
    } finally {
      setSavingProfile(false);
    }
  }

  const paidOrders = orders.filter((o) => o.status === "paid");
  const selectedTotal = sumCents(
    paidOrders.filter((o) => selected.has(orderPk(o))).map((o) => o.amount_cents),
  );

  function toggleOrder(pk: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(pk)) next.delete(pk);
      else next.add(pk);
      return next;
    });
  }

  async function submitInvoice() {
    const ids = Array.from(selected);
    if (ids.length === 0 || submitting) return;
    if (!profile?.title) {
      toast("请先保存发票抬头", "error");
      return;
    }
    setSubmitting(true);
    try {
      await api.createOrgInvoice(auth, ids);
      setSelected(new Set<string>());
      await reloadInvoices();
      toast("开票申请已提交", "success");
    } catch (e) {
      toast(orgErrText(e, "提交开票申请失败"), "error");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-faint">
        <Spinner /> 加载发票…
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {/* 发票抬头 */}
      <form onSubmit={saveProfile} className="px-5 py-4">
        <div className="flex items-center gap-1.5 pb-2 text-[11px] font-medium uppercase tracking-wide text-faint">
          <FileText size={13} /> 发票抬头
        </div>
        <div className="flex flex-col gap-2.5">
          <Field label="发票抬头" required>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="公司全称"
              required
            />
          </Field>
          <Field label="税号">
            <Input
              value={taxId}
              onChange={(e) => setTaxId(e.target.value)}
              placeholder="统一社会信用代码"
            />
          </Field>
          <Field label="地址">
            <Input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="开票地址（选填）"
            />
          </Field>
          <Field label="接收邮箱">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="电子发票接收邮箱（选填）"
            />
          </Field>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={savingProfile || title.trim().length === 0}
          >
            {savingProfile ? <Spinner size={14} /> : null}
            保存抬头
          </Button>
          {profile?.updated_at && (
            <span className="text-[11.5px] text-faint">上次更新 {shortTime(profile.updated_at)}</span>
          )}
        </div>
      </form>

      {/* 按订单申请开票 */}
      <div className="border-t border-border px-5 py-4">
        <div className="pb-2 text-[11px] font-medium uppercase tracking-wide text-faint">
          选择已支付订单申请开票
        </div>
        {ordersErr ? (
          <Alert tone="warning" className="text-[12.5px]">
            {ordersErr}
          </Alert>
        ) : paidOrders.length === 0 ? (
          <p className="py-2 text-[12.5px] text-faint">暂无可开票的已支付订单。</p>
        ) : (
          <>
            <ul className="flex flex-col gap-1">
              {paidOrders.map((o) => {
                const pk = orderPk(o);
                const checked = selected.has(pk);
                return (
                  <li key={pk}>
                    <label
                      className={cn(
                        "flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 transition-colors",
                        checked ? "border-accent/50 bg-accent-soft" : "border-border hover:bg-hover",
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleOrder(pk)}
                        className="size-4 shrink-0 accent-[var(--accent,#6d5efc)]"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-[12.5px] text-fg">
                          {o.order_no}
                        </span>
                        <span className="block truncate text-[11.5px] text-faint">
                          {o.paid_at ? shortTime(o.paid_at) : shortTime(o.created_at)}
                        </span>
                      </span>
                      <span className="shrink-0 text-[13px] font-medium tabular-nums text-fg">
                        {formatCentsYuan(o.amount_cents)}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <span className="text-[12.5px] text-muted">
                已选 {selected.size} 笔 · 合计{" "}
                <span className="font-medium text-fg">{formatCentsYuan(selectedTotal)}</span>
              </span>
              <Button
                variant="primary"
                size="sm"
                onClick={submitInvoice}
                disabled={submitting || selected.size === 0}
              >
                {submitting ? <Spinner size={14} /> : null}
                申请开票
              </Button>
            </div>
            {!profile?.title && (
              <p className="mt-1.5 text-[11.5px] text-warning">请先在上方保存发票抬头再申请。</p>
            )}
          </>
        )}
      </div>

      {/* 申请状态 */}
      <div className="border-t border-border px-5 py-4">
        <div className="flex items-center gap-1.5 pb-2 text-[11px] font-medium uppercase tracking-wide text-faint">
          <ReceiptText size={13} /> 开票申请
        </div>
        {invoicesErr ? (
          <Alert tone="warning" className="text-[12.5px]">
            {invoicesErr}
          </Alert>
        ) : invoices.length === 0 ? (
          <p className="py-2 text-[12.5px] text-faint">暂无开票申请。</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {invoices.map((inv) => {
              const sm = reqStatusMeta(inv.status);
              return (
                <li key={inv.id} className="rounded-lg border border-border px-3 py-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[13.5px] font-medium tabular-nums text-fg">
                      {formatCentsYuan(inv.amount_cents)}
                    </span>
                    <Badge tone={sm.tone}>{sm.label}</Badge>
                  </div>
                  <div className="mt-1 text-[11.5px] text-faint">
                    {inv.profile_snapshot?.title ? `${inv.profile_snapshot.title} · ` : ""}
                    {inv.order_ids.length} 笔订单 · {shortTime(inv.created_at)}
                  </div>
                  {inv.admin_note && (
                    <div className="mt-1 text-[11.5px] text-muted">备注：{inv.admin_note}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] text-muted">
        {label}
        {required && <span className="ml-0.5 text-danger">*</span>}
      </span>
      {children}
    </label>
  );
}
