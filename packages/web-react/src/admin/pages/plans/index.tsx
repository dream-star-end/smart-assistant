import { CreditCard, Inbox, Pencil, RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Modal,
  Switch,
  useConfirm,
  useToast,
} from "../../../components/ui";
import { KeyValue, PageHeader } from "../../components";
import { adminGet, adminSend, apiErrorMessage } from "../../lib/adminApi";
import { getAdminPage } from "../../registry";

type PlanRow = {
  id: string;
  code: string;
  label: string;
  amount_cents: string;
  credits: string;
  sort_order: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

function fmtCents(cents: string | number | null | undefined): string {
  if (cents == null) return "¥0.00";
  const s = String(cents);
  if (!/^-?\d+$/.test(s)) return "¥0.00";
  const negative = s.startsWith("-");
  const digits = negative ? s.slice(1) : s;
  const padded = digits.padStart(3, "0");
  const yuan = padded.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fen = padded.slice(-2);
  return `${negative ? "-" : ""}¥${yuan}.${fen}`;
}

function EditPlanModal({
  plan,
  onClose,
  onSaved,
}: {
  plan: PlanRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [credits, setCredits] = useState("");
  const [sort, setSort] = useState("0");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!plan) return;
    setLabel(plan.label);
    setAmount(String(plan.amount_cents));
    setCredits(String(plan.credits));
    setSort(String(plan.sort_order));
  }, [plan]);

  const submit = async () => {
    if (!plan) return;
    const sortNum = Number(sort);
    if (!Number.isInteger(sortNum)) {
      toast("排序必须是整数", "error");
      return;
    }
    setSaving(true);
    try {
      await adminSend("PATCH", `/plans/${encodeURIComponent(plan.code)}`, {
        label,
        amount_cents: amount.trim(),
        credits: credits.trim(),
        sort_order: sortNum,
        enabled: plan.enabled,
      });
      toast("已保存", "success");
      onSaved();
      onClose();
    } catch (e) {
      toast(`失败：${apiErrorMessage(e, "请求失败")}`, "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={plan !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={plan ? `编辑套餐 · ${plan.code}` : "编辑套餐"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" onClick={submit} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        <label className="flex flex-col gap-1.5 text-meta font-medium text-fg">
          label
          <Input className="oc-field-control" value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1.5 text-meta font-medium text-fg">
          amount_cents(支付金额,单位:分;¥1 = 100)
          <Input value={amount} onChange={(e) => setAmount(e.target.value)} className="oc-field-control font-mono tabular-nums" />
        </label>
        <label className="flex flex-col gap-1.5 text-meta font-medium text-fg">
          credits(到账余额,单位:分;可大于 amount 表赠送)
          <Input value={credits} onChange={(e) => setCredits(e.target.value)} className="oc-field-control font-mono tabular-nums" />
        </label>
        <label className="flex flex-col gap-1.5 text-meta font-medium text-fg">
          sort_order
          <Input
            type="number"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            className="oc-field-control font-mono tabular-nums"
          />
        </label>
      </div>
    </Modal>
  );
}

export default function PlansPage() {
  const meta = getAdminPage("plans");
  const toast = useToast();
  const [confirm, confirmEl] = useConfirm();

  const [rows, setRows] = useState<PlanRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [editing, setEditing] = useState<PlanRow | null>(null);
  const [togglingCode, setTogglingCode] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const data = await adminGet<{ rows: PlanRow[] }>("/plans");
        if (alive) setRows(data.rows ?? []);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [reloadTick]);

  const reload = () => setReloadTick((t) => t + 1);

  const toggleEnabled = async (plan: PlanRow, next: boolean) => {
    if (!next) {
      const ok = await confirm({
        title: `下架套餐 ${plan.code}?`,
        body: "下架后用户无法再购买该套餐。",
        danger: true,
        confirmText: "确认下架",
      });
      if (!ok) return;
    }
    setTogglingCode(plan.code);
    try {
      await adminSend("PATCH", `/plans/${encodeURIComponent(plan.code)}`, { enabled: next });
      toast(next ? `${plan.code} 已上架` : `${plan.code} 已下架`, "success");
      reload();
    } catch (e) {
      toast(`操作失败：${apiErrorMessage(e, "请求失败")}`, "error");
    } finally {
      setTogglingCode(null);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        icon={CreditCard}
        title={meta.title}
        desc={meta.desc}
        actions={
          <Button variant="secondary" size="sm" onClick={reload}>
            <RotateCw size={15} />
            刷新
          </Button>
        }
      />

      {error ? (
        <div className="oc-surface-card rounded-xl">
          <EmptyState
            icon={Inbox}
            title="加载失败"
            hint={apiErrorMessage(error, "加载失败")}
            action={
              <Button variant="secondary" size="sm" onClick={reload}>
                重试
              </Button>
            }
          />
        </div>
      ) : loading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="oc-surface-card h-44 animate-pulse rounded-xl" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="oc-surface-card rounded-xl">
          <EmptyState icon={Inbox} title="无套餐" />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((p) => (
            <Card key={p.code} className="oc-surface-card-hover flex flex-col gap-3.5 rounded-xl p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span
                    className={`oc-icon-badge size-9 rounded-lg ${
                      p.enabled ? "oc-icon-badge-accent" : ""
                    }`}
                  >
                    <CreditCard size={16} strokeWidth={1.9} />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-title font-semibold tracking-tight text-fg">{p.label}</p>
                    <span className="font-mono text-caption text-faint">{p.code}</span>
                  </div>
                </div>
                <Badge tone={p.enabled ? "success" : "neutral"}>{p.enabled ? "上架" : "下架"}</Badge>
              </div>
              <div className="oc-surface-recessed grid grid-cols-2 gap-3 rounded-xl p-3">
                <div>
                  <p className="text-caption text-faint">支付金额</p>
                  <p className="mt-1 text-lg font-semibold leading-none tracking-tight text-fg tabular-nums">
                    {fmtCents(p.amount_cents)}
                  </p>
                </div>
                <div className="border-l border-border/70 pl-3">
                  <p className="text-caption text-faint">到账余额</p>
                  <p className="mt-1 text-lg font-semibold leading-none tracking-tight text-accent tabular-nums">
                    {fmtCents(p.credits)}
                  </p>
                </div>
              </div>
              <div className="flex flex-col gap-0.5">
                <KeyValue label="排序" value={<span className="tabular-nums">{p.sort_order}</span>} />
              </div>
              <div className="flex items-center justify-between border-t border-border/70 pt-3">
                <label className="flex items-center gap-2 text-meta text-muted">
                  <Switch
                    checked={p.enabled}
                    disabled={togglingCode === p.code}
                    onCheckedChange={(next) => toggleEnabled(p, next)}
                    aria-label="上下架"
                  />
                  {p.enabled ? "已上架" : "已下架"}
                </label>
                <Button variant="secondary" size="sm" onClick={() => setEditing(p)}>
                  <Pencil size={14} />
                  编辑
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <EditPlanModal plan={editing} onClose={() => setEditing(null)} onSaved={reload} />
      {confirmEl}
    </div>
  );
}
