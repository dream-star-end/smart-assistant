import { Building2, Inbox, Plus, RotateCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Modal,
  Textarea,
  useConfirm,
  useToast,
} from "../../../components/ui";
import {
  type Column,
  DataTable,
  FilterBar,
  KeyValue,
  PageHeader,
  SectionCard,
  SelectFilter,
} from "../../components";
import { adminGet, adminSend, ApiError } from "../../lib/adminApi";
import { getAdminPage } from "../../registry";

type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info" | "accent";

const ORG_STATUS_OPTIONS = ["active", "suspended", "deleting", "deleted"] as const;
const ORG_STATUS_TONE: Record<string, BadgeTone> = {
  active: "success",
  suspended: "warning",
  deleting: "warning",
  deleted: "neutral",
};
const INVOICE_STATUS_LABELS: Record<string, string> = {
  pending: "待处理",
  issued: "已开票",
  rejected: "已拒绝",
};
const INVOICE_STATUS_TONE: Record<string, BadgeTone> = {
  pending: "warning",
  issued: "success",
  rejected: "danger",
};

type OrgRow = {
  id: string;
  name: string;
  status: string;
  credits: string;
  max_members: number | null;
  member_count?: number;
  created_at: string;
  subscription?: { plan_code: string; seats: number; period_end: string; status: string } | null;
};
type InvoiceRow = {
  id: string;
  org_id: string;
  org_name: string | null;
  order_ids: string[] | string | null;
  amount_cents: string;
  status: string;
  admin_note: string | null;
  created_at: string;
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
function fmtDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** 人民币字符串 → 分整数;拒绝空/非数字/超2位小数/零/超¥100万,与后端硬 cap 一致。 */
function parseYuanToCents(input: string): number | null {
  const MAX = 100_000_000;
  const trimmed = input.trim().replace(/^¥/, "").replace(/^\+/, "");
  if (trimmed === "") return null;
  const m = /^(-?)(\d{1,10})(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!m) return null;
  const negative = m[1] === "-";
  const fracPart = (m[3] ?? "").padEnd(2, "0");
  const combined = `${m[2]}${fracPart}`.replace(/^0+(?=\d)/, "");
  if (combined === "0" || combined === "") return null;
  const cents = Number(combined);
  if (!Number.isFinite(cents) || !Number.isInteger(cents) || cents > MAX) return null;
  return negative ? -cents : cents;
}

// ── 新建组织 ──
function CreateOrgModal({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [owner, setOwner] = useState("");
  const [maxMembers, setMaxMembers] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) {
      setName("");
      setOwner("");
      setMaxMembers("");
    }
  }, [open]);
  const submit = async () => {
    if (!name.trim()) {
      toast("请填写组织名称", "error");
      return;
    }
    if (!owner.trim()) {
      toast("请填写 owner 邮箱", "error");
      return;
    }
    const body: Record<string, unknown> = { name: name.trim(), owner_email: owner.trim() };
    if (maxMembers.trim()) {
      const n = Number(maxMembers);
      if (!Number.isInteger(n) || n < 1) {
        toast("成员上限必须是正整数", "error");
        return;
      }
      body.max_members = n;
    }
    setSaving(true);
    try {
      await adminSend("POST", "/orgs", body);
      toast("组织已创建", "success");
      onSaved();
      onClose();
    } catch (e) {
      toast(`创建失败：${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="新建组织"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" onClick={submit} disabled={saving}>
            {saving ? "创建中…" : "创建"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-[12px] text-faint">
          组织名称
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-faint">
          owner 邮箱
          <Input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="owner@example.com" />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-faint">
          成员上限(可选)
          <Input type="number" min={1} value={maxMembers} onChange={(e) => setMaxMembers(e.target.value)} />
        </label>
      </div>
    </Modal>
  );
}

// ── 编辑组织 ──
function EditOrgModal({
  org,
  onClose,
  onSaved,
}: {
  org: OrgRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [status, setStatus] = useState<string>("active");
  const [maxMembers, setMaxMembers] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!org) return;
    setName(org.name);
    setStatus(org.status || "active");
    setMaxMembers(org.max_members == null ? "" : String(org.max_members));
  }, [org]);
  const submit = async () => {
    if (!org) return;
    if (!name.trim()) {
      toast("名称不能为空", "error");
      return;
    }
    const body: Record<string, unknown> = { name: name.trim(), status };
    if (maxMembers.trim()) {
      const n = Number(maxMembers);
      if (!Number.isInteger(n) || n < 1) {
        toast("成员上限必须是正整数", "error");
        return;
      }
      body.max_members = n;
    }
    setSaving(true);
    try {
      await adminSend("PATCH", `/orgs/${encodeURIComponent(org.id)}`, body);
      toast("已保存", "success");
      onSaved();
      onClose();
    } catch (e) {
      toast(`保存失败：${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open={org !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={org ? `编辑组织 · ${org.name}` : "编辑组织"}
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
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-[12px] text-faint">
          名称
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="flex flex-col gap-1 text-[12px] text-faint">
          状态
          <SelectFilter
            value={status}
            options={ORG_STATUS_OPTIONS.map((s) => ({ label: s, value: s }))}
            onChange={setStatus}
          />
        </div>
        <label className="flex flex-col gap-1 text-[12px] text-faint">
          成员上限(留空=不改)
          <Input type="number" min={1} value={maxMembers} onChange={(e) => setMaxMembers(e.target.value)} />
        </label>
      </div>
    </Modal>
  );
}

// ── 调余额 ──
function CreditsModal({
  org,
  onClose,
  onSaved,
}: {
  org: OrgRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [delta, setDelta] = useState("");
  const [memo, setMemo] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (org) {
      setDelta("");
      setMemo("");
    }
  }, [org]);
  const cents = parseYuanToCents(delta);
  const preview =
    delta.trim() === "" ? "解析后:—" : cents == null ? "解析后:无效金额" : `解析后:${fmtCents(cents)}(${cents} 分)`;
  const submit = async () => {
    if (!org) return;
    if (cents == null) {
      toast("金额必须是非零数字,最多 2 位小数(如 1.00 / -0.50)", "error");
      return;
    }
    if (!memo.trim()) {
      toast("memo 不能为空", "error");
      return;
    }
    setSaving(true);
    try {
      await adminSend("POST", `/orgs/${encodeURIComponent(org.id)}/credits`, {
        delta: String(cents),
        memo: memo.trim(),
      });
      toast("余额已调整", "success");
      onSaved();
      onClose();
    } catch (e) {
      const status = e instanceof ApiError ? e.status : undefined;
      toast(e instanceof Error ? e.message : String(e), status === 501 ? "info" : "error");
      if (status === 501) onClose();
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open={org !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={org ? `调整组织余额 · ${org.name}` : "调整组织余额"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" onClick={submit} disabled={saving}>
            {saving ? "提交中…" : "提交"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <KeyValue label="当前余额" value={<span className="tabular-nums">{fmtCents(org?.credits)}</span>} />
        <label className="flex flex-col gap-1 text-[12px] text-faint">
          变动金额(¥,正数入账 / 负数扣减,如 1.50 或 -0.25)
          <Input value={delta} onChange={(e) => setDelta(e.target.value)} placeholder="¥ 金额" />
          <span className={`text-[11.5px] ${cents == null && delta.trim() !== "" ? "text-danger" : "text-faint"}`}>
            {preview}
          </span>
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-faint">
          备注(memo)
          <Input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="调整原因" />
        </label>
      </div>
    </Modal>
  );
}

// ── 拒绝开票 ──
function RejectInvoiceModal({
  invoiceId,
  onClose,
  onDone,
}: {
  invoiceId: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (invoiceId) setNote("");
  }, [invoiceId]);
  const submit = async () => {
    if (!invoiceId) return;
    if (!note.trim()) {
      toast("请填写拒绝理由", "error");
      return;
    }
    setSaving(true);
    try {
      await adminSend("PATCH", `/org-invoices/${encodeURIComponent(invoiceId)}`, {
        status: "rejected",
        admin_note: note.trim(),
      });
      toast("已拒绝", "success");
      onDone();
      onClose();
    } catch (e) {
      toast(`操作失败：${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open={invoiceId !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="拒绝开票申请"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="danger" onClick={submit} disabled={saving}>
            {saving ? "提交中…" : "确认拒绝"}
          </Button>
        </>
      }
    >
      <label className="flex flex-col gap-1 text-[12px] text-faint">
        拒绝理由(admin_note,会记录并展示)
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="填写拒绝原因" />
      </label>
    </Modal>
  );
}

export default function OrgPage() {
  const meta = getAdminPage("org");
  const toast = useToast();
  const [confirm, confirmEl] = useConfirm();

  const [orgs, setOrgs] = useState<OrgRow[]>([]);
  const [orgLoading, setOrgLoading] = useState(true);
  const [orgError, setOrgError] = useState<Error | null>(null);
  const [orgReload, setOrgReload] = useState(0);

  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [invLoading, setInvLoading] = useState(true);
  const [invStatus, setInvStatus] = useState<string>("pending");
  const [invOrgFilter, setInvOrgFilter] = useState<{ id: string; name: string } | null>(null);
  const [invReload, setInvReload] = useState(0);

  const [createOpen, setCreateOpen] = useState(false);
  const [editOrg, setEditOrg] = useState<OrgRow | null>(null);
  const [creditsOrg, setCreditsOrg] = useState<OrgRow | null>(null);
  const [rejectInvoiceId, setRejectInvoiceId] = useState<string | null>(null);
  const [issuingId, setIssuingId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setOrgLoading(true);
    setOrgError(null);
    (async () => {
      try {
        const data = await adminGet<{ rows: OrgRow[] }>("/orgs");
        if (alive) setOrgs(data.rows ?? []);
      } catch (e) {
        if (alive) setOrgError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        if (alive) setOrgLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [orgReload]);

  useEffect(() => {
    let alive = true;
    setInvLoading(true);
    (async () => {
      try {
        const data = await adminGet<{ rows: InvoiceRow[] }>("/org-invoices", { status: invStatus });
        if (alive) setInvoices(data.rows ?? []);
      } catch (e) {
        if (alive) toast(`加载开票失败：${e instanceof Error ? e.message : String(e)}`, "error");
      } finally {
        if (alive) setInvLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invStatus, invReload]);

  const issueInvoice = async (id: string) => {
    const ok = await confirm({ title: "确认开票?", body: "确认后该申请转为已开票终态。", confirmText: "确认开票" });
    if (!ok) return;
    setIssuingId(id);
    try {
      await adminSend("PATCH", `/org-invoices/${encodeURIComponent(id)}`, { status: "issued" });
      toast("已开票", "success");
      setInvReload((t) => t + 1);
    } catch (e) {
      toast(`操作失败：${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setIssuingId(null);
    }
  };

  const filteredInvoices = invOrgFilter
    ? invoices.filter((r) => String(r.org_id) === String(invOrgFilter.id))
    : invoices;

  const invoiceColumns: Column<InvoiceRow>[] = [
    {
      key: "org",
      title: "组织",
      render: (r) => (
        <span>
          {r.org_name || ""} <span className="font-mono text-[12px] text-muted">#{r.org_id}</span>
        </span>
      ),
    },
    {
      key: "amount_cents",
      title: "金额",
      align: "right",
      cellClassName: "tabular-nums",
      render: (r) => fmtCents(r.amount_cents),
    },
    {
      key: "order_ids",
      title: "订单",
      cellClassName: "font-mono text-[12px] text-muted",
      render: (r) => {
        const ids = Array.isArray(r.order_ids) ? r.order_ids.join(", ") : String(r.order_ids ?? "");
        return (
          <span className="block max-w-[180px] truncate" title={ids}>
            {ids || "—"}
          </span>
        );
      },
    },
    {
      key: "status",
      title: "状态",
      render: (r) => (
        <Badge tone={INVOICE_STATUS_TONE[r.status] ?? "neutral"}>
          {INVOICE_STATUS_LABELS[r.status] ?? r.status}
        </Badge>
      ),
    },
    {
      key: "created_at",
      title: "申请时间",
      cellClassName: "font-mono text-[12px] tabular-nums text-muted",
      render: (r) => fmtDate(r.created_at),
    },
    { key: "admin_note", title: "备注", render: (r) => r.admin_note || "—" },
    {
      key: "actions",
      title: "操作",
      align: "right",
      render: (r) =>
        r.status === "pending" ? (
          <span className="inline-flex gap-1.5">
            <Button variant="secondary" size="sm" disabled={issuingId === r.id} onClick={() => issueInvoice(r.id)}>
              开票
            </Button>
            <Button variant="danger" size="sm" onClick={() => setRejectInvoiceId(r.id)}>
              拒绝
            </Button>
          </span>
        ) : (
          <span className="text-faint">已处理</span>
        ),
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={meta.title}
        desc={meta.desc}
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => setOrgReload((t) => t + 1)}>
              <RotateCw size={15} />
              刷新
            </Button>
            <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
              <Plus size={15} />
              新建组织
            </Button>
          </>
        }
      />

      {/* 组织列表 */}
      <SectionCard title="组织" hint={orgLoading ? "加载中…" : `共 ${orgs.length} 个`} bodyClassName="p-4">
        {orgError ? (
          <EmptyState
            icon={Inbox}
            title="加载失败"
            hint={orgError.message}
            action={
              <Button variant="secondary" size="sm" onClick={() => setOrgReload((t) => t + 1)}>
                重试
              </Button>
            }
          />
        ) : orgLoading ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-40 animate-pulse rounded-xl border border-border bg-surface" />
            ))}
          </div>
        ) : orgs.length === 0 ? (
          <EmptyState icon={Building2} title="暂无组织" />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {orgs.map((o) => (
              <Card key={o.id} className="flex flex-col gap-2.5 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-[14px] font-semibold text-fg">{o.name}</p>
                    <span className="font-mono text-[11px] text-faint">#{o.id}</span>
                  </div>
                  <Badge tone={ORG_STATUS_TONE[o.status] ?? "neutral"}>{o.status || "—"}</Badge>
                </div>
                <div className="flex flex-col gap-0.5">
                  <KeyValue
                    label="成员"
                    value={
                      <span className="tabular-nums">
                        {o.member_count ?? 0}
                        {o.max_members != null ? ` / ${o.max_members}` : ""}
                      </span>
                    }
                  />
                  <KeyValue
                    label="订阅"
                    value={
                      o.subscription ? (
                        <span>
                          {o.subscription.plan_code} × {o.subscription.seats}
                          <span className="ml-1 text-faint">
                            {o.subscription.status === "active" ? "至 " : "已到期 "}
                            {fmtDate(o.subscription.period_end)}
                          </span>
                        </span>
                      ) : (
                        <Badge tone="neutral">无</Badge>
                      )
                    }
                  />
                  <KeyValue label="余额" value={<span className="tabular-nums">{fmtCents(o.credits)}</span>} />
                </div>
                <div className="flex flex-wrap justify-end gap-1.5 border-t border-border pt-3">
                  <Button variant="ghost" size="sm" onClick={() => setEditOrg(o)}>
                    编辑
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setCreditsOrg(o)}>
                    调余额
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setInvOrgFilter({ id: o.id, name: o.name });
                      setInvStatus("");
                    }}
                  >
                    发票
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </SectionCard>

      {/* 开票申请 */}
      <SectionCard
        title="开票申请"
        hint={`共 ${filteredInvoices.length} 条`}
        bodyClassName="flex flex-col gap-3 p-4"
      >
        <FilterBar>
          <SelectFilter
            label="状态"
            value={invStatus}
            options={[
              { label: "待处理", value: "pending" },
              { label: "已开票", value: "issued" },
              { label: "已拒绝", value: "rejected" },
              { label: "全部", value: "" },
            ]}
            onChange={setInvStatus}
          />
          {invOrgFilter && (
            <span className="inline-flex items-center gap-1.5 rounded-md bg-accent-soft px-2 py-1 text-[12px] text-accent">
              已筛选组织:<strong>{invOrgFilter.name}</strong>
              <button
                type="button"
                aria-label="清除组织筛选"
                onClick={() => setInvOrgFilter(null)}
                className="rounded p-0.5 hover:bg-accent/10"
              >
                <X size={13} />
              </button>
            </span>
          )}
          <Button variant="secondary" size="sm" onClick={() => setInvReload((t) => t + 1)}>
            刷新
          </Button>
        </FilterBar>
        <DataTable
          columns={invoiceColumns}
          rows={filteredInvoices}
          rowKey={(r) => r.id}
          loading={invLoading}
          emptyTitle="暂无开票申请"
        />
      </SectionCard>

      <CreateOrgModal open={createOpen} onClose={() => setCreateOpen(false)} onSaved={() => setOrgReload((t) => t + 1)} />
      <EditOrgModal org={editOrg} onClose={() => setEditOrg(null)} onSaved={() => setOrgReload((t) => t + 1)} />
      <CreditsModal org={creditsOrg} onClose={() => setCreditsOrg(null)} onSaved={() => setOrgReload((t) => t + 1)} />
      <RejectInvoiceModal
        invoiceId={rejectInvoiceId}
        onClose={() => setRejectInvoiceId(null)}
        onDone={() => setInvReload((t) => t + 1)}
      />
      {confirmEl}
    </div>
  );
}
