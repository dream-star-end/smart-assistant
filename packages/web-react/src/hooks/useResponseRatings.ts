/**
 * 逐条响应评价(👍/👎 + 标签/评论)、隐式负反馈上报、高成本 turn 完成后的评分行脉冲高亮。
 * 从 App() 原样搬出(OCV5-376 P3):状态、回填、上报与定时器全在这里,App 只拿两样东西——
 * 下发给 ResponseRatingProvider 的 ratingCtx,和 send/stopTurn 经 ref 调用的 sendImplicitRating。
 * 调用方必须放在原先这几个 effect 的位置,保持与 App 其它 effect 的执行顺序不变。
 */
import { type MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RatingEntry, ResponseRatingCtx } from "../components/chat/ResponseRating";
import { turnFinalAssistantFlags } from "../components/chat/turnSegment";
import { api } from "../lib/api";
import { type ImplicitTarget, isExpensiveTurn, ratingNudgeBucket } from "../lib/implicitFeedback";
import type { UseChatSocket } from "./useChatSocket";

/** 隐式负反馈的成因标签（随 implicit down 一并上报，仅供后端归因，用户不可见）。 */
export type ImplicitReason = "中途打断" | "改写重发";

type AuthRef = { readonly current: Parameters<typeof api.submitResponseRating>[0] };

export interface UseResponseRatingsArgs {
  demo: boolean;
  /** 已登录(原先读 user 对象,只用到真假)。 */
  signedIn: boolean;
  activeId: string | undefined;
  modelId: string | undefined;
  sending: boolean;
  authRef: AuthRef;
  sockRef: { readonly current: UseChatSocket | null };
  /** 用户主动 Stop 的轮不做完成脉冲高亮:stopTurn 置位,这里的 sending 沿 effect 消费后清。 */
  stoppedTurnRef: MutableRefObject<boolean>;
}

export function useResponseRatings({
  demo,
  signedIn,
  activeId,
  modelId,
  sending,
  authRef,
  sockRef,
  stoppedTurnRef,
}: UseResponseRatingsArgs): {
  ratingCtx: ResponseRatingCtx | null;
  sendImplicitRating: (target: ImplicitTarget, opts: { reason: ImplicitReason }) => void;
} {
  // 逐条响应评价（👍/👎 + 可选标签/评论）。单一权威 = 本 Map（含乐观态），经 Context 下发给
  // 每条 AssistantCard 底部的 ResponseRatingCard。切会话/加载后由 GET 回读已评态填充（见下方
  // effect）；提交时乐观同步更新 + 静默 POST（维护期 503 / 限流 / 网络失败一律吞，不打断）。
  const [sessionRatings, setSessionRatings] = useState<Map<string, RatingEntry>>(() => new Map());
  const [sessionNudges, setSessionNudges] = useState<Map<string, 'exposed' | 'rated' | 'dismissed'>>(() => new Map());
  // 隐式负反馈上报去重：本会话运行内已隐式上报过的 messageId（切会话时清），防同一条重复 POST。
  const implicitReportedRef = useRef<Set<string>>(new Set());
  // 方案 a：高成本 turn 完成后对评分行做一次性脉冲高亮（4s）。nudgeId 经 ratingCtx 下发；
  // 定时器走 ref 自管（不绑 effect cleanup，避免 sending/activeId 变更中途误清 → 高亮永驻）。
  const [ratingNudgeId, setRatingNudgeId] = useState<string | null>(null);
  const nudgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // sending 沿检测：true→false（turn 完成）才评估是否高亮。
  const prevSendingRef = useRef(sending);
  const onRateResponse = useCallback(
    (input: {
      messageId: string;
      rating: "up" | "down";
      traceId?: string | null;
      tags?: string[];
      comment?: string;
    }) => {
      if (demo || !activeId || !signedIn) return;
      // 乐观更新:bare thumb(无 tags)时,同 thumb 沿用旧标签、切 thumb 清空;带 tags 直接覆盖。
      setSessionRatings((prev) => {
        const next = new Map(prev);
        const prevEntry = next.get(input.messageId);
        const tags = input.tags ?? (prevEntry?.rating === input.rating ? prevEntry.tags : []);
        next.set(input.messageId, { rating: input.rating, tags });
        return next;
      });
      setSessionNudges((prev) => {
        const next = new Map(prev);
        if (next.has(input.messageId)) next.set(input.messageId, "rated");
        return next;
      });
      void api
        .submitResponseRating(authRef.current, {
          messageId: input.messageId,
          rating: input.rating,
          sessionId: activeId,
          traceId: input.traceId ?? undefined,
          model: modelId,
          tags: input.tags,
          comment: input.comment,
        })
        .catch(() => {
          /* 静默:503 维护 / 429 限流 / 网络失败——保留乐观态,刷新后由 GET 对账。*/
        });
    },
    [demo, activeId, signedIn, modelId, authRef],
  );
  // 隐式负反馈静默上报（方案 b）：仅记 implicit down，**绝不碰 sessionRatings**（不渲染成
  // 用户已选态）。两道跳过闸：① 用户已显式评过该条 → 尊重其表态不覆盖；② 本会话运行已隐式
  // 上报过该 id → 幂等。tags=['implicit', reason] 供后端归因；503/限流/网络失败一律静默吞。
  const sendImplicitRating = useCallback(
    (target: ImplicitTarget, { reason }: { reason: ImplicitReason }) => {
      if (demo || !signedIn || !activeId) return;
      const { messageId, traceId } = target;
      if (sessionRatings.has(messageId)) return;
      if (implicitReportedRef.current.has(messageId)) return;
      implicitReportedRef.current.add(messageId);
      void api
        .submitResponseRating(authRef.current, {
          messageId,
          rating: "down",
          sessionId: activeId,
          traceId: traceId ?? undefined,
          model: modelId,
          tags: ["implicit", reason],
        })
        .catch(() => {
          /* 静默：不弹错、不打断对话；隐式信号丢失可接受。*/
        });
    },
    [demo, signedIn, activeId, modelId, sessionRatings, authRef],
  );

  // 已评回读：切会话/登录后拉一次 GET，填充已评态（重开会话时高亮 👍/👎、避免重复采集）。
  // 依赖用**派生布尔**（非 user 对象，refreshMe 换引用不误触发清空）+ activeId。切会话先清
  // 旧 Map（防串态），再异步注水；cancelled 守卫防慢响应覆盖新会话。demo/未登录不拉。
  const ratingsEnabled = !demo && signedIn;
  useEffect(() => {
    setSessionRatings(new Map());
    setSessionNudges(new Map());
    // 切会话：清隐式上报去重集 + 收起任何未散的评分脉冲高亮（旧 nudgeId 属上个会话）。
    implicitReportedRef.current = new Set();
    setRatingNudgeId(null);
    if (nudgeTimerRef.current) {
      clearTimeout(nudgeTimerRef.current);
      nudgeTimerRef.current = null;
    }
    if (!ratingsEnabled || !activeId) return;
    let cancelled = false;
    api
      .getSessionRatings(authRef.current, activeId)
      .then((snapshot) => {
        if (cancelled) return;
        const next = new Map<string, RatingEntry>();
        for (const [mid, v] of Object.entries(snapshot.ratings)) {
          if (v && (v.rating === "up" || v.rating === "down")) {
            next.set(mid, { rating: v.rating, tags: Array.isArray(v.tags) ? v.tags : [] });
          }
        }
        setSessionRatings(next);
        setSessionNudges(new Map(Object.entries(snapshot.nudges)));
      })
      .catch(() => {
        /* 静默:503 维护 / 网络失败——无已评高亮,不影响新评。*/
      });
    return () => {
      cancelled = true;
    };
  }, [ratingsEnabled, activeId, authRef]);

  // 评价 Context 载荷:demo/未登录 → null（ResponseRatingCard 自渲 null，天然隐藏）。
  // nudgeId 随载荷下发：nudge 卡作为 Context 消费者穿透 MessageRenderer sig-memo 重渲（同 ratings
  // 机制，不改渲染签名）→ 命中的评分行加/去脉冲类，其余卡 nudgeId!==自身 id 不受影响。
  const ratingCtx: ResponseRatingCtx | null = useMemo(
    () =>
      ratingsEnabled
        ? {
            ratings: sessionRatings,
            submit: onRateResponse,
            nudgeId: ratingNudgeId,
            sessionId: activeId,
            getToken: () => authRef.current?.snapshot().token,
          }
        : null,
    [ratingsEnabled, sessionRatings, onRateResponse, ratingNudgeId, activeId, authRef],
  );

  // 方案 a：sending true→false（本轮完成）沿检测 → 若为高成本 turn 且轮末条 assistant 未被评过，
  // 点亮该条评分行做一次性脉冲高亮引导（4s 自动熄灭）。用户主动 Stop 的轮不高亮（stoppedTurnRef）。
  // 走 sockRef.current（稳定句柄，同 chat）现场取消息，deps 不含每帧翻新的 chat 引用。
  useEffect(() => {
    const wasSending = prevSendingRef.current;
    prevSendingRef.current = sending;
    if (!wasSending || sending) return; // 仅 true→false 沿动作
    if (stoppedTurnRef.current) {
      stoppedTurnRef.current = false; // 消费"本轮被主动打断"标记 → 不高亮
      return;
    }
    if (demo || !activeId) return;
    const msgs = sockRef.current?.getMessages(activeId) ?? [];
    const expensive = isExpensiveTurn(msgs);
    // 轮末条 assistant 正文 = 评价行唯一落点（turnFinalAssistantFlags 最后一个 true）。
    const flags = turnFinalAssistantFlags(msgs);
    let idx = -1;
    for (let i = flags.length - 1; i >= 0; i--) {
      if (flags[i]) { idx = i; break; }
    }
    if (idx < 0) return;
    const message = msgs[idx];
    const id = message?.id;
    if (!id || sessionRatings.has(id) || sessionNudges.has(id)) return;
    const sampleBucket = ratingNudgeBucket(id);
    if (!expensive && sampleBucket !== 0) return;
    const traceId = message?.usage?.traceId ?? undefined;
    const clientBuild = document.querySelector<HTMLMetaElement>('meta[name="oc-build"]')?.content || undefined;
    void api.submitResponseRatingNudge(authRef.current, {
      messageId: id,
      sessionId: activeId,
      traceId,
      clientBuild,
      sampleBucket,
      nudgeAction: "expose",
    }).then((result) => {
      if (!result.newlyExposed || result.state !== "exposed") return;
      setSessionNudges((prev) => new Map(prev).set(id, "exposed"));
      if (nudgeTimerRef.current) clearTimeout(nudgeTimerRef.current);
      setRatingNudgeId(id);
      nudgeTimerRef.current = setTimeout(() => {
        setRatingNudgeId(null);
        nudgeTimerRef.current = null;
        setSessionNudges((prev) => new Map(prev).set(id, "dismissed"));
        void api.submitResponseRatingNudge(authRef.current, {
          messageId: id,
          sessionId: activeId,
          traceId,
          clientBuild,
          sampleBucket,
          nudgeAction: "dismiss",
        }).catch(() => {});
      }, 4000);
    }).catch(() => {});
  }, [sending, demo, activeId, sessionRatings, sessionNudges, sockRef, stoppedTurnRef, authRef]);

  // 卸载兜底：清未散的脉冲定时器，防泄漏。
  useEffect(
    () => () => {
      if (nudgeTimerRef.current) clearTimeout(nudgeTimerRef.current);
    },
    [],
  );

  return { ratingCtx, sendImplicitRating };
}
