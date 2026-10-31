/**
 * One-shot app entry effects: workspace transitions, inbox, GitHub return, org invite and agent list refresh
 *
 * Moved verbatim out of App() (App.tsx) — FINDINGS §10, OCV5-472. App calls this hook at the
 * exact position the statements had, so React hook order and every value are unchanged.
 */
import { useRef, useEffect, useCallback, useState } from "react";
import { useInbox } from "./useInbox";
import { githubErrorText } from "../lib/github";
import { connectorErrorText } from "../lib/connectors";
import { replaceSearchParams } from "./useAppRoute";
import { api, apiErrorMessage } from "../lib/api";
import { applyIntelligentUiSnapshot } from "../lib/intelligentUi";
import { extractPrefs, type PrefsView } from "../lib/modelPreferences";
import { type Agent, DEFAULT_AGENT, agentFromApiRow } from "../lib/agents";
import type { AuthSession, LockedPublicModel, PublicConfig, PublicModel, User } from "../lib/types";
import type { ConfirmChoice, ConfirmOpts } from "../components/ui/ConfirmDialog";
import type { ManageTab } from "../lib/manageTabs";
import type { PreferenceEffort } from "../lib/modelPreferences";
import type { ToastFn } from "../components/ui/Toast";

export type AppDeepLinksInput = {
  auth: AuthSession | null;
  authRef: React.RefObject<AuthSession>;
  authed: boolean;
  confirmDialog: (opts: ConfirmOpts) => Promise<ConfirmChoice>;
  demo: boolean;
  handleNew: () => void;
  inWorkspace: boolean;
  publicCfgRetryNonce: number;
  refreshMe: () => Promise<void>;
  routingEnabled: boolean;
  setComposerPrefill: React.Dispatch<React.SetStateAction<{ text: string; nonce: number; } | null>>;
  setLockedModels: React.Dispatch<React.SetStateAction<LockedPublicModel[]>>;
  setManageOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setManageTab: React.Dispatch<React.SetStateAction<ManageTab>>;
  setModelPrefs: React.Dispatch<React.SetStateAction<PrefsView>>;
  setModels: React.Dispatch<React.SetStateAction<PublicModel[]>>;
  setModelsLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setMyAgents: React.Dispatch<React.SetStateAction<Agent[]>>;
  setPreferenceEffort: React.Dispatch<React.SetStateAction<PreferenceEffort | undefined>>;
  setPublicCfg: React.Dispatch<React.SetStateAction<PublicConfig | null>>;
  setPublicCfgRetryNonce: React.Dispatch<React.SetStateAction<number>>;
  toast: ToastFn;
  user: User | null;
  view: "home" | "app";
};

export function useAppDeepLinks({
  auth,
  authRef,
  authed,
  confirmDialog,
  demo,
  handleNew,
  inWorkspace,
  publicCfgRetryNonce,
  refreshMe,
  routingEnabled,
  setComposerPrefill,
  setLockedModels,
  setManageOpen,
  setManageTab,
  setModelPrefs,
  setModels,
  setModelsLoading,
  setMyAgents,
  setPreferenceEffort,
  setPublicCfg,
  setPublicCfgRetryNonce,
  toast,
  user,
  view,
}: AppDeepLinksInput) {
  const [teamLeaderModelId, setTeamLeaderModelId] = useState<string | undefined>(undefined);
  // 登录后消费待跑案例：只在 inWorkspace false→true 时读一次；有键先删再预填，禁止自动发送。
  const wasInWorkspaceRef = useRef(inWorkspace);
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps verbatim from App() (OCV5-472); setComposerPrefill is App useState setter/useRef passed in, stable
  useEffect(() => {
    const entered = inWorkspace && !wasInWorkspaceRef.current;
    wasInWorkspaceRef.current = inWorkspace;
    if (!entered) return;
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem("oc_v5_pending_case");
      if (!raw) return;
      sessionStorage.removeItem("oc_v5_pending_case");
    } catch {
      return;
    }
    let text = "";
    let fromLanding = false;
    try {
      const parsed = JSON.parse(raw) as { starterPrompt?: unknown; source?: unknown };
      if (typeof parsed.starterPrompt === "string") text = parsed.starterPrompt;
      fromLanding = parsed.source === "landing";
    } catch {
      return;
    }
    if (!text) return;
    handleNew();
    setComposerPrefill({ text, nonce: Date.now() });
    toast(
      fromLanding ? "已带入你在首页写下的任务，不会自动发送" : "已带入案例指令，不会自动发送",
      "info",
    );
  }, [inWorkspace, handleNew, toast]);

  // 站内信未读轮询（铃铛红点）。demo / 未登录不发请求。
  const inbox = useInbox(auth, inWorkspace && !demo);

  // GitHub OAuth 回调返回：URL 带 ?github_linked / ?github_error → toast + 清 query（仅一次，
  // 对齐 v3 handleBootGithubParams）。redirect 回 /?github_linked=1，全局 toast 即时反馈。
  const githubReturnHandledRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps verbatim from App() (OCV5-472); setManageOpen, setManageTab are App useState setter/useRef passed in, stable
  useEffect(() => {
    if (demo || githubReturnHandledRef.current) return;
    githubReturnHandledRef.current = true;
    const sp = new URLSearchParams(window.location.search);
    let touched = false;
    if (sp.has("github_linked")) {
      toast("GitHub 账号已连接", "success");
      sp.delete("github_linked");
      touched = true;
    }
    if (sp.has("github_error")) {
      toast(`GitHub 连接失败：${githubErrorText(sp.get("github_error"))}`, "error");
      sp.delete("github_error");
      touched = true;
    }
    // 应用连接器 BYOA OAuth 回调（照 github_linked 模式）：/?connector_linked=<provider> 或
    // /?connector_error=<code>（错误码经 connectorErrorText 映射中文，不裸露码）。
    if (sp.has("connector_linked")) {
      // 用户向名词全链路统一为「插件」（市场品类 / 管理中心 Tab / 本 toast 同名）。
      toast("插件已连接", "success");
      setManageTab("connectors");
      setManageOpen(true);
      sp.delete("connector_linked");
      touched = true;
    }
    if (sp.has("connector_error")) {
      toast(`插件连接失败：${connectorErrorText(sp.get("connector_error"))}`, "error");
      sp.delete("connector_error");
      touched = true;
    }
    if (touched) replaceSearchParams(sp);
  }, [demo, toast]);

  // 组织邀请接受流:URL 带 ?orgInvite=<token>。已登录 → 确认弹层 → accept → 刷新 /api/me;
  // 未登录 → token 留在 URL(不清),先走 AuthGate 登录/注册,进工作区后本 effect 再触发续接。
  const orgInviteTokenRef = useRef<string | null>(
    !demo && routingEnabled ? new URLSearchParams(location.search).get("orgInvite") : null,
  );
  const orgInviteHandledRef = useRef(false);
  useEffect(() => {
    if (demo || orgInviteHandledRef.current) return;
    const token = orgInviteTokenRef.current;
    if (!token) return;
    // 未进工作区(未登录)→ 保留 token,等登录完成后再处理(effect 依赖变化会重跑)。
    if (!inWorkspace || !auth || !user) return;
    orgInviteHandledRef.current = true;
    const a = auth;
    void (async () => {
      const ok = await confirmDialog({
        title: "接受组织邀请?",
        body: "你被邀请加入一个组织。接受后你的对话用量将可计入该组织钱包。",
        confirmText: "接受邀请",
      });
      // 无论接受与否都清掉 query,避免刷新重复弹层。
      const sp = new URLSearchParams(window.location.search);
      sp.delete("orgInvite");
      replaceSearchParams(sp);
      if (!ok) return;
      try {
        await api.acceptOrgInvitation(a, token);
        await refreshMe();
        toast("已加入组织", "success");
      } catch (e) {
        toast(apiErrorMessage(e, "接受组织邀请失败"), "error");
      }
    })();
  }, [demo, inWorkspace, auth, user, confirmDialog, refreshMe, toast]);

  // 进入登录页（view=app 且未认证）时拉公开配置：决定 AuthGate 是否渲染真 Turnstile
  // widget。短暂失败自动重试；停在首页（home）/demo/已登录均不拉。
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps verbatim from App() (OCV5-472); setPublicCfg, setPublicCfgRetryNonce are App useState setter/useRef passed in, stable
  useEffect(() => {
    if (demo || authed || view !== "app") return;
    void publicCfgRetryNonce;
    let cancelled = false;
    let retryTimer: number | undefined;
    api
      .getPublicConfig()
      .then((c) => {
        if (!cancelled) {
          setPublicCfg(c);
        }
      })
      .catch(() => {
        if (!cancelled) {
          /* 拿不到 config：publicCfg 维持 null → AuthGate fail-closed（bypass 未知时点击只
           * 登记 intent，绝不发占位 token）。短暂失败自动恢复，不形成永久灰锁。 */
          retryTimer = window.setTimeout(() => setPublicCfgRetryNonce((n) => n + 1), 1000);
        }
      });
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [demo, authed, view, publicCfgRetryNonce]);

  // 进入工作区后拉取模型列表（公开端点；登录态带 Bearer 走 grants 视图）。失败不阻断
  // 对话前置——选择器降级为「暂无可用模型」，对话仍可在订阅就绪后进行。
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps verbatim from App() (OCV5-472); setLockedModels, setModelPrefs, setModels, setModelsLoading, setPreferenceEffort are App useState setter/useRef passed in, stable
  useEffect(() => {
    if (demo || !auth) return;
    let cancelled = false;
    setModelsLoading(true);
    Promise.all([
      api.getPublicModels(auth),
      api
        .getPreferences(auth)
        .then((snap) => {
          // Intelligent UI 开关(OCV5-361)与模型偏好同批水合。
          applyIntelligentUiSnapshot(snap);
          return extractPrefs(snap);
        })
        .catch(() => ({} as PrefsView)),
    ])
      .then(([catalog, prefs]) => {
        if (cancelled) return;
        setModels(catalog.models);
        setLockedModels(catalog.lockedModels);
        setTeamLeaderModelId(catalog.teamLeaderModelId);
        // 初始 modelId 不在此直接写:models/modelPrefs 落定会触发 per-session resolver
        // effect,按「活动会话持久化选择 > default_model > 首个健康模型」统一解析。
        setModelPrefs(prefs);
        setPreferenceEffort(prefs.default_effort);
      })
      .catch(() => {
        /* 公开端点失败：保持空列表，选择器禁用，不弹错误打断前置流程 */
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [demo, auth]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps verbatim from App() (OCV5-472); authRef is App useState setter/useRef passed in, stable
  const fetchMyAgents = useCallback(async (): Promise<Agent[]> => {
    if (demo || !auth) return [DEFAULT_AGENT];
    const rows = await api.listMyAgents(authRef.current);
    return rows.map(agentFromApiRow);
  }, [demo, auth]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps verbatim from App() (OCV5-472); setMyAgents is App useState setter/useRef passed in, stable
  const refreshMyAgents = useCallback(async (): Promise<Agent[]> => {
    const rows = await fetchMyAgents();
    setMyAgents(rows);
    return rows;
  }, [fetchMyAgents]);

  // 已装智能体目录:登录后拉一次(会话 agent 归属解析用;失败留默认,解析回落 stub 不阻断)。
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps verbatim from App() (OCV5-472); setMyAgents is App useState setter/useRef passed in, stable
  useEffect(() => {
    if (demo || !auth) return;
    let cancelled = false;
    fetchMyAgents()
      .then((rows) => {
        if (!cancelled) setMyAgents(rows);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [demo, auth, fetchMyAgents]);

  return {
    inbox,
    refreshMyAgents,
    teamLeaderModelId,
  };
}
