import * as Dialog from "@radix-ui/react-dialog";
import { ArrowLeft, ArrowRight, Building2, Check, Minus, Plus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import {
  canLeaveNameStep,
  canLeavePlanStep,
  clampSeats,
  computeSeatTotal,
} from "../../lib/orgBilling";
import type { AuthSession, OrgPayResult, OrgPlan } from "../../lib/types";
import { cn, formatCentsYuan, formatCredits } from "../../lib/utils";
import { Alert, Button, Input, Spinner, useToast } from "../ui";
import { orgErrText } from "./orgShared";
import { OrgPaySuccess, OrgPayQr } from "./OrgPayQr";

type Step = "name" | "plan";
type Phase =
  | { kind: "form" }
  | { kind: "qr"; order: OrgPayResult; totalCents: string; note: string }
  | { kind: "done" };

/**
 * 创建组织向导(自助开通,对齐 Claude/GPT 范式)。三步:①组织名 ②选档+席位(实时算总价)
 * ③扫码到账。到账后 onCreated(App 重拉 /api/me,org 字段出现)→ 呈欢迎 toast。
 *
 * 本组件仅渲染步骤主体(无 Dialog/Modal 外壳),由父层提供容器:
 *   - OrgCenter 无 org 分支:直接嵌入中心弹层 body(而非空态);
 *   - 设置·账户页「创建组织」CTA:包一层 Modal。
 * 契约(批次 F):getOrgPlans / provisionOrg;字段名经 api.ts normalizeOrgPlan 适配。
 * 大数(每席价 / 每席积分)全字符串,禁 Number 化。
 */
export function CreateOrgWizard({
  auth,
  onCreated,
  onCancel,
}: {
  auth: AuthSession;
  /** 到账后回调:父层重拉 /api/me(entry A 额外关闭 Modal)。 */
  onCreated: () => void;
  /** 取消(entry A 关闭 Modal;entry B 无 org 无处可退,可不传)。 */
  onCancel?: () => void;
}) {
  const toast = useToast();
  const [plans, setPlans] = useState<OrgPlan[] | null>(null);
  const [plansErr, setPlansErr] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("name");
  const [orgName, setOrgName] = useState("");
  const [planCode, setPlanCode] = useState<string | null>(null);
  const [seats, setSeats] = useState(2);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "form" });

  // 挂载拉套餐档(无 org 也可读)。
  useEffect(() => {
    let alive = true;
    setPlansErr(null);
    api
      .getOrgPlans(auth)
      .then((ps) => {
        if (alive) setPlans(ps);
      })
      .catch((e) => {
        if (alive) setPlansErr(orgErrText(e, "加载企业套餐失败"));
      });
    return () => {
      alive = false;
    };
  }, [auth]);

  const plan = useMemo(() => plans?.find((p) => p.code === planCode) ?? null, [plans, planCode]);
  const total = plan ? computeSeatTotal(plan, seats) : null;

  // 选档:选中后把席位抬到该档最低(实时约束)。
  const choosePlan = useCallback((p: OrgPlan) => {
    setPlanCode(p.code);
    setSeats((s) => clampSeats(s, p.minSeats));
  }, []);

  const submit = useCallback(async () => {
    const name = orgName.trim();
    if (creating || !plan || !canLeaveNameStep(name) || !canLeavePlanStep(plan, seats)) return;
    setCreating(true);
    setErr(null);
    try {
      const order = await api.provisionOrg(auth, { orgName: name, planCode: plan.code, seats });
      setPhase({
        kind: "qr",
        order,
        totalCents: computeSeatTotal(plan, seats).totalCents,
        note: `${plan.name} · ${seats} 席`,
      });
    } catch (e) {
      setErr(orgErrText(e, "发起开通失败,请稍后重试。"));
    } finally {
      setCreating(false);
    }
  }, [auth, creating, orgName, plan, seats]);

  const onPaid = useCallback(() => {
    setPhase({ kind: "done" });
    toast("组织创建成功,欢迎使用企业版!", "success");
  }, [toast]);

  // ── 扫码到账段 ──
  if (phase.kind === "qr") {
    return (
      <div className="px-5 py-5">
        <OrgPayQr
          auth={auth}
          order={phase.order}
          amountCents={phase.totalCents}
          note={phase.note}
          onPaid={onPaid}
          onBack={() => setPhase({ kind: "form" })}
          backLabel="改配置"
        />
      </div>
    );
  }

  if (phase.kind === "done") {
    return (
      <div className="px-5 py-5">
        <OrgPaySuccess
          title="组织已创建"
          subtitle="席位积分已入组织期内池,现在可以邀请成员、共享技能了。"
          onDone={onCreated}
          doneLabel="进入组织"
        />
      </div>
    );
  }

  // ── 表单段(名称 / 选档) ──
  return (
    <div className="flex flex-col">
      <WizardSteps step={step} />

      <div className="px-5 py-4">
        {err && (
          <Alert tone="warning" className="mb-3 text-[12.5px]">
            {err}
          </Alert>
        )}

        {step === "name" && (
          <div className="flex flex-col gap-3">
            <div>
              <label htmlFor="create-org-name" className="mb-1.5 block text-[12.5px] text-muted">
                组织名称
              </label>
              <Input
                id="create-org-name"
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing && canLeaveNameStep(orgName)) {
                    e.preventDefault();
                    setStep("plan");
                  }
                }}
                placeholder="例如:某某科技有限公司"
                maxLength={60}
                autoFocus
              />
              <p className="mt-1.5 text-[11.5px] text-faint">
                将作为组织在平台内的显示名,可稍后在组织中心修改。
              </p>
            </div>
            <div className="flex items-center justify-end gap-2">
              {onCancel && (
                <Button variant="ghost" size="sm" onClick={onCancel} className="text-muted">
                  取消
                </Button>
              )}
              <Button
                variant="primary"
                size="sm"
                disabled={!canLeaveNameStep(orgName)}
                onClick={() => setStep("plan")}
              >
                下一步 <ArrowRight size={15} />
              </Button>
            </div>
          </div>
        )}

        {step === "plan" && (
          <div className="flex flex-col gap-3">
            {plansErr && (
              <Alert tone="danger" className="text-[12.5px]">
                {plansErr}
              </Alert>
            )}
            {!plans && !plansErr && (
              <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-faint">
                <Spinner /> 加载套餐…
              </div>
            )}

            {plans && plans.length > 0 && (
              <>
                <div className="flex flex-col gap-2">
                  {plans.map((p) => (
                    <PlanCard
                      key={p.code}
                      plan={p}
                      selected={p.code === planCode}
                      onSelect={() => choosePlan(p)}
                    />
                  ))}
                </div>

                {plan && (
                  <SeatPicker
                    plan={plan}
                    seats={seats}
                    onChange={(n) => setSeats(clampSeats(n, plan.minSeats))}
                  />
                )}

                {plan && total && (
                  <div className="rounded-xl border border-border bg-bg px-4 py-3">
                    <div className="flex items-center justify-between text-[13px]">
                      <span className="text-muted">应付合计</span>
                      <span className="text-[16px] font-semibold text-fg">
                        {formatCentsYuan(total.totalCents)}
                      </span>
                    </div>
                    <div className="mt-1 text-[12px] text-faint">
                      {seats} 席 × {formatCentsYuan(plan.seatPriceCents)}/月 · 入池{" "}
                      {formatCredits(total.totalCredits)} 积分 · 有效期 {plan.periodDays} 天
                    </div>
                  </div>
                )}
              </>
            )}

            {plans && plans.length === 0 && !plansErr && (
              <p className="py-8 text-center text-[13px] text-faint">暂无可用企业套餐。</p>
            )}

            <div className="flex items-center justify-between gap-2">
              <Button variant="ghost" size="sm" onClick={() => setStep("name")} className="text-muted">
                <ArrowLeft size={15} /> 上一步
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={creating || !canLeavePlanStep(plan, seats)}
                onClick={() => void submit()}
              >
                {creating ? <Spinner size={15} /> : <Building2 size={15} />}
                创建并支付
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 创建组织弹层(设置·账户页「创建组织」CTA 用)。全出血 body(零内边距,由向导自带 px-5),
 * 与 OrgCenter 分区同款视觉;Radix Dialog 关闭即卸载子树,下次打开向导为干净状态。
 */
export function CreateOrgDialog({
  open,
  auth,
  onClose,
  onCreated,
}: {
  open: boolean;
  auth: AuthSession;
  onClose: () => void;
  onCreated: () => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm data-[state=open]:animate-fade" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-float focus:outline-none data-[state=open]:animate-in"
        >
          <div className="flex items-center justify-between gap-3 px-5 py-4">
            <Dialog.Title className="text-[15px] font-semibold text-fg">创建组织</Dialog.Title>
            <Dialog.Close asChild>
              <button
                aria-label="关闭"
                className="flex size-8 shrink-0 items-center justify-center rounded-md text-faint outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X size={17} />
              </button>
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <CreateOrgWizard auth={auth} onCreated={onCreated} onCancel={onClose} />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** 三步进度指示。 */
function WizardSteps({ step }: { step: Step }) {
  const items: { key: Step | "pay"; label: string }[] = [
    { key: "name", label: "组织名" },
    { key: "plan", label: "选档 · 席位" },
    { key: "pay", label: "支付" },
  ];
  const activeIdx = step === "name" ? 0 : 1;
  return (
    <div className="flex items-center gap-2 border-b border-border px-5 py-3 text-[12px]">
      {items.map((it, i) => {
        const done = i < activeIdx;
        const active = i === activeIdx;
        return (
          <div key={it.key} className="flex items-center gap-2">
            <span
              className={cn(
                "flex size-5 items-center justify-center rounded-full text-[11px] font-medium",
                done
                  ? "bg-success-soft text-success"
                  : active
                    ? "bg-accent text-white"
                    : "bg-hover text-faint",
              )}
            >
              {done ? <Check size={12} /> : i + 1}
            </span>
            <span className={cn(active ? "text-fg" : "text-faint")}>{it.label}</span>
            {i < items.length - 1 && <span className="mx-1 h-px w-4 bg-border" />}
          </div>
        );
      })}
    </div>
  );
}

/** 档位卡:名称 / 每席价 / 每席积分 / 最低席位,选中高亮。 */
function PlanCard({
  plan,
  selected,
  onSelect,
}: {
  plan: OrgPlan;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        selected
          ? "border-accent bg-accent-soft"
          : "border-border bg-surface hover:border-border-strong",
      )}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[14px] font-semibold text-fg">{plan.name}</span>
          {selected && (
            <span className="rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-medium text-white">
              已选
            </span>
          )}
        </div>
        <div className="mt-0.5 text-[12px] text-faint">
          {formatCentsYuan(plan.seatPriceCents)}/席·月 · 每席 {formatCredits(plan.perSeatCredits)} 积分入池
        </div>
      </div>
      <span className="shrink-0 text-[11.5px] text-faint">最低 {plan.minSeats} 席</span>
    </button>
  );
}

/** 席位步进器(min = 档位最低)。 */
export function SeatPicker({
  plan,
  seats,
  onChange,
  label = "席位数",
  min,
}: {
  plan: Pick<OrgPlan, "minSeats">;
  seats: number;
  onChange: (n: number) => void;
  label?: string;
  /** 覆盖下限(加席场景传当前席位+1);缺省用档位最低。 */
  min?: number;
}) {
  const lo = min ?? plan.minSeats;
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[12.5px] text-muted">{label}</span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label="减少席位"
          disabled={seats <= lo}
          onClick={() => onChange(seats - 1)}
          className="flex size-8 items-center justify-center rounded-md border border-border text-fg outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Minus size={14} />
        </button>
        <input
          type="number"
          inputMode="numeric"
          min={lo}
          value={seats}
          onChange={(e) => {
            const n = Number.parseInt(e.target.value, 10);
            onChange(Number.isFinite(n) ? n : lo);
          }}
          aria-label={label}
          className="h-8 w-16 rounded-md border border-border bg-surface text-center text-[14px] tabular-nums text-fg outline-none focus:border-accent focus:ring-2 focus:ring-ring"
        />
        <button
          type="button"
          aria-label="增加席位"
          onClick={() => onChange(seats + 1)}
          className="flex size-8 items-center justify-center rounded-md border border-border text-fg outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Plus size={14} />
        </button>
      </div>
    </div>
  );
}
