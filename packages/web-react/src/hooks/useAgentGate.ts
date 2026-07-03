import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../lib/api";
import type { AgentStatus, AuthSession } from "../lib/types";

/**
 * 对话前置态机（P3）。把"用户能否进入对话 / WS 能否连接"这件事收敛成单一权威源，
 * 供 App 渲染引导面板，并作为 **P4 useChatSocket 连接前的硬前置**：
 * 只有 `ready`（容器 running）才允许建立 user-chat-bridge WS。
 *
 * 状态来源（后端契约已核实，见 packages/commercial/src/http/agent.ts）：
 *   - GET  /api/agent/status → { runtime_ready, subscription, container }
 *   - POST /api/agent/open   → 202 provisioning / 402 余额不足 / 409 已订阅
 *   - 容器 open→running 过渡用 api.pollAgentReady 轮询（REST 侧）；WS 侧的容器冷启
 *     用 close code 4503 + Retry-After 表达，其重连节流由 P4 负责。
 */
export type AgentGatePhase =
  | { kind: "idle" }
  // 正在查询 /api/agent/status
  | { kind: "checking" }
  // runtime_ready=false：系统未开启 agent 运行时（前端无法自助解决）
  | { kind: "runtime-unavailable" }
  // 有运行时但无有效订阅：引导开通
  | { kind: "unsubscribed" }
  // 正在 POST /api/agent/open
  | { kind: "opening" }
  // 容器开机中（open 受理后 / status=provisioning），轮询至 running
  | { kind: "provisioning" }
  // 已订阅但容器休眠（stopped/removed）：P4 的 WS 连接会按需唤醒；P3 放行进入对话区
  | { kind: "dormant"; status: AgentStatus }
  // 容器 running：可对话，P4 WS 可连接
  | { kind: "ready"; status: AgentStatus }
  // 402 余额不足（shortfall = 缺口积分字符串，勿数值化）
  | { kind: "insufficient"; shortfall: string | null }
  // 其它错误（含容器开机失败 / 轮询超时 / 状态查询失败）
  | { kind: "error"; message: string; requestId?: string };

export type AgentGate = {
  phase: AgentGatePhase;
  /** 容器 running —— P4 WS 连接的硬前置。 */
  ready: boolean;
  /** 已有有效订阅且容器可达（ready | dormant），P3 据此放行进入对话区。 */
  access: boolean;
  /** 有网络动作在飞（轮询 / 查询 / 开通）。 */
  busy: boolean;
  /** （重新）查询订阅/容器状态。 */
  check: () => void;
  /** 开通订阅 → 轮询容器至就绪。 */
  open: () => void;
};

/** 由后端状态推导前置 phase（纯函数，无副作用，便于测试/推理）。 */
function derivePhase(s: AgentStatus): AgentGatePhase {
  if (!s.runtimeReady) return { kind: "runtime-unavailable" };
  // 按需线路(v5 ccb 单底座):无 legacy 订阅,容器随 user-chat-bridge WS 连接 ensureRunning 起。
  // 直接 ready 放行 WS 连接;冷启 provisioning 由 useChatSocket 的 4503 重试 + provisioning banner
  // 处理(不走 legacy /api/agent/open 订阅 gate —— v5 无 AGENT_IMAGE,open 会 503)。
  if (s.ondemand) return { kind: "ready", status: s };
  const sub = s.subscription;
  // status!=='active'（expired/canceled/suspended）一律视作需要重新开通。
  if (!sub || sub.status !== "active") return { kind: "unsubscribed" };
  const c = s.container;
  // 已订阅但容器记录缺失：刚 open 的竞态窗口，按开机中处理并轮询。
  if (!c) return { kind: "provisioning" };
  switch (c.status) {
    case "running":
      return { kind: "ready", status: s };
    case "provisioning":
      return { kind: "provisioning" };
    case "error":
      return { kind: "error", message: c.lastError || "容器开机失败，请稍后重试或联系支持。" };
    default:
      // stopped / removed / 未知：容器休眠，P4 连接时按需唤醒。
      return { kind: "dormant", status: s };
  }
}

function toErrorPhase(e: unknown, fallback: string): AgentGatePhase {
  if (e instanceof ApiError) return { kind: "error", message: e.message, requestId: e.requestId };
  return { kind: "error", message: (e as Error)?.message || fallback };
}

export function useAgentGate(auth: AuthSession | null, enabled: boolean): AgentGate {
  const [phase, setPhase] = useState<AgentGatePhase>({ kind: "idle" });

  // access token 的最新引用（避免 stale 闭包）。
  const authRef = useRef(auth);
  authRef.current = auth;

  // 单调 run id：任何新动作 ++，异步回写前比对，丢弃过期结果（防 unmount/切换后写入）。
  const runIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const cancelInflight = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  // 轮询容器至 running；abort/过期 run 静默退出。
  const pollToReady = useCallback(async (runId: number, ac: AbortController) => {
    const a = authRef.current;
    if (!a) return;
    try {
      const status = await api.pollAgentReady(a, { signal: ac.signal });
      if (runId !== runIdRef.current) return;
      setPhase({ kind: "ready", status });
    } catch (e) {
      if (runId !== runIdRef.current) return;
      if (e instanceof DOMException && e.name === "AbortError") return;
      setPhase(toErrorPhase(e, "容器开机失败，请稍后重试。"));
    }
  }, []);

  const check = useCallback(() => {
    const a = authRef.current;
    if (!a) return;
    cancelInflight();
    const runId = ++runIdRef.current;
    const ac = new AbortController();
    abortRef.current = ac;
    setPhase({ kind: "checking" });
    void (async () => {
      try {
        const status = await api.getAgentStatus(a);
        if (runId !== runIdRef.current) return;
        const next = derivePhase(status);
        setPhase(next);
        if (next.kind === "provisioning") void pollToReady(runId, ac);
      } catch (e) {
        if (runId !== runIdRef.current) return;
        setPhase(toErrorPhase(e, "无法获取工作区状态，请稍后重试。"));
      }
    })();
  }, [cancelInflight, pollToReady]);

  const open = useCallback(() => {
    const a = authRef.current;
    if (!a) return;
    cancelInflight();
    const runId = ++runIdRef.current;
    const ac = new AbortController();
    abortRef.current = ac;
    setPhase({ kind: "opening" });
    void (async () => {
      try {
        await api.openAgent(a); // 202 provisioning
        if (runId !== runIdRef.current) return;
        setPhase({ kind: "provisioning" });
        void pollToReady(runId, ac);
      } catch (e) {
        if (runId !== runIdRef.current) return;
        if (e instanceof ApiError) {
          if (e.status === 402) {
            setPhase({ kind: "insufficient", shortfall: e.issue("shortfall") ?? null });
            return;
          }
          if (e.status === 409) {
            // 已有有效订阅（可能正 provisioning/running）→ 重新探测真实状态。
            check();
            return;
          }
        }
        setPhase(toErrorPhase(e, "开通失败，请稍后重试。"));
      }
    })();
  }, [cancelInflight, pollToReady, check]);

  // 进入工作区（enabled && 已登录）自动探测一次；登出/离开时作废在飞动作并复位 idle。
  useEffect(() => {
    if (!enabled || !auth) {
      cancelInflight();
      runIdRef.current++;
      setPhase({ kind: "idle" });
      return;
    }
    check();
    return () => {
      cancelInflight();
      runIdRef.current++;
    };
  }, [enabled, auth, check, cancelInflight]);

  return {
    phase,
    ready: phase.kind === "ready",
    access: phase.kind === "ready" || phase.kind === "dormant",
    busy: phase.kind === "checking" || phase.kind === "opening" || phase.kind === "provisioning",
    check,
    open,
  };
}
