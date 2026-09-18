import { ArrowUpCircle, Check, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, apiErrorMessage } from "../../lib/api";
import { reportClientFrictionOnce } from "../../lib/clientFriction";
import { TOPUP_PACK } from "../../lib/plans";
import {
  type SubscribeIntent,
  consumeSubscribeIntent,
  rememberSubscriptionPaid,
} from "../../lib/subscribeIntent";
import type { AuthSession, HupiCreateResult, MySubscription, SubscriptionPlanWire } from "../../lib/types";
import { cn, formatCentsYuan, formatCredits } from "../../lib/utils";
import { HupijiaoPaymentEntry } from "../payment/HupijiaoPaymentEntry";
import { Alert, Button, Modal, Spinner, useConfirm } from "../ui";

// 预选意图 / 最近已付费 的模块级状态已下沉到 lib/subscribeIntent(首屏同步渲染的红卡从那里读,
// 不再把本弹窗拖进入口闭包);此处 re-export 供 AccountTab / 测试等既有引用继续使用。
export type { SubscribeIntent };
export {
  consumeSubscribeIntent,
  lastKnownSubscriptionPaid,
  rememberSubscriptionPaid,
  requestSubscribeIntent,
  resetSubscribeUiState,
} from "../../lib/subscribeIntent";

function litePlanOf(plans: SubscriptionPlanWire[]): SubscriptionPlanWire | undefined {
  return (
    plans.find((p) => p.code === "lite") ??
    plans
      .filter((p) => p.tier > 0)
      .slice()
      .sort((a, b) => a.tier - b.tier || a.code.localeCompare(b.code))[0]
  );
}

type Stage =
  | { kind: "plans" }
  | { kind: "qr"; order: HupiCreateResult; note: string }
  | { kind: "paid"; note: string };

const POLL_INTERVAL_MS = 3000;

/** 把套餐周期到期日格式化为 YYYY-MM-DD。 */
function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * 订阅中心：当前套餐 + 双钱包余额 + 4 档套餐卡（续费 / 升档·补差价 / 切换）→ 虎皮椒扫码到账。
 * 履约后端按 kind 分支（subscribe 重置期内桶 + 周期顺延；upgrade 补到新档额度 + 周期不变）。
 * QR 段用 HupijiaoPaymentEntry，订单轮询 GET /api/payment/orders/:orderNo（与 OrgPayQr 同款）。
 */
export function SubscriptionDialog({
  open,
  auth,
  onClose,
  onPaid,
  initialIntent,
}: {
  open: boolean;
  auth: AuthSession;
  onClose: () => void;
  /** 到账后回调（刷新顶栏 / 账户余额 / 当前套餐）。 */
  onPaid: () => void;
  /** 测试或调用方直接预选；缺省消费 requestSubscribeIntent。 */
  initialIntent?: SubscribeIntent | null;
}) {
  const [stage, setStage] = useState<Stage>({ kind: "plans" });
  const [plans, setPlans] = useState<SubscriptionPlanWire[] | null>(null);
  const [sub, setSub] = useState<MySubscription | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busyCode, setBusyCode] = useState<string | null>(null);
  const [intent, setIntent] = useState<SubscribeIntent | null>(initialIntent ?? null);
  const [confirmAction, confirmActionEl] = useConfirm();
  const pollRef = useRef<number | null>(null);
  // 当前 open 镜像：异步回调（下单/轮询）resolve 后据此丢弃关闭后的迟到 setState。
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    reportClientFrictionOnce(
      `billing:pricing_exposure:${auth.snapshot().epoch}`,
      {
        surface: "billing",
        stage: "pricing_exposure",
        code: "PRICING_EXPOSURE",
        outcome: "succeeded",
      },
      auth.snapshot().token,
    );
  }, [open, auth]);
  // 下单请求代际：close / backToPlans / 新 choose 都 +1，让旧请求的迟到回调失效。
  // 仅靠 openRef 挡不住「关闭→立刻重开」（重开后 openRef 又为 true，旧请求会误推进）。
  const genRef = useRef(0);

  const stopPoll = useCallback(() => {
    if (pollRef.current != null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // 关闭复位：清 plans/sub（下次打开强制重拉最新订阅快照——否则刚订阅完重开会拿陈旧
  // sub.paid，导致升档被误判为全价 subscribe）。
  useEffect(() => {
    if (!open) {
      stopPoll();
      setStage({ kind: "plans" });
      setErr(null);
      setBusyCode(null);
      setPlans(null);
      setSub(null);
      setIntent(null);
      genRef.current += 1; // 关闭即作废任何在途下单请求
    } else {
      setIntent(initialIntent ?? consumeSubscribeIntent());
    }
  }, [open, stopPoll, initialIntent]);

  // 打开 plans 段：拉套餐 + 当前订阅。plans!=null 守卫挡成功后回跑。
  useEffect(() => {
    if (!open || stage.kind !== "plans" || plans != null) return;
    let alive = true;
    setLoading(true);
    setErr(null);
    Promise.all([api.listSubscriptionPlans(), api.getMySubscription(auth)])
      .then(([ps, s]) => {
        if (!alive) return;
        setPlans(ps);
        setSub(s);
        rememberSubscriptionPaid(s.paid);
      })
      .catch((e) => {
        if (alive) setErr(apiErrorMessage(e, "加载套餐失败"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, stage.kind, plans, auth]);

  useEffect(() => () => stopPoll(), [stopPoll]);

  async function choose(plan: SubscriptionPlanWire) {
    if (!sub || plan.tier === 0) return;
    const isUpgrade = plan.tier > sub.tier && sub.paid;
    // 有损操作先确认(审计 SET-01):续费 / 切换会把本期积分**重置**为新档月度额度,当前剩余不累计。
    // 这条规则此前只写在弹层底部 11.5px 灰字里,付费用户点「续费」就直接进二维码。
    // 升档按差价补齐、周期不变,免费 → 付费也没有可损失的余量,这两条不打断。
    if (sub.paid && !isUpgrade) {
      const isRenew = plan.code === sub.planCode;
      const ok = await confirmAction({
        title: isRenew ? `续费 ${plan.name}？` : `切换到 ${plan.name}？`,
        body: `${isRenew ? "续费" : "切换"}后本期套餐积分会重置为 ${formatCredits(plan.monthlyCredits)}，当前剩余的 ${formatCredits(sub.balance.period)} 不会累计，计费周期顺延 ${plan.periodDays} 天。钱包余额不受影响。`,
        confirmText: isRenew ? "确认续费" : "确认切换",
      });
      if (ok !== true) return;
    }
    setErr(null);
    setBusyCode(plan.code);
    const gen = ++genRef.current; // 本次下单代际；关闭/重开/再次 choose 都会令其失效
    try {
      const order: HupiCreateResult = isUpgrade
        ? await api.upgradeSubscription(auth, plan.code)
        : await api.subscribe(auth, plan.code);
      // 关闭后（含关闭→立刻重开）或又点了别的档：丢弃迟到响应，绝不用旧订单推进。
      if (!openRef.current || gen !== genRef.current) return;
      const note = isUpgrade ? `升档至 ${plan.name}` : `订阅 ${plan.name}`;
      setStage({ kind: "qr", order, note });
    } catch (e) {
      if (!openRef.current || gen !== genRef.current) return;
      setErr(apiErrorMessage(e, "创建订单失败"));
    } finally {
      if (openRef.current && gen === genRef.current) setBusyCode(null);
    }
  }

  // 购买加量包（进期内桶，v5 专属端点）。
  async function choosePack() {
    setErr(null);
    setBusyCode("__pack__");
    const gen = ++genRef.current;
    try {
      const order = await api.buyPack(auth);
      if (!openRef.current || gen !== genRef.current) return;
      setStage({ kind: "qr", order, note: "积分加量包" });
    } catch (e) {
      if (!openRef.current || gen !== genRef.current) return;
      setErr(apiErrorMessage(e, "创建订单失败"));
    } finally {
      if (openRef.current && gen === genRef.current) setBusyCode(null);
    }
  }

  // QR 段轮询（按 open + cancelled 守卫，杜绝关闭/返回后迟到 setState）。
  // 手机跳出收银台再返回：整页重载时本弹层已卸载，由 PendingPaymentRecovery 接手查单；
  // bfcache 原页恢复时恢复条不会重读 storage，仍靠本轮询确认 —— 两者不会在同一 document 里并存
  // （审计 SET-32 据此不改，理由见 docs/audit/settings.md §5）。
  useEffect(() => {
    if (stage.kind !== "qr" || !open) return;
    const orderNo = stage.order.orderNo;
    const note = stage.note;
    const expiresMs = new Date(stage.order.expiresAt).getTime();
    stopPoll();
    let inflight = false;
    let cancelled = false; // 本效果 cleanup（切段/关闭）后置真，丢弃 in-flight tick 的迟到结果
    const tick = async () => {
      if (inflight || cancelled) return;
      if (Number.isFinite(expiresMs) && Date.now() > expiresMs) {
        stopPoll();
        if (!cancelled) setErr("二维码已过期，请返回重新发起。");
        return;
      }
      inflight = true;
      try {
        const o = await api.getOrder(auth, orderNo);
        if (cancelled || !openRef.current) return;
        if (o.status === "paid") {
          stopPoll();
          setStage({ kind: "paid", note });
          onPaid();
          // 通知 WS 引擎立即重连(余额不足 4506 断开后的快路径;socket 监听本事件)。
          window.dispatchEvent(new Event("openclaude:billing-paid"));
        } else if (o.status === "expired" || o.status === "canceled" || o.status === "cancelled") {
          stopPoll();
          setErr("订单已失效，请返回重新发起。");
        }
      } catch {
        /* 单次轮询失败不致命 */
      } finally {
        inflight = false;
      }
    };
    pollRef.current = window.setInterval(tick, POLL_INTERVAL_MS);
    void tick();
    return () => {
      cancelled = true;
      stopPoll();
    };
  }, [stage, auth, onPaid, stopPoll, open]);

  function backToPlans() {
    stopPoll();
    setErr(null);
    genRef.current += 1; // 作废任何在途下单请求
    // 重拉当前订阅（升档/续费可能已变）。
    setPlans(null);
    setSub(null);
    setStage({ kind: "plans" });
  }

  const title = stage.kind === "paid" ? "开通成功" : stage.kind === "qr" ? "微信支付" : "套餐订阅";
  // 免费档月度额度从 plans 真值取(审计 SET-15),不再手抄「每月 300 积分」。
  const freePlan = plans?.find((p) => p.tier === 0) ?? null;

  return (
    <Modal open={open} onOpenChange={(o) => !o && onClose()} title={title} className="max-w-lg">
      {confirmActionEl}
      <div>
        {err && (
          <Alert tone="warning" className="mb-3 text-meta">
            {err}
          </Alert>
        )}

        {stage.kind === "plans" && (
          <div className="flex flex-col gap-3">
            {loading && (
              <div className="flex items-center justify-center gap-2 py-8 text-body text-faint">
                <Spinner /> 加载套餐…
              </div>
            )}

            {!loading && sub && (
              <div className="rounded-xl border border-border bg-bg px-4 py-3">
                <div className="flex items-center justify-between">
                  <span className="text-body text-muted">当前套餐</span>
                  <span className="text-title font-semibold text-fg">{sub.planName}</span>
                </div>
                {/* 两段都不许从中间折行(390px 下日期曾断成「2026-09-」「20」,审计 SET-18);放不下就整段换行。 */}
                <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-meta text-faint">
                  <span className="whitespace-nowrap">本期到期 {fmtDate(sub.periodEnd)}</span>
                  <span className="whitespace-nowrap">
                    期内 {formatCredits(sub.periodCredits)} · 钱包 {formatCredits(sub.balance.wallet)}
                  </span>
                </div>
                <div className="mt-1 text-meta text-accent">
                  总可用 {formatCredits(sub.balance.total)} 积分
                </div>
              </div>
            )}

            {!loading &&
              plans?.map((p) => {
                if (!sub) return null;
                const isCurrent = p.code === sub.planCode;
                const isFree = p.tier === 0;
                const isUpgrade = p.tier > sub.tier && sub.paid;
                const busy = busyCode === p.code;
                const liteTarget = litePlanOf(plans);
                const preselected = intent === "lite" && liteTarget?.code === p.code;
                const action = isFree
                  ? null
                  : isCurrent
                    ? "续费"
                    : isUpgrade
                      ? "升档"
                      : p.tier > sub.tier
                        ? "订阅"
                        : "切换";
                return (
                  <div
                    key={p.code}
                    data-preselected={preselected ? "lite" : undefined}
                    className={cn(
                      "flex items-center justify-between gap-3 rounded-xl border px-4 py-3",
                      isCurrent || preselected ? "border-accent bg-accent-soft" : "border-border bg-surface",
                    )}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-title font-semibold text-fg">{p.name}</span>
                        {isCurrent && (
                          <span className="rounded-full bg-accent px-1.5 py-0.5 text-micro font-medium text-accent-fg">
                            当前
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 text-meta text-faint">
                        {isFree ? "免费" : `${formatCentsYuan(p.priceCents)}/月`} · 每月{" "}
                        {formatCredits(p.monthlyCredits)} 积分
                      </div>
                    </div>
                    {action ? (
                      <Button
                        variant={isUpgrade || (p.tier > sub.tier && !isCurrent) ? "primary" : "secondary"}
                        size="sm"
                        disabled={busyCode != null}
                        onClick={() => choose(p)}
                        className="shrink-0"
                      >
                        {busy ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : isUpgrade ? (
                          <ArrowUpCircle size={14} />
                        ) : null}
                        {action}
                      </Button>
                    ) : (
                      // 免费档没有动作按钮;说清为什么(审计 SET-19),而不是一个孤零零的「—」。
                      <span className="shrink-0 text-right text-caption text-faint">
                        {isCurrent ? "" : "到期未续自动回落"}
                      </span>
                    )}
                  </div>
                );
              })}

            {/* 加量包：套餐用量不够时按需加（进期内桶，仅当前套餐有效期内可用）。 */}
            {!loading && sub && (
              <div
                data-preselected={intent === "pack" ? "pack" : undefined}
                className={cn(
                  "flex items-center justify-between gap-3 rounded-xl border border-dashed px-4 py-3",
                  intent === "pack"
                    ? "border-accent bg-accent-soft"
                    : "border-border-strong bg-bg",
                )}
              >
                <div className="min-w-0">
                  <div className="text-title font-semibold text-fg">积分加量包</div>
                  <div className="mt-0.5 text-meta text-faint">
                    ¥{TOPUP_PACK.price} 加 {TOPUP_PACK.credits.toLocaleString("zh-CN")} 积分 ·
                    仅当前套餐有效期内可用
                  </div>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busyCode != null}
                  onClick={() => void choosePack()}
                  className="shrink-0"
                >
                  {busyCode === "__pack__" ? <Loader2 size={14} className="animate-spin" /> : null}
                  加量
                </Button>
              </div>
            )}

            <p className="text-[11.5px] leading-relaxed text-faint">
              扫码支付即时开通。升档按新旧套餐差价计费、周期不变；续费/订阅重置当期积分并顺延一个计费周期。
              套餐积分为「当月使用」，到期未续将降级免费版
              {freePlan ? `（每月 ${formatCredits(freePlan.monthlyCredits)} 积分）` : ""}
              ，未用完的套餐 / 加量包积分不跨期结转。
            </p>
          </div>
        )}

        {stage.kind === "qr" && (
          <div className="flex flex-col items-center gap-3">
            <div className="text-center text-meta text-faint">{stage.note}</div>
            <HupijiaoPaymentEntry
              qrcodeUrl={stage.order.qrcodeUrl}
              mobileUrl={stage.order.mobileUrl}
              pendingPayment={{ orderNo: stage.order.orderNo, label: stage.note }}
              amountCents={stage.order.amountCents}
              expiresAt={stage.order.expiresAt}
              onReorder={backToPlans}
              token={auth.snapshot().token}
            />
            <Button variant="ghost" size="sm" onClick={backToPlans} className="text-muted">
              <RefreshCw size={14} /> 返回套餐
            </Button>
          </div>
        )}

        {stage.kind === "paid" && (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-success-soft text-success">
              <Check size={26} />
            </span>
            <div className="text-title font-semibold text-fg">{stage.note} 成功</div>
            <p className="text-meta text-faint">套餐与积分已更新，感谢你的支持。</p>
            <Button variant="primary" size="sm" onClick={onClose} className="mt-1">
              完成
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}
