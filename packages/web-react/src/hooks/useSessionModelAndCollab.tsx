import {cursorModelSupportsContextTier,supportsFastServiceTier} from '@openclaude/protocol/browser';
import {SWITCH_COST_WARNING,type AuthorizeSwitch} from './useModelSwitchCost';
import {mintMsgId} from '../lib/chat/model';
import type {ModelSwitchCostRequest} from '@openclaude/protocol/browser';
/**
 * Active session model switching and collaboration mode (solo/team/advisor): selection, persistence and doc sync
 *
 * Moved verbatim out of App() (App.tsx) — FINDINGS §10, OCV5-472. App calls this hook at the
 * exact position the statements had, so React hook order and every value are unchanged.
 */
import { useEffect, useRef, useCallback, useState } from "react";
import { resolveSessionModel } from "../lib/modelPreferences";
import { freshSessionRequiredForSwitch, freshSessionSwitchNotice, modelSwitchCompactionReason } from "../lib/modelSwitch";
import { type CollabUiState, EMPTY_COLLAB_UI, docToUiState, type CollabMode, advisorParentCapabilityAllowed, ADVISOR_PARENT_BLOCK_REASON, recommendedAdvisorModel, keepCollabChoiceOnSaveFailure, collaborationPutBody } from "../lib/collaborationConfig";
import { api, ApiError, apiErrorMessage } from "../lib/api";
import type { Agent } from "../lib/agents";
import type { AuthSession, PublicModel, Session } from "../lib/types";
import type { ConfirmChoice, ConfirmOpts } from "../components/ui/ConfirmDialog";
import type { PrefsView } from "../lib/modelPreferences";
import type { UseChatSocket } from "./useChatSocket";
import type { ToastFn } from "../components/ui/Toast";

export type SessionModelAndCollabInput = {
  activeId: string | undefined;
  authorizeSwitch?: AuthorizeSwitch;
  getSwitchOptions?:()=>Partial<Pick<ModelSwitchCostRequest,'teamMode'|'contextTier'|'serviceTier'>>;
  agent: Agent;
  auth: AuthSession | null;
  confirmDialog: (opts: ConfirmOpts) => Promise<ConfirmChoice>;
  demo: boolean;
  handleNew: () => void;
  modelId: string | undefined;
  modelPrefs: PrefsView;
  modelSwitchPreparing: boolean;
  models: PublicModel[];
  queueModelPatch: (sessId: string, modelId: string) => void;
  resetSessionList: () => void;
  sessions: Session[];
  sessionsResetRef: React.RefObject<() => void>;
  setModelId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setModelSwitchPreparing: React.Dispatch<React.SetStateAction<boolean>>;
  setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
  sockRef: React.RefObject<UseChatSocket | null>;
  toast: ToastFn;
};

export function useSessionModelAndCollab({
  activeId,
  authorizeSwitch,
  getSwitchOptions,
  agent,
  auth,
  confirmDialog,
  demo,
  handleNew,
  modelId,
  modelPrefs,
  modelSwitchPreparing,
  models,
  queueModelPatch,
  resetSessionList,
  sessions,
  sessionsResetRef,
  setModelId,
  setModelSwitchPreparing,
  setSessions,
  sockRef,
  toast,
}: SessionModelAndCollabInput) {
  // ── per-session 模型选择(会话间互不影响,持久化恢复)────────────────────────
  //
  // 选择器的值 = 活动会话的有效模型:会话自己的持久化选择优先(须仍可见且健康,
  // 否则回落),其次 default_model 偏好,再回落首个健康模型(resolveSessionModel)。
  // 数据流:侧栏 Session.modelId(IndexedDB 注水 + listSessions server-wins + 选择写通)
  // 是本 effect 的读源;显式选择经 selectModel 写通三持有方(侧栏 + WS service/IndexedDB +
  // 服务端 PATCH,与 rename 同款收口)。空会话态(无 activeId)解析结果 = 纯默认,作为
  // "下一个新会话"的初始意图;空态显式选择只改 modelId state,不进本 effect 依赖,不被覆盖。
  const activeSessionModelId =
    !demo && activeId ? sessions.find((s) => s.id === activeId)?.modelId : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps verbatim from App() (OCV5-472); setModelId is App useState setter/useRef passed in, stable
  useEffect(() => {
    // 活动会话解析:切会话/会话模型到达(注水·listSessions·detail 回填)/偏好变更时恢复。
    // activeId 必须进依赖:A(有模型)→B(无模型)切换时 activeSessionModelId 可能不变,
    // 仅 activeId 变,不重跑就会把 A 的模型粘给 B。
    if (demo || models.length === 0 || !activeId) return;
    setModelId(resolveSessionModel(models, activeSessionModelId, modelPrefs));
  }, [demo, models, activeId, activeSessionModelId, modelPrefs]);
  // 「新建会话并以目标模型起手」的一次性意图(Opus/Fable 只能新会话使用的弹窗确认后写入):
  // 空态 effect 消费一次即清空,下一次新建仍回默认解析。
  const nextSessionModelRef = useRef<string | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps verbatim from App() (OCV5-472); setModelId is App useState setter/useRef passed in, stable
  useEffect(() => {
    // 空会话态默认:boot 初值与 default_model 变更传导(= 下一个新会话的初始意图)。
    // 空态的显式选择(selectModel 只 setModelId)不改本 effect 依赖,不会被覆盖。
    if (demo || models.length === 0 || activeId !== undefined) return;
    const pinned = nextSessionModelRef.current;
    nextSessionModelRef.current = undefined;
    if (pinned && models.some((m) => m.id === pinned)) {
      setModelId(pinned);
      return;
    }
    setModelId(resolveSessionModel(models, undefined, modelPrefs));
  }, [demo, models, activeId, modelPrefs]);

  // 显式选择模型:活动会话存在则写通三持有方(服务端经 queueModelPatch:选择即挂 pending
  // 意图压制一切在途旧载荷 + 单飞串行合并 PATCH,同时消掉「旧响应迟到盖回」与「连选
  // PATCH 倒序落库」两类竞态)。失败契约:服务端存有**旧值**时下次 listSessions
  // server-wins 盖回,重选即重试;服务端从未有值(NULL=从未显式选择,无"清除"流)则缺席
  // 不表态,本地意图保留 —— 两种失败面都可自愈。新会话行未建 404 同吞,由建行 PUT/建行后
  // 收敛 PATCH 落地。无活动会话(空会话态)仅更新选择器,作为下一会话意图。
  const modelSelectionEpochRef=useRef(0);
  const activeModelSwitchSessionRef = useRef(activeId);
  activeModelSwitchSessionRef.current = activeId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps verbatim from App() (OCV5-472); setModelId, setModelSwitchPreparing, sockRef are App useState setter/useRef passed in, stable
  const selectModel = useCallback(
    async (id: string) => {
      if (id === modelId || modelSwitchPreparing) return;
      const sid = activeId;
      const selectionEpoch=++modelSelectionEpochRef.current;
      const commit = (modelSwitchId?: string) => {
        if (activeModelSwitchSessionRef.current !== sid||modelSelectionEpochRef.current!==selectionEpoch) return;
        setModelId(id);
        // 成功反馈只挂用户主动切换路径:boot 恢复模型偏好走上方 resolveSessionModel 的
        // setModelId,不经过 commit,不会误报。失败面已有 toast(压缩失败)或 server-wins
        // 盖回,成功此前静默;压缩切换(prepareModelSwitch)带明确等待,给压缩语义文案。
        const displayName = models.find((m) => m.id === id)?.display_name ?? id;
        toast(
          modelSwitchId ? `已压缩上下文并切换到 ${displayName}` : `已切换到 ${displayName}`,
          "success",
        );
        if (demo) return;
        if (!sid) return;
        setSessions((c) => c.map((s) => (s.id === sid ? { ...s, modelId: id } : s)));
        sockRef.current?.setSessionModel(sid, id, modelSwitchId);
        queueModelPatch(sid, id);
      };
      if (demo || !activeId) {
        commit();
        return;
      }
      const currentMessages = sockRef.current?.getMessages(activeId) ?? [];
      const hasContent = (sessions.find((session) => session.id === activeId)?.messageCount ?? 0) > 0 ||
        currentMessages.some((message) =>
          message.role === "user" || message.role === "assistant" ||
          message.role === "tool" || message.role === "agent-group");
      // Opus / Fable 只能新会话起手(见 lib/modelSwitch):已有上下文的非 Opus/Fable 会话
      // 不切换,先说明原因(初始上下文过大 + 吃不到缓存),给「新建会话」快捷入口。
      if (freshSessionRequiredForSwitch(modelId, id, hasContent)) {
        const targetName = models.find((m) => m.id === id)?.display_name;
        const notice = freshSessionSwitchNotice(id, typeof targetName === "string" ? targetName : undefined);
        const go = await confirmDialog({
          title: notice.title,
          body: <div className="space-y-2 text-sm text-muted" data-testid="fresh-session-switch-notice">
            <p>{SWITCH_COST_WARNING}</p>
            {notice.paragraphs.map((text) => <p key={text}>{text}</p>)}
          </div>,
          confirmText: notice.confirmText,
          cancelText: notice.cancelText,
        });
        if (go !== true||activeModelSwitchSessionRef.current!==sid||modelSelectionEpochRef.current!==selectionEpoch) return;
        nextSessionModelRef.current = id;
        handleNew();
        return;
      }
      const reason = modelSwitchCompactionReason(models, modelId, id, hasContent);
      const details = [
        reason?.visionDowngrade ? "目标模型不支持当前会话的多模态上下文，图片等内容将转换为文字交接。" : null,
        reason?.contextDowngrade ? "目标模型的上下文窗口更短，需要先压缩当前会话。" : null,
      ].filter((detail): detail is string => detail !== null);
      const notice:ConfirmOpts|undefined=reason&&modelId?{
        title:"切换模型？",
        body:<div className="space-y-2 text-sm text-muted">
          {details.map(detail=><p key={detail}>{detail}</p>)}
          <p>压缩并切换会用当前模型生成交接内容，原始记录不会删除。直接切换沿用原来的方式，不压缩，新模型可能看不到完整上下文。</p>
        </div>,confirmText:"压缩并切换",altText:"直接切换",
      }:undefined;
      const options=getSwitchOptions?.();
      const authorization=authorizeSwitch?await authorizeSwitch({sessionId:activeId,requestId:mintMsgId(),targetModel:id,agentId:agent.id,teamMode:options?.teamMode,
        ...(cursorModelSupportsContextTier(id)&&options?.contextTier?{contextTier:options.contextTier}:{}),
        ...(supportsFastServiceTier(id)&&options?.serviceTier?{serviceTier:options.serviceTier}:{})},
        {notice,primeNextTurn:true,isCurrent:()=>activeModelSwitchSessionRef.current===sid&&modelSelectionEpochRef.current===selectionEpoch}):undefined;
      const confirmed=authorizeSwitch?authorization?.choice??false:notice?await confirmDialog({...notice,body:<>{SWITCH_COST_WARNING}{notice.body}</>}):true;
      if(confirmed===false||activeModelSwitchSessionRef.current!==sid||modelSelectionEpochRef.current!==selectionEpoch)return;
      if(!reason||!modelId||confirmed==='alt'){commit();return;}
      setModelSwitchPreparing(true);
      try {
        const switchId = await sockRef.current?.prepareModelSwitch(activeId, modelId, id);
        if (!switchId) throw new Error("模型切换准备失败");
        commit(switchId);
      } catch (error) {
        toast(error instanceof Error ? error.message : "上下文压缩失败，仍保留原模型", "error");
      } finally {
        setModelSwitchPreparing(false);
      }
    },
    [authorizeSwitch,getSwitchOptions,agent.id,demo, activeId, modelId, modelSwitchPreparing, models, sessions, setSessions, queueModelPatch, confirmDialog, toast, handleNew],
  );
  // 回填给 useAuth 的 chat 域收尾（onClearAuth/onLoginSuccess 经 sessionsResetRef 调用）。
  sessionsResetRef.current = resetSessionList;

  // Defaults belong to the authenticated server config. Legacy device keys are
  // unscoped across accounts and must never activate a more expensive mode.
  const [collabUi, setCollabUi] = useState<CollabUiState>(() => ({ ...EMPTY_COLLAB_UI }));
  const collabMode = collabUi.mode;
  const collabEpochRef = useRef(0);
  const [collabAsDefault, setCollabAsDefault] = useState(false);
  const [collabSaveError, setCollabSaveError] = useState<string | null>(null);
  const applyCollabDoc = useCallback((doc: Parameters<typeof docToUiState>[0]) => {
    const next = docToUiState(doc);
    setCollabUi(next);
    setCollabSaveError(null);
  }, []);
  // A draft becomes a session through send, Goal, or GitHub. Carry the same
  // authenticated intent across that identity change before a default GET runs.
  const promotedCollabRef = useRef<{
    sessionId: string; auth: AuthSession; identityEpoch: number;
    state: CollabUiState; asDefault: boolean; persist: boolean;
  } | null>(null);
  const promoteDraftCollab = useCallback((sessionId: string, state = collabUi, persist = true) => {
    if (!auth || agent.id !== "main") return;
    promotedCollabRef.current = { sessionId, auth, identityEpoch: auth.snapshot().epoch,
      state, asDefault: collabAsDefault, persist };
  }, [agent.id, auth, collabAsDefault, collabUi]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps verbatim from App() (OCV5-472); sockRef is App useState setter/useRef passed in, stable
  const persistCollab = useCallback(
    async (mode: CollabMode, opts?: { advisorModel?: string | null; asDefault?: boolean }) => {
      const epoch = ++collabEpochRef.current;
      const previous = collabUi;
      const parentEngineForGate =
        models.find((row) => row.id === modelId)?.engine ?? collabUi.parentEngine;
      if (
        mode === "advisor" &&
        !advisorParentCapabilityAllowed({
          parentEngine: parentEngineForGate,
          advisorConsultParents: collabUi.advisorConsultParents,
          advisorConsultAllowed: collabUi.advisorConsultAllowed,
        })
      ) {
        const msg = collabUi.advisorConsultParentReason || ADVISOR_PARENT_BLOCK_REASON;
        setCollabSaveError(msg);
        toast(msg, "error");
        return;
      }
      const advisorModel =
        mode === "advisor"
          ? (opts?.advisorModel ?? collabUi.advisorModel ?? recommendedAdvisorModel(collabUi))
          : null;
      const asDefault = opts?.asDefault === true;
      if(!demo&&auth&&activeId&&modelId&&mode!==collabUi.mode&&authorizeSwitch){
        const authorization=await authorizeSwitch({sessionId:activeId,requestId:mintMsgId(),targetModel:modelId,agentId:agent.id,
          ...(cursorModelSupportsContextTier(modelId)&&getSwitchOptions?.().contextTier?{contextTier:getSwitchOptions!().contextTier}:{}),
          ...(supportsFastServiceTier(modelId)&&getSwitchOptions?.().serviceTier?{serviceTier:getSwitchOptions!().serviceTier}:{}),teamMode:mode==='team'}, {primeNextTurn:true,isCurrent:()=>activeModelSwitchSessionRef.current===activeId&&collabEpochRef.current===epoch});
        if(!authorization)return;
      }
      // Optimistic mode only; configVersion stays empty until the server returns it.
      setCollabUi((cur) => ({ ...cur, mode, advisorModel, configVersion: "" }));
      setCollabSaveError(null);
      // useAuth.auth is null until authed; authRef always holds MemoryAuthSession.
      if (demo || !auth) return;
      const collabAuth = auth;
      const identityEpoch = collabAuth.snapshot().epoch;
      const isCurrent = () => epoch === collabEpochRef.current && collabAuth.snapshot().epoch === identityEpoch;
      // Empty composer has no sessionId. Skipping PUT avoids the old asDefault/!sessionId
      // default-write path; first send persists against the minted session id.
      if (!activeId && !asDefault) return;
      // Failed save: solo/team keep the pick, only advisor rolls back (keepCollabChoiceOnSaveFailure).
      const failSave = (msg: string) => {
        if (!keepCollabChoiceOnSaveFailure(mode)) {
          setCollabUi(previous);
        }
        setCollabSaveError(msg);
        toast(msg, "error");
      };
      if (activeId && sockRef.current) {
        if (modelId) sockRef.current.setSessionModel(activeId, modelId);
        const title =
          sessions.find((session) => session.id === activeId)?.title || "新对话";
        const ensured = await sockRef.current.ensureServerSession(activeId, agent.id, title);
        if (!isCurrent()) return;
        if (!ensured) {
          failSave("会话尚未创建成功，请检查网络后重试");
          return;
        }
      }
      try {
        const doc = await api.putCollaborationConfig(
          collabAuth,
          collaborationPutBody({
            sessionId: activeId,
            mode,
            advisorModel,
            expectedRev: collabUi.rev,
            asDefault,
          }),
        );
        if (!isCurrent()) return;
        applyCollabDoc(doc);
      } catch (err) {
        if (!isCurrent()) return;
        if (err instanceof ApiError && err.status === 409) {
          try {
            const fresh = await api.getCollaborationConfig(collabAuth, activeId);
            if (!isCurrent()) return;
            if (keepCollabChoiceOnSaveFailure(mode)) {
              setCollabUi({ ...docToUiState(fresh), mode, advisorModel: null, configVersion: "" });
              const saved = await api.putCollaborationConfig(collabAuth, collaborationPutBody({
                sessionId: activeId, mode, advisorModel: null, expectedRev: fresh.rev, asDefault,
              }));
              if (!isCurrent()) return;
              applyCollabDoc(saved);
            } else applyCollabDoc(fresh);
            return;
          } catch (rereadErr) {
            if (!isCurrent()) return;
            failSave(apiErrorMessage(rereadErr, "协作配置更新后保存失败"));
            return;
          }
        }
        failSave(apiErrorMessage(err, "协作配置保存失败"));
      }
    },
    [authorizeSwitch,getSwitchOptions,activeId, agent.id, applyCollabDoc, auth, collabUi, demo, modelId, models, sessions, toast],
  );
  const setCollabMode = useCallback(
    (mode: CollabMode) => {
      void persistCollab(mode, { asDefault: collabAsDefault });
    },
    [collabAsDefault, persistCollab],
  );
  const setTeamMode = useCallback(
    (enabled: boolean) => setCollabMode(enabled ? "team" : "solo"),
    [setCollabMode],
  );
  // 切会话:服务端配置为权威。epoch 让慢 GET 不能覆盖后来的会话或用户点击。
  // biome-ignore lint/correctness/useExhaustiveDependencies: persistCollab captures the promoted draft on this session change; later picker/model changes must not reload collaboration
  useEffect(() => {
    const epoch = ++collabEpochRef.current;
    const promoted = promotedCollabRef.current;
    promotedCollabRef.current = null;
    const intent = promoted && promoted.sessionId === activeId && promoted.auth === auth
      && promoted.identityEpoch === auth?.snapshot().epoch ? promoted : null;
    setCollabUi((cur) => (intent?.state ?? {
      ...EMPTY_COLLAB_UI,
      advisorModels: cur.advisorModels,
      advisorUnavailableReason: cur.advisorUnavailableReason,
      advisorConsultParents: cur.advisorConsultParents,
      advisorConsultParentReason: cur.advisorConsultParentReason,
    }));
    setCollabAsDefault(false);
    // auth is null until login/boot getMe (useAuth). authRef always holds the
    // MemoryAuthSession, including the anonymous epoch-0 object — do not GET on it.
    if (demo || !auth) return;
    const collabAuth = auth;
    const identityEpoch = collabAuth.snapshot().epoch;
    const isCurrent = () => epoch === collabEpochRef.current && collabAuth.snapshot().epoch === identityEpoch;
    if (intent) {
      // First send already attempted persistence. Do not replace its frozen
      // choice with an inherited default, including after a failed save.
      if (!intent.persist) return;
      // This render still holds the promoted draft state. Use the same CAS,
      // ensure-session, failure and identity handling as an explicit picker click.
      void persistCollab(intent.state.mode, {
        advisorModel: intent.state.advisorModel, asDefault: intent.asDefault,
      });
      return;
    }
    void api
      .getCollaborationConfig(collabAuth, activeId)
      .then((doc) => {
        if (!isCurrent()) return;
        applyCollabDoc(doc);
      })
      .catch((err) => {
        if (!isCurrent()) return;
        setCollabSaveError(apiErrorMessage(err, "协作配置读取失败"));
      });
  }, [activeId, applyCollabDoc, auth, demo]);

  return {
    applyCollabDoc,
    collabAsDefault,
    collabEpochRef,
    collabMode,
    collabSaveError,
    collabUi,
    persistCollab,
    promoteDraftCollab,
    selectModel,
    setCollabAsDefault,
    setCollabMode,
    setCollabSaveError,
    setCollabUi,
    setTeamMode,
    teamMode: collabMode === "team",
  };
}
