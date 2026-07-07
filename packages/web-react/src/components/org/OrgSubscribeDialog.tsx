import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import { canLeavePlanStep, clampSeats, computeSeatTotal } from "../../lib/orgBilling";
import type {
  AuthSession,
  OrgPayResult,
  OrgPlan,
  OrgSubscriptionInfo,
} from "../../lib/types";
import { cn, formatCentsYuan, formatCredits } from "../../lib/utils";
import { Alert, Button, Modal, Spinner } from "../ui";
import { orgErrText } from "./orgShared";
import { SeatPicker } from "./CreateOrgWizard";
import { OrgPaySuccess, OrgPayQr } from "./OrgPayQr";

export type OrgSubMode = "subscribe" | "seats";

type Phase =
  | { kind: "form" }
  | { kind: "qr"; order: OrgPayResult; amountCents: string; note: string }
  | { kind: "done"; note: string };

/**
 * owner 的订阅 / 续费 / 加席弹层(两模式)。QR + 到账复用 OrgPayQr(轮询 payment/orders)。
 *   - subscribe:选档 + 席位 → POST /api/org/subscribe {plan_code, seats};
 *   - seats:当前档不变,目标席位(min = 当前+1)→ POST /api/org/seats {seats=目标总数},
 *     按「增量席位」计价展示(契约假设见 api.addOrgSeats)。
 * Modal 关闭即卸载子树(Radix 默认),下次打开为干净状态。owner 门在调用方(OrgCenter)控制,
 * 403 兜底以 orgErrText 呈现。
 */
export function OrgSubscribeDialog({
  open,
  auth,
  mode,
  subInfo,
  onClose,
  onPaid,
}: {
  open: boolean;
  auth: AuthSession;
  mode: OrgSubMode;
  /** 当前订阅 + 档列表(OrgCenter 单一权威,已加载)。 */
  subInfo: OrgSubscriptionInfo | null;
  onClose: () => void;
  /** 到账后回调:OrgCenter 重拉订阅 + 刷新 /api/me。 */
  onPaid: () => void;
}) {
  const plans = subInfo?.plans ?? [];
  const currentSub = subInfo?.subscription ?? null;
  const currentSeats = currentSub?.seats ?? 0;

  // subscribe:默认落当前档(续费)否则首档;席位默认当前席位或档最低。
  const [planCode, setPlanCode] = useState<string | null>(null);
  const [seats, setSeats] = useState(0);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "form" });

  // 打开时初始化选择(Modal 每次打开重新挂载,故用 open 作触发)。
  useEffect(() => {
    if (!open) return;
    if (mode === "subscribe") {
      const p = plans.find((x) => x.code === currentSub?.planCode) ?? plans[0] ?? null;
      setPlanCode(p?.code ?? null);
      setSeats(clampSeats(currentSeats || (p?.minSeats ?? 2), p?.minSeats ?? 2));
    } else {
      setPlanCode(currentSub?.planCode ?? null);
      setSeats(currentSeats + 1); // 加席:目标总数默认 +1
    }
    setPhase({ kind: "form" });
    setErr(null);
    // 依赖仅 open/mode(有意):plans/currentSub 来自已加载 subInfo,打开时取快照即可;
    // 若纳入依赖,subInfo 到账重拉会中途重置用户已选,故排除。
  }, [open, mode]);

  const plan: OrgPlan | null = useMemo(
    () => plans.find((p) => p.code === planCode) ?? null,
    [plans, planCode],
  );

  // subscribe 计价 = 席位全额;seats 计价 = 增量席位全额(§11 加席按整席全价购)。
  const priced = useMemo(() => {
    if (!plan) return null;
    if (mode === "subscribe") return computeSeatTotal(plan, seats);
    const delta = Math.max(0, seats - currentSeats);
    return computeSeatTotal(plan, delta);
  }, [plan, seats, mode, currentSeats]);

  const seatsValid =
    mode === "subscribe" ? canLeavePlanStep(plan, seats) : !!plan && seats > currentSeats;

  const submit = useCallback(async () => {
    if (creating || !plan || !seatsValid) return;
    setCreating(true);
    setErr(null);
    try {
      let order: OrgPayResult;
      let note: string;
      if (mode === "subscribe") {
        order = await api.subscribeOrg(auth, { planCode: plan.code, seats });
        note = `${plan.name} · ${seats} 席`;
      } else {
        // seats 端点收「增量」(见 api.addOrgSeats,对齐 F);UI 用目标总数选择,发送 delta。
        const delta = seats - currentSeats;
        order = await api.addOrgSeats(auth, delta);
        note = `加席至 ${seats} 席(+${delta})`;
      }
      const amountCents = priced?.totalCents ?? "0";
      setPhase({ kind: "qr", order, amountCents, note });
    } catch (e) {
      setErr(orgErrText(e, "发起订单失败,请稍后重试。"));
    } finally {
      setCreating(false);
    }
  }, [auth, creating, mode, plan, seats, seatsValid, priced, currentSeats]);

  const handlePaid = useCallback(() => {
    setPhase((p) => ({ kind: "done", note: p.kind === "qr" ? p.note : "" }));
    onPaid();
  }, [onPaid]);

  const title =
    phase.kind === "done"
      ? "支付成功"
      : phase.kind === "qr"
        ? "微信扫码支付"
        : mode === "subscribe"
          ? currentSub
            ? "续费 / 变更套餐"
            : "订阅企业套餐"
          : "增加席位";

  return (
    <Modal open={open} onOpenChange={(o) => !o && onClose()} title={title} className="max-w-lg">
      <div>
        {phase.kind === "form" && (
          <div className="flex flex-col gap-3">
            {err && (
              <Alert tone="warning" className="text-[12.5px]">
                {err}
              </Alert>
            )}

            {mode === "subscribe" ? (
              <>
                {plans.length === 0 ? (
                  <p className="py-8 text-center text-[13px] text-faint">暂无可用企业套餐。</p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {plans.map((p) => {
                      const selected = p.code === planCode;
                      const isCurrent = p.code === currentSub?.planCode;
                      return (
                        <button
                          key={p.code}
                          type="button"
                          onClick={() => {
                            setPlanCode(p.code);
                            setSeats((s) => clampSeats(s, p.minSeats));
                          }}
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
                              <span className="text-[14px] font-semibold text-fg">{p.name}</span>
                              {isCurrent && (
                                <span className="rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-medium text-white">
                                  当前
                                </span>
                              )}
                            </div>
                            <div className="mt-0.5 text-[12px] text-faint">
                              {formatCentsYuan(p.seatPriceCents)}/席·月 · 每席{" "}
                              {formatCredits(p.perSeatCredits)} 积分
                            </div>
                          </div>
                          <span className="shrink-0 text-[11.5px] text-faint">
                            最低 {p.minSeats} 席
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
                {plan && (
                  <SeatPicker
                    plan={plan}
                    seats={seats}
                    onChange={(n) => setSeats(clampSeats(n, plan.minSeats))}
                  />
                )}
              </>
            ) : (
              <>
                {currentSub && plan ? (
                  <div className="rounded-xl border border-border bg-bg px-4 py-3 text-[12.5px]">
                    <div className="flex items-center justify-between">
                      <span className="text-muted">当前套餐</span>
                      <span className="font-medium text-fg">{plan.name}</span>
                    </div>
                    <div className="mt-1 flex items-center justify-between text-faint">
                      <span>当前席位</span>
                      <span className="tabular-nums">{currentSeats} 席</span>
                    </div>
                  </div>
                ) : (
                  <Alert tone="warning" className="text-[12.5px]">
                    未找到当前订阅信息,无法加席。请先订阅企业套餐。
                  </Alert>
                )}
                {plan && (
                  <SeatPicker
                    plan={plan}
                    seats={seats}
                    min={currentSeats + 1}
                    onChange={(n) => setSeats(clampSeats(n, currentSeats + 1))}
                    label="加席至"
                  />
                )}
              </>
            )}

            {plan && priced && seatsValid && (
              <div className="rounded-xl border border-border bg-bg px-4 py-3">
                <div className="flex items-center justify-between text-[13px]">
                  <span className="text-muted">应付合计</span>
                  <span className="text-[16px] font-semibold text-fg">
                    {formatCentsYuan(priced.totalCents)}
                  </span>
                </div>
                <div className="mt-1 text-[12px] text-faint">
                  {mode === "subscribe"
                    ? `${seats} 席 × ${formatCentsYuan(plan.seatPriceCents)}/月 · 入池 ${formatCredits(priced.totalCredits)} 积分`
                    : `+${seats - currentSeats} 席 × ${formatCentsYuan(plan.seatPriceCents)} · 入池 ${formatCredits(priced.totalCredits)} 积分`}
                </div>
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={onClose} className="text-muted">
                取消
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={creating || !seatsValid}
                onClick={() => void submit()}
              >
                {creating ? <Spinner size={15} /> : null}
                {mode === "subscribe" ? "去支付" : "确认加席"}
              </Button>
            </div>

            <p className="text-[11.5px] leading-relaxed text-faint">
              {mode === "subscribe"
                ? "扫码即时开通,席位积分整份入组织期内池;续费顺延一个计费周期。期内池到期清零,超额与非订阅用量由组织钱包承接。"
                : "加席按整席全价购,整份积分即时入池,当前计费周期不变。"}
            </p>
          </div>
        )}

        {phase.kind === "qr" && (
          <OrgPayQr
            auth={auth}
            order={phase.order}
            amountCents={phase.amountCents}
            note={phase.note}
            onPaid={handlePaid}
            onBack={() => setPhase({ kind: "form" })}
            backLabel="改配置"
          />
        )}

        {phase.kind === "done" && (
          <OrgPaySuccess
            title={mode === "subscribe" ? "订阅成功" : "加席成功"}
            subtitle="席位积分已入组织期内池,余额与席位已更新。"
            onDone={onClose}
          />
        )}
      </div>
    </Modal>
  );
}
