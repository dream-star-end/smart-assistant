import { Check, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import type { AuthSession, OrgTopupResult } from "../../lib/types";
import { cn, formatCentsYuan } from "../../lib/utils";
import { HupijiaoPaymentEntry } from "../payment/HupijiaoPaymentEntry";
import { Alert, Button, Modal, Spinner } from "../ui";
import { orgErrText } from "./orgShared";

const POLL_INTERVAL_MS = 3000;
/** 二维码轮询上限（防悬挂）：超时后停轮询并提示去概览核对余额。 */
const POLL_MAX_MS = 5 * 60 * 1000;

/** 预设充值面额（元）。 */
const PRESETS_YUAN = ["100", "500", "1000", "2000", "5000"];

/**
 * 元（字符串输入）→ 分（字符串大数）。纯字符串 / BigInt，绝不经浮点。
 * 允许 "123" 或 "123.4" / "123.45"（最多两位小数）。非法或 ≤0 返回 null。
 * 导出供单测覆盖换算边界。
 */
export function yuanToCents(input: string): string | null {
  const s = input.trim();
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const frac = (m[2] ?? "").padEnd(2, "0");
  try {
    const cents = BigInt(m[1]) * 100n + BigInt(frac || "0");
    return cents > 0n ? cents.toString() : null;
  } catch {
    return null;
  }
}

/** 两个字符串大数比较：a > b。非法项按 0 处理。 */
function gt(a: string, b: string): boolean {
  const norm = (v: string) => (/^-?\d+$/.test(v) ? v : "0");
  try {
    return BigInt(norm(a)) > BigInt(norm(b));
  } catch {
    return false;
  }
}

type Stage =
  | { kind: "input" }
  | { kind: "qr"; result: OrgTopupResult; amountCents: string; baseline: string }
  | { kind: "paid"; amountCents: string };

/**
 * 组织充值（三段）：填额 → 扫码 → 到账。金额/积分全程字符串大数（yuanToCents / BigInt，
 * 绝不数值化）。批次 B 契约：POST /api/org/topup {amount_cents} → {order_no, qr}；
 * 到账检测轮询 GET /api/org/balance，余额较基线增长即判定到账（getOrgBalance 文档标注「轮询到账用」）。
 *
 * 集成期批次 B 端点可能 404/501：orgTopup 抛错时以 orgErrText 展示后端文案，绝不崩溃。
 * 轮询在到账 / 超时 / 关闭 / 卸载时统一清定时器（无悬挂轮询）。
 */
export function OrgTopupDialog({
  open,
  auth,
  baselineCredits,
  onClose,
  onPaid,
}: {
  open: boolean;
  auth: AuthSession;
  /** 打开时的组织钱包余额（到账检测基线兜底）。 */
  baselineCredits: string;
  onClose: () => void;
  /** 到账后回调（刷新概览 / 顶栏）。 */
  onPaid: () => void;
}) {
  const [stage, setStage] = useState<Stage>({ kind: "input" });
  const [amount, setAmount] = useState("");
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const stopPoll = useCallback(() => {
    if (pollRef.current != null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // 关闭面板：复位到填额段并清轮询（下次打开是干净状态）。
  useEffect(() => {
    if (!open) {
      stopPoll();
      setStage({ kind: "input" });
      setAmount("");
      setErr(null);
      setCreating(false);
    }
  }, [open, stopPoll]);

  // 卸载时兜底清轮询。
  useEffect(() => () => stopPoll(), [stopPoll]);

  const amountCents = yuanToCents(amount);

  const submit = useCallback(async () => {
    if (creating) return;
    const cents = yuanToCents(amount);
    if (!cents) {
      setErr("请输入有效充值金额（元，最多两位小数）。");
      return;
    }
    setErr(null);
    setCreating(true);
    try {
      const result = await api.orgTopup(auth, cents);
      // 基线优先取实时余额（防概览快照过期）；失败则用打开时快照。
      let baseline = baselineCredits;
      try {
        baseline = await api.getOrgBalance(auth);
      } catch {
        /* getOrgBalance 不可用：退化用快照基线 */
      }
      setStage({ kind: "qr", result, amountCents: cents, baseline });
    } catch (e) {
      setErr(orgErrText(e, "发起充值失败，请稍后重试。"));
    } finally {
      setCreating(false);
    }
  }, [amount, auth, baselineCredits, creating]);

  // 进入 QR 段：轮询余额判定到账。
  useEffect(() => {
    if (stage.kind !== "qr") return;
    const { baseline, amountCents: cents } = stage;
    const startedAt = Date.now();
    stopPoll();
    let inflight = false;
    const tick = async () => {
      if (inflight) return;
      if (Date.now() - startedAt > POLL_MAX_MS) {
        stopPoll();
        setErr("等待超时，若已支付请稍后在概览查看到账余额。");
        return;
      }
      inflight = true;
      try {
        const now = await api.getOrgBalance(auth);
        if (gt(now, baseline)) {
          stopPoll();
          setStage({ kind: "paid", amountCents: cents });
          onPaid();
        }
      } catch {
        // 单次轮询失败不致命（网络抖动 / 端点暂不可用），下个 tick 继续。
      } finally {
        inflight = false;
      }
    };
    pollRef.current = window.setInterval(tick, POLL_INTERVAL_MS);
    void tick();
    return stopPoll;
  }, [stage, auth, onPaid, stopPoll]);

  const backToInput = () => {
    stopPoll();
    setErr(null);
    setStage({ kind: "input" });
  };

  const title =
    stage.kind === "paid" ? "充值成功" : stage.kind === "qr" ? "微信支付" : "组织充值";

  return (
    <Modal open={open} onOpenChange={(o) => !o && onClose()} title={title} className="max-w-md">
      <div>
        {err && (
          <Alert tone="warning" className="mb-3 text-[12.5px]">
            {err}
          </Alert>
        )}

        {stage.kind === "input" && (
          <div className="flex flex-col gap-3">
            <div>
              <label
                htmlFor="org-topup-amount"
                className="mb-1.5 block text-[12.5px] text-muted"
              >
                充值金额（元）
              </label>
              <div className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3.5 focus-within:border-accent focus-within:ring-2 focus-within:ring-ring">
                <span className="text-[15px] text-faint">¥</span>
                <input
                  id="org-topup-amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      void submit();
                    }
                  }}
                  placeholder="输入充值金额"
                  className="h-10 w-full bg-transparent text-[15px] text-fg outline-none placeholder:text-faint"
                />
              </div>
              {amountCents && (
                <p className="mt-1 text-[11.5px] text-faint">
                  实付 {formatCentsYuan(amountCents)}
                </p>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              {PRESETS_YUAN.map((y) => (
                <button
                  key={y}
                  type="button"
                  onClick={() => setAmount(y)}
                  className={cn(
                    "rounded-full border px-3 py-1 text-[12.5px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                    amount === y
                      ? "border-accent bg-accent-soft text-accent"
                      : "border-border bg-surface text-muted hover:border-border-strong hover:text-fg",
                  )}
                >
                  ¥{y}
                </button>
              ))}
            </div>

            <Button
              variant="primary"
              onClick={() => void submit()}
              disabled={!amountCents || creating}
            >
              {creating ? <Spinner size={15} /> : null}
              发起充值
            </Button>
            <p className="text-[11.5px] text-faint">
              到账积分按平台当前汇率计算，支付成功后即时入账组织钱包。
            </p>
          </div>
        )}

        {stage.kind === "qr" && (
          <div className="flex flex-col items-center gap-3">
            <div className="text-center">
              <div className="text-[20px] font-semibold text-fg">
                {formatCentsYuan(stage.amountCents)}
              </div>
              <div className="text-[12.5px] text-faint">订单号 {stage.result.orderNo}</div>
            </div>
            <HupijiaoPaymentEntry qrcodeUrl={stage.result.qr} />
            <Button variant="ghost" size="sm" onClick={backToInput} className="text-muted">
              <RefreshCw size={14} /> 改充值金额
            </Button>
          </div>
        )}

        {stage.kind === "paid" && (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-success-soft text-success">
              <Check size={26} />
            </span>
            <div className="text-[15px] font-semibold text-fg">
              已到账 {formatCentsYuan(stage.amountCents)}
            </div>
            <p className="text-[12.5px] text-faint">组织钱包余额已更新。</p>
            <Button variant="primary" size="sm" onClick={onClose} className="mt-1">
              完成
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}
