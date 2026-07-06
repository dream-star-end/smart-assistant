/**
 * V3 Phase 4(2026-05-18 anthropicProxy.ts 三层拆分 §4.6):upstream round-trip 核心。
 *
 * 物理迁移自 anthropicProxy.ts L1421-1639(步骤 10/11 — abort 绑定 + fetch +
 * SSE 透传 + finalize + post-commit 广播 + zeroize)。语义零变化。
 *
 * 设计要点(Codex plan v3 PASS 后定型,见 docs/V3_ANTHROPIC_PROXY_SPLIT_PLAN_2026-05-18.md):
 *
 *   - **AbortController 在 core 内部全生命周期**:不暴露 ac / onClose 给 handler,
 *     避免双方都得知道何时该 off("close") —— 这条边界要 core 独立持有,否则任何
 *     新加 early-return 都得手动 cleanup,极易漏。
 *
 *   - **case (c) release 责任**:本函数 **不**负责 case (c)(journal fail 前
 *     release session)。case (c) 发生在 finalize 装配前,留在 handler 里。
 *     本函数开跑时 finalize 已装好 = release 的唯一调用点。
 *
 *   - **sessionId 单一来源**:由 handler 算一次 `extractSessionId(body.metadata)`
 *     并存入 ctx.sessionId,本函数只读 ctx.sessionId(避免和 finalize 配置
 *     里的 sessionId 走两条不同的提取路径)。
 *
 *   - **post-commit 顺序锁**:appendCostCredits **先**,broadcastToUser **后**。
 *     refresh-after-reply 才能拿到和 broadcast 同步的 credits 数。persist 失败
 *     仅 log,不阻塞 broadcast(注释见函数内)。
 *
 *   - **零内存泄漏**:try/catch/finally 中 req.off / res.off + session.zeroizeSecrets()
 *     是不可移除的兜底,任何路径 return 都必经此 finally。
 */

import type { Pool } from "pg";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  type Logger,
  type UsageObservation,
  type ProxyBody,
  HttpError,
  REQUEST_ID_HEADER,
  buildSafeUpstreamHeaders,
  isAnthropicInvalidRequestError,
  isClientAbort,
  pipeStreamWithUsageCapture,
  sendJsonError,
  errSummary,
} from "./shared.js";
import type { PreparedUpstreamSession } from "./upstream.js";
import type { FinalizerHandle, FinalizeOutcome } from "../../billing/proxyBilling.js";
import { maybeUpdateAccountQuota } from "../../account-pool/quota.js";
import {
  observeAnthropicProxyTtft,
  observeAnthropicProxyStreamDuration,
  incrAnthropicProxySettle,
  incrAnthropicProxyReject,
} from "../../admin/metrics.js";
import { recordProviderHealthSample } from "./providerHealthSink.js";

// ─── 上下文 ────────────────────────────────────────────────────────────────

/**
 * `runUpstreamRoundTrip` 入参。13 字段一次性给齐,函数内不再访问 handler 全局:
 *
 *   1. `pgPool`              — maybeUpdateAccountQuota 用,需要 Pool 不是 transaction-bound 句柄
 *   2. `fetchFn`             — handler 已注入(deps.fetchImpl ?? fetch),core 不再读
 *   3. `appendCostCredits?`  — 持久化 costCredits 到 client_sessions.messages.usage.costCredits
 *   4. `broadcastToUser?`    — 推 outbound.cost_charged 到该 uid 的 WS
 *   5. `req`                 — 用于 on("close")/off("close") 绑 abort
 *   6. `res`                 — 写 SSE / writeHead / sendJsonError 都走它
 *   7. `requestId`           — 写入响应 X-Request-Id + 错误响应 + WS broadcast
 *   8. `uid`                 — broadcastToUser(uid, payload) 的目标用户 + appendCostCredits userId
 *   9. `body`                — proxy 请求 body(已 strict-validated),用于上游 messages 重组
 *  10. `session`             — handler pick 完毕、journal 已写,release 由 finalize 接管
 *  11. `finalize`            — handler 装好的 single-shot finalizer 句柄
 *  12. `sessionId`           — 由 handler 算一次,broadcast payload 引用,口径锁定
 *  13. `userLog`             — 已绑 uid/containerId 的 logger
 *
 * 没列入的(故意不放):
 *   - `pricing` / `containerIdBig` / `scheduler` / `preCheckRedis` / `pre` —
 *     这些都已闭包进 `finalize`,core 没必要二次持有。
 *   - `ac` / `onClose` — 内部全生命周期,handler 无感知。
 */
export interface RoundTripCtx {
  pgPool: Pool;
  fetchFn: typeof fetch;
  appendCostCredits?: (
    requestId: string,
    userId: string,
    costCredits: string,
    sessionId?: string | null,
    parentSessionId?: string | null,
    delegateAgentId?: string | null,
  ) => Promise<unknown>;
  broadcastToUser?: (uid: bigint, payload: unknown) => void;
  req: IncomingMessage;
  res: ServerResponse;
  requestId: string;
  uid: bigint;
  body: ProxyBody;
  session: PreparedUpstreamSession;
  finalize: FinalizerHandle;
  sessionId: string | null;
  /**
   * delegate 子会话的父**客户端**会话 id(web-*)。仅 attribution.mode==='delegate'
   * 时非空(extractUsageAttribution 已保证非 delegate 恒 null)。
   *   - `appendCostCredits` park key:委派成本按此归并到队长助手行(durable,Fix A);
   *     普通 chat null → 走既有 session_id / by-user drain,零影响。
   *   - `outbound.cost_charged` 广播:前端据此把委派成本精确路由到父客户端会话
   *     (Fix B,消 60s TTL 脆弱);普通 chat null → 前端回落既有启发式。
   */
  parentSessionId: string | null;
  /** P2 债D — delegate 子会话的目标 agent id(= attribution.delegateAgentId)。仅
   *  delegate 模式非空。随 appendCostCredits park 进 pending.delegate_agent_id,供
   *  drain 时产出队长助手行 usage.delegates[] 的 per-agent 明细。普通 chat 恒 null。 */
  delegateAgentId: string | null;
  userLog: Logger;
}

// ─── 主流程 ────────────────────────────────────────────────────────────────

/**
 * 执行上游 round-trip 全流程:
 *   - 双向 abort 绑定(req/res close → ac.abort)
 *   - 上游 fetch(applyUpstreamAuth + sanitizeMessages + dispatcher)
 *   - 上游非 2xx / no-body 错误:finalize.fail or failClient(取决于 isClientBadRequest)
 *   - SSE byte-pipe + usage capture
 *   - finalize.commit / fail / failClient(取决于 result.error & isClientAbort)
 *   - 成功 commit & debited>0 → appendCostCredits → broadcastToUser
 *   - settle metric
 *   - finally: req.off / res.off / session.zeroizeSecrets()
 *
 * 返回 void —— 所有响应已写出。caller 不需要再 sendJsonError / res.end()。
 *
 * **错误形状不变**:任何 release 责任全部由 finalize 接管(本函数不直调 scheduler.release),
 * session.zeroizeSecrets() 在 finally 兜底(release 路径里也会 zero,idempotent)。
 */
export async function runUpstreamRoundTrip(ctx: RoundTripCtx): Promise<void> {
  const {
    pgPool,
    fetchFn,
    appendCostCredits,
    broadcastToUser,
    req,
    res,
    requestId,
    uid,
    body,
    session,
    finalize,
    sessionId,
    parentSessionId,
    delegateAgentId,
    userLog,
  } = ctx;

  // 双向 abort 绑定
  const ac = new AbortController();
  const onClose = () => ac.abort();
  req.on("close", onClose);
  res.on("close", onClose);

  let observed: UsageObservation = { kind: "none" };
  try {
    // safe headers + Authorization
    let safeHeaders: Record<string, string>;
    try {
      safeHeaders = buildSafeUpstreamHeaders(req.headers);
    } catch (err) {
      if (err instanceof HttpError) {
        incrAnthropicProxyReject("bad_headers");
        await finalize.fail(observed, err);
        sendJsonError(res, err.status, err.code, err.message, requestId);
        return;
      }
      throw err;
    }
    // Authorization + anthropic-beta + (OAuth)device_id pin → session.applyUpstreamAuth
    // body sanitize(OAuth strip malformed thinking;DeepSeek noop)→ session.sanitizeMessages
    // 详见 proxy/upstream.ts 中两个实现的注释。
    session.applyUpstreamAuth(safeHeaders, body, userLog);
    const upstreamMessages = session.sanitizeMessages(body.messages, body.model, userLog);
    const upstreamBodyJson = JSON.stringify({
      ...body,
      messages: upstreamMessages,
      stream: true,
    });

    const fetchInit: RequestInit & { dispatcher?: unknown } = {
      method: "POST",
      headers: safeHeaders,
      body: upstreamBodyJson,
      signal: ac.signal,
    };
    // HIGH#5:绑账号 egress_proxy。session.dispatcher === undefined → 走默认出口。
    // dispatcher 由 egressDispatcher 缓存,同 account 的 chat / refresh 共享
    // 同一 ProxyAgent,确保稳定 source IP。dispatcher 在 ProxyAgent.close()
    // 时会等流结束 —— pipeStreamWithUsageCapture finally 块里 cancel reader,
    // 这条流不会让 admin 改 proxy 时 hang(参 egressDispatcher.ts 注释)。
    if (session.dispatcher) fetchInit.dispatcher = session.dispatcher;

    const fetchStartMs = Date.now();
    const upstream = await fetchFn(session.endpoint, fetchInit);
    if (upstream.status < 200 || upstream.status >= 300) {
      // 上游 4xx/5xx — 读 body preview 写 log,直接转译成 502
      let preview = "";
      try {
        preview = (await upstream.text()).slice(0, 500);
      } catch {
        /* ignore */
      }
      const err = new Error(
        `upstream returned ${upstream.status}: ${preview}`,
      );
      // 上游 400 invalid_request_error = 客户端 body 损坏(典型:thinking
      // signature 不合法)。账号本身没问题,走 client_error 不扣健康分,
      // 防止 boss 自己客户端 bug 反复打到账号 cooldown。
      const isClientBadRequest =
        upstream.status === 400 && isAnthropicInvalidRequestError(preview);
      if (isClientBadRequest) {
        userLog.warn("proxy_upstream_invalid_request", {
          status: upstream.status,
          preview: preview.slice(0, 200),
        });
        await finalize.failClient(observed, err);
      } else {
        await finalize.fail(observed, err);
      }
      incrAnthropicProxySettle("aborted");
      // P3.2 健康信号:上游 5xx / 429(过载)算 provider 侧失败;4xx(含 400 客户端 body 损坏、
      // 内容策略拒绝)不归 provider 健康,避免误判(fire-and-forget,只静态 provider 记)。
      if (!isClientBadRequest && (upstream.status >= 500 || upstream.status === 429)) {
        recordProviderHealthSample(body.model, "upstream_5xx");
      }
      sendJsonError(res, 502, "UPSTREAM_ERROR", `upstream returned ${upstream.status}`, requestId);
      return;
    }
    if (!upstream.body) {
      const err = new Error(`upstream ${upstream.status} but no body`);
      await finalize.fail(observed, err);
      incrAnthropicProxySettle("aborted");
      recordProviderHealthSample(body.model, "upstream_5xx"); // 2xx 却无 body = provider 返回畸形
      sendJsonError(res, 502, "UPSTREAM_NO_BODY", "upstream returned no body", requestId);
      return;
    }
    // M9 配额可见性 — 从上游响应头抽 5h/7d utilization + reset,fire-and-forget
    // UPDATE accounts。30s 进程内 throttle + SQL WHERE + 全局 cap 32 三层防护,
    // 详见 quota.ts 文件头。maybeUpdateAccountQuota 内部已吞所有错,这里 .catch
    // 仅做最后兜底(理论不会触发),保留以防未来重构破坏内部 swallow 语义。
    // session.shouldUpdateQuotaFromResponse=false(DeepSeek)→ 整段跳过。
    if (session.shouldUpdateQuotaFromResponse && session.accountId !== null) {
      maybeUpdateAccountQuota(pgPool, session.accountId, upstream.headers).catch((err) => {
        userLog.warn("proxy_quota_update_failed", { err: errSummary(err) });
      });
    }
    // 写 SSE 响应头,开始 byte-pipe
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      [REQUEST_ID_HEADER]: requestId,
    });
    const result = await pipeStreamWithUsageCapture(
      upstream.body as ReadableStream<Uint8Array>,
      res,
      ac.signal,
    );
    observed = result.observation;
    const streamEndMs = Date.now();
    // 2I-2 metrics:TTFT 是 fetch 起到第一字节;stream duration 是 fetch 起到最后一字节。
    // 任意一项 < 0 / NaN 由 metrics observe 自动丢弃,无需在这里防御。
    if (result.firstByteAtMs !== null) {
      observeAnthropicProxyTtft(body.model, (result.firstByteAtMs - fetchStartMs) / 1000);
    }
    observeAnthropicProxyStreamDuration(body.model, (streamEndMs - fetchStartMs) / 1000);
    try {
      res.end();
    } catch {
      /* ignore */
    }
    // 中途断流(result.error != null)走 fail,但 observation 已捕获 partial 状态。
    // 客户端主动断流(req/res close → ac.abort → pipeStream 抛 ProxyAbortError /
    // fetch 抛 AbortError)不该扣账号健康分:走 failClient(client_error)。
    // 注意:不能看 ac.signal.aborted,res.end() 自身会触发 close → abort,
    // 那时 signal 已为 true,会把所有 mid-stream 错都误判成 client(Codex MAJOR)。
    let outcome: FinalizeOutcome;
    if (result.error !== null) {
      if (isClientAbort(result.error)) {
        outcome = await finalize.failClient(observed, result.error);
        recordProviderHealthSample(body.model, "aborted"); // 客户端断:judgement 排除,不算 provider 失败
      } else {
        outcome = await finalize.fail(observed, result.error);
        recordProviderHealthSample(body.model, "partial"); // 中途断流 = provider 侧失败
      }
    } else {
      outcome = await finalize.commit(observed);
      recordProviderHealthSample(body.model, "final"); // 完整完成:抽样 1/10
    }
    // 把真实扣费的积分 + 扣费后余额推给该 uid 的前端 WS,前端会替换响应 meta
    // 行里 $0.xxxx(容器侧估算,口径不一致)为真实扣费积分。
    //
    // **只用 debitedCredits,不要用 finalCredits**:
    //   - billing_failed 路径(obs.kind='partial') ledger 根本没 debit,
    //     finalCredits 可能 > 0 但用户没被扣到 → debitedCredits=null → 跳过广播
    //   - clamp(余额不足)路径 finalCredits=标称,debitedCredits=实际扣款(<标称),
    //     必须发实际扣款值,否则用户面板看到的 meta 和左上角余额对不上
    //   - 23505 重入路径 debitedCredits=null → 跳过广播,前端靠 refreshBalance 兜底
    if (
      outcome.state === "committed"
      && outcome.debitedCredits !== null
      && outcome.debitedCredits > 0n
    ) {
      // 1) Durable persist FIRST — refresh-after-reply must show the
      //    same number the broadcast carries. Failure here is logged but
      //    does NOT block the broadcast: in-page UX still updates, and
      //    `pending_usage_patches` GC sweep will surface the straggler.
      if (appendCostCredits) {
        try {
          await appendCostCredits(
            requestId,
            uid.toString(),
            outcome.debitedCredits.toString(),
            // agent session id(ccb getSessionId,= cost 帧 sessionId)→ park 进 pending.session_id,
            // 供 ccb 助手落库按 session 精确 drain(per-turn 精确,消除 by-user 跨会话归并)。
            sessionId,
            // delegate 子会话:父客户端会话 id(web-*)→ park 进 pending.parent_session_id,
            // 供队长助手行落库按父客户端会话精确归并(Fix A durable)。普通 chat 恒 null,
            // 走上面的 session_id / by-user drain,零影响。
            parentSessionId,
            // P2 债D — 委派目标 agent id → park 进 pending.delegate_agent_id,drain 时按 agent
            // 分组产出 usage.delegates[] 明细。普通 chat 恒 null(不进 delegates[])。
            delegateAgentId,
          );
        } catch (err) {
          userLog.warn("proxy_persist_costcredits_failed", {
            err: errSummary(err),
            requestId,
          });
        }
      }
      // 2) Broadcast — in-page fast-path. Stays fire-and-broadcast even
      //    when persistence fails (see comment above).
      if (broadcastToUser) {
        try {
          broadcastToUser(uid, {
            type: "outbound.cost_charged",
            requestId,
            // credits 用字符串序列化,保留 BigInt 精度,避免 JS Number 53bit 边界。
            // (虽然单笔不太可能上亿积分,但 balance_after 累计可能。)
            costCredits: outcome.debitedCredits.toString(),
            balanceAfter: outcome.balanceAfter === null
              ? null
              : outcome.balanceAfter.toString(),
            sessionId,
            // Fix B — delegate 成本的父客户端会话 id(web-*)。前端据此把 cost_charged
            // 精确路由到父会话(消 60s TTL / 多会话并发误算);普通 chat null → 回落启发式。
            parentSessionId,
          });
        } catch (err) {
          userLog.warn("proxy_broadcast_cost_failed", { err: errSummary(err) });
        }
      }
    }
    // settle 三态(2I-2 codex 审核结论:partial 必须基于 observed.kind 判断,
    // 不能因 pipeStream 抛错就直接归 aborted —— observation 捕获了部分 usage):
    //   final   = stream 正常结束 + message_stop event 给齐 usage
    //   partial = stream 中途断 / 仅看到 message_delta,有部分 usage
    //   aborted = stream 没看到任何 usage(最早期就断)
    if (observed.kind === "final") incrAnthropicProxySettle("final");
    else if (observed.kind === "partial") incrAnthropicProxySettle("partial");
    else incrAnthropicProxySettle("aborted");
  } catch (err) {
    // 客户端断流(req/res close → ac.abort → fetch AbortError)走 client_error。
    // 仅按 err 形状判定,见 isClientAbort 注释。
    if (isClientAbort(err)) {
      await finalize.failClient(observed, err);
      recordProviderHealthSample(body.model, "aborted"); // 客户端断:judgement 排除
    } else {
      await finalize.fail(observed, err);
      recordProviderHealthSample(body.model, "timeout"); // fetch 抛错:超时/DNS/socket = provider 不可达
    }
    incrAnthropicProxySettle("aborted");
    // 字节是否已 flush 决定怎么发错误
    if (!res.headersSent) {
      sendJsonError(res, 500, "INTERNAL", "internal error", requestId);
    } else {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
  } finally {
    req.off("close", onClose);
    res.off("close", onClose);
    // session.zeroizeSecrets 内部 idempotent:即便 release 路径已经 zero 过也安全。
    // DeepSeek session 为 noop。
    session.zeroizeSecrets();
  }
}
