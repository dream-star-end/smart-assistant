import { Check, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../../lib/api";
import type { AuthSession, HupiCreateResult, PaymentPlan } from "../../lib/types";
import { cn, formatCentsYuan, formatCredits } from "../../lib/utils";
import { Alert, Button, Modal, Spinner } from "../ui";

type Stage =
  | { kind: "plans" }
  | { kind: "qr"; order: HupiCreateResult; planCredits: string }
  | { kind: "paid"; credits: string };

const POLL_INTERVAL_MS = 3000;

/**
 * 充值流程（三段）：plans → 虎皮椒扫码 → 到账。
 * 金额/积分全程字符串大数（formatCentsYuan / formatCredits，绝不数值化）。
 *
 * 轮询：创建订单后每 3s GET /api/payment/orders/:orderNo，status==='paid' 即到账；
 * 过期/取消进终态；组件卸载 / 关闭 / 切回 plans 时统一清掉定时器（无悬挂轮询）。
 */
export function TopupDialog({
  open,
  auth,
  onClose,
  onPaid,
}: {
  open: boolean;
  auth: AuthSession;
  onClose: () => void;
  /** 到账后回调（刷新顶栏 / 账户余额）。 */
  onPaid: () => void;
}) {
  const [stage, setStage] = useState<Stage>({ kind: "plans" });
  const [plans, setPlans] = useState<PaymentPlan[] | null>(null);
  const [loadingPlans, setLoadingPlans] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState<string | null>(null); // 正在创建的 plan code
  const pollRef = useRef<number | null>(null);

  const stopPoll = useCallback(() => {
    if (pollRef.current != null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // 关闭面板：复位到 plans 段并清轮询（下次打开是干净状态）。
  useEffect(() => {
    if (!open) {
      stopPoll();
      setStage({ kind: "plans" });
      setErr(null);
      setCreating(null);
    }
  }, [open, stopPoll]);

  // 打开 plans 段时拉套餐（带 token → 首充档按是否用过过滤）。
  useEffect(() => {
    if (!open || stage.kind !== "plans" || plans != null || loadingPlans) return;
    let alive = true;
    setLoadingPlans(true);
    setErr(null);
    api
      .listPlans(auth)
      .then((p) => {
        if (alive) setPlans(p);
      })
      .catch((e) => {
        if (alive) setErr((e as Error).message || "加载充值套餐失败");
      })
      .finally(() => {
        if (alive) setLoadingPlans(false);
      });
    return () => {
      alive = false;
    };
  }, [open, stage.kind, plans, loadingPlans, auth]);

  // 卸载时兜底清轮询。
  useEffect(() => () => stopPoll(), [stopPoll]);

  async function selectPlan(code: string, credits: string) {
    setErr(null);
    setCreating(code);
    try {
      const order = await api.createHupiOrder(auth, code);
      setStage({ kind: "qr", order, planCredits: credits });
    } catch (e) {
      if (e instanceof ApiError) {
        // 409 = 老用户复用首充档；400 PLAN_NOT_FOUND = 套餐已下架（刷新列表）
        if (e.status === 409 || e.code === "FIRST_TOPUP_USED") {
          setErr("新用户首充已用过，请选择其它充值方案。");
          setPlans(null); // 强制重拉，过滤掉首充档
        } else if (e.code === "PLAN_NOT_FOUND") {
          setErr("该充值方案已下架，请刷新后重试。");
          setPlans(null);
        } else {
          setErr(e.message || "创建订单失败");
        }
      } else {
        setErr((e as Error).message || "创建订单失败");
      }
    } finally {
      setCreating(null);
    }
  }

  // 进入 QR 段：启动轮询。
  useEffect(() => {
    if (stage.kind !== "qr") return;
    const orderNo = stage.order.orderNo;
    const credits = stage.planCredits;
    const expiresMs = new Date(stage.order.expiresAt).getTime();
    stopPoll();
    let inflight = false;
    const tick = async () => {
      if (inflight) return;
      // 过期：停轮询，提示重试（保留 QR 但标记过期由 err 体现）。
      if (Number.isFinite(expiresMs) && Date.now() > expiresMs) {
        stopPoll();
        setErr("二维码已过期，请返回重新发起充值。");
        return;
      }
      inflight = true;
      try {
        const o = await api.getOrder(auth, orderNo);
        if (o.status === "paid") {
          stopPoll();
          setStage({ kind: "paid", credits });
          onPaid();
        } else if (o.status === "expired" || o.status === "canceled" || o.status === "cancelled") {
          stopPoll();
          setErr("订单已失效，请返回重新发起充值。");
        }
      } catch {
        // 单次轮询失败不致命（网络抖动），下个 tick 继续。
      } finally {
        inflight = false;
      }
    };
    pollRef.current = window.setInterval(tick, POLL_INTERVAL_MS);
    void tick(); // 立即探一次
    return stopPoll;
  }, [stage, auth, onPaid, stopPoll]);

  function backToPlans() {
    stopPoll();
    setErr(null);
    setStage({ kind: "plans" });
  }

  const title =
    stage.kind === "paid" ? "充值成功" : stage.kind === "qr" ? "微信扫码支付" : "充值积分";

  return (
    <Modal open={open} onOpenChange={(o) => !o && onClose()} title={title} className="max-w-md">
      <div>
        {err && (
          <Alert tone="warning" className="mb-3 text-[12.5px]">
            {err}
          </Alert>
        )}

        {stage.kind === "plans" && (
          <div className="flex flex-col gap-2">
            {loadingPlans && (
              <div className="flex items-center justify-center gap-2 py-8 text-[13px] text-faint">
                <Spinner /> 加载套餐…
              </div>
            )}
            {!loadingPlans && plans && plans.length === 0 && (
              <p className="py-8 text-center text-[13px] text-faint">暂无可用充值方案。</p>
            )}
            {!loadingPlans &&
              plans?.map((p) => {
                const busy = creating === p.code;
                return (
                  <button
                    key={p.code}
                    onClick={() => selectPlan(p.code, p.credits)}
                    disabled={creating != null}
                    className={cn(
                      "flex items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-left outline-none transition-colors hover:border-accent hover:bg-accent-soft focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60",
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[14px] font-medium text-fg">
                        {p.label}
                      </span>
                      <span className="block text-[12px] text-faint">
                        到账 {formatCredits(p.credits)} 积分
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1 text-[15px] font-semibold text-accent">
                      {busy ? <Loader2 size={15} className="animate-spin" /> : null}
                      {formatCentsYuan(p.amountCents)}
                    </span>
                  </button>
                );
              })}
          </div>
        )}

        {stage.kind === "qr" && (
          <div className="flex flex-col items-center gap-3">
            <div className="rounded-xl border border-border bg-white p-3">
              {/* 虎皮椒返回的 qrcodeUrl 本身就是一张 QR PNG，直接 <img>，不要再二维码化。 */}
              <img
                src={stage.order.qrcodeUrl}
                alt="微信支付二维码"
                width={200}
                height={200}
                className="size-[200px] object-contain"
              />
            </div>
            <div className="text-center">
              <div className="text-[20px] font-semibold text-fg">
                {formatCentsYuan(stage.order.amountCents)}
              </div>
              <div className="text-[12.5px] text-faint">
                到账 {formatCredits(stage.order.credits)} 积分
              </div>
            </div>
            <div className="flex items-center gap-1.5 text-[12.5px] text-faint">
              <Spinner size={13} /> 请用微信扫码支付，到账后自动确认…
            </div>
            {stage.order.mobileUrl && (
              <a
                href={stage.order.mobileUrl}
                className="text-[12.5px] text-accent underline-offset-4 hover:underline"
              >
                手机端点此直接支付
              </a>
            )}
            <Button variant="ghost" size="sm" onClick={backToPlans} className="text-muted">
              <RefreshCw size={14} /> 换个套餐
            </Button>
          </div>
        )}

        {stage.kind === "paid" && (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-success-soft text-success">
              <Check size={26} />
            </span>
            <div className="text-[15px] font-semibold text-fg">
              已到账 {formatCredits(stage.credits)} 积分
            </div>
            <p className="text-[12.5px] text-faint">余额已更新，感谢你的支持。</p>
            <Button variant="primary" size="sm" onClick={onClose} className="mt-1">
              完成
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}
