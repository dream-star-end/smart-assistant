import type {AuthorizeSwitch} from './useModelSwitchCost';
import {mintMsgId} from '../lib/chat/model';
import {formatMessageReplyPrompt} from '@openclaude/protocol/browser';
/**
 * Composer send pipeline: send, project start, media upload and image edit/comment actions
 *
 * Moved verbatim out of App() (App.tsx) — FINDINGS §10, OCV5-472. App calls this hook at the
 * exact position the statements had, so React hook order and every value are unchanged.
 */
import { useCallback, useState, useRef, useEffect, useMemo } from "react";
import type { MediaRef, InboundMessage } from "../lib/chat/frames";
import { type MessageReplyQuote, cursorModelSupportsContextTier, supportsFastServiceTier, isCodexEngineModel } from "@openclaude/protocol/browser";
import { sessionTitleFromText } from "../lib/sessionTitle";
import type { Message, Session } from "../lib/types";
import { demoReply } from "../lib/demo";
import { findRewriteTarget } from "../lib/implicitFeedback";
import { prepareAdvisorSend, saveInitialCollaboration, persistRecoveredAdvisor } from "../lib/collaborationSend";
import { writeSessionEffort } from "../lib/sessionEffort";
import { writeContextTier } from "../lib/sessionContextTier";
import { writeSessionServiceTier } from "../lib/sessionServiceTier";
import { docToUiState, keepCollabChoiceOnSaveFailure, sendCollabFields } from "../lib/collaborationConfig";
import { apiErrorMessage, api } from "../lib/api";
import { effortForModel, effectiveEffortModelId } from "../lib/modelPreferences";
import type { ImageEditSubmit, ImageCommentSubmit, ImageEditActions } from "../components/chat/imageEditActions";
import type { Agent } from "../lib/agents";
import type { CollabUiState, CollaborationConfigDoc } from "../lib/collaborationConfig";
import type { AuthSession, PublicConfig, PublicModel, User } from "../lib/types";
import type { PreferenceEffort } from "../lib/modelPreferences";
import type { ProjectRoute } from "./useAppRoute";
import type { ImplicitTarget } from "../lib/implicitFeedback";
import type { ImplicitReason } from "./useResponseRatings";
import type { ChatError } from "../components/ErrorBanner";
import type { ImageAnnotationSource } from "../components/ImageAnnotationEditor";
import type { UseChatSocket } from "./useChatSocket";
import type { ToastFn } from "../components/ui/Toast";

export type ComposerSendInput = {
  activeId: string | undefined;
  authorizeSwitch?: AuthorizeSwitch;
  agent: Agent;
  applyCollabDoc: (doc: CollaborationConfigDoc) => void;
  auth: AuthSession | null;
  authRef: React.RefObject<AuthSession>;
  boardOpen: boolean;
  collabAsDefault: boolean;
  collabEpochRef: React.RefObject<number>;
  collabUi: CollabUiState;
  contextTier: "300k" | "1m";
  demo: boolean;
  draftProjectId: string | null;
  draftProjectRef: React.RefObject<string | null>;
  draftSessionId: string;
  modelId: string | undefined;
  models: PublicModel[];
  newSessionInProject: (projectId: string) => void;
  preferenceEffort: PreferenceEffort | undefined;
  projectHome: ProjectRoute | null;
  promoteDraftCollab: (sessionId: string, state?: CollabUiState, persist?: boolean) => void;
  publicCfg: PublicConfig | null;
  selectedSessionIdRef: React.RefObject<string | undefined>;
  sendImplicitRatingRef: React.RefObject<((target: ImplicitTarget, opts: { reason: ImplicitReason; }) => void) | null>;
  sendScrollRef?: React.RefObject<(() => void) | null>;
  serviceTier: "fast" | null;
  sessionEffort: PreferenceEffort | null | undefined;
  sessions: Session[];
  setActiveId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setBoardOpen: (open: boolean) => void;
  setBusy: React.Dispatch<React.SetStateAction<boolean>>;
  setChatError: React.Dispatch<React.SetStateAction<ChatError | null>>;
  setCollabSaveError: React.Dispatch<React.SetStateAction<string | null>>;
  setCollabUi: React.Dispatch<React.SetStateAction<CollabUiState>>;
  setDraftProject: (projectId: string | null) => void;
  setImageAnnotationSource: React.Dispatch<React.SetStateAction<ImageAnnotationSource | null>>;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
  setStreamText: React.Dispatch<React.SetStateAction<string>>;
  sockRef: React.RefObject<UseChatSocket | null>;
  stopPreparing: () => void;
  stopRef: React.RefObject<boolean>;
  toast: ToastFn;
  user: User | null;
};

export function useComposerSend({
  activeId,
  authorizeSwitch,
  agent,
  applyCollabDoc,
  auth,
  authRef,
  boardOpen,
  collabAsDefault,
  collabEpochRef,
  collabUi,
  contextTier,
  demo,
  draftProjectId,
  draftProjectRef,
  draftSessionId,
  modelId,
  models,
  newSessionInProject,
  preferenceEffort,
  projectHome,
  promoteDraftCollab,
  publicCfg,
  selectedSessionIdRef,
  sendImplicitRatingRef,
  sendScrollRef,
  serviceTier,
  sessionEffort,
  sessions,
  setActiveId,
  setBoardOpen,
  setBusy,
  setChatError,
  setCollabSaveError,
  setCollabUi,
  setDraftProject,
  setImageAnnotationSource,
  setMessages,
  setSessions,
  setStreamText,
  sockRef,
  stopPreparing,
  stopRef,
  toast,
  user,
}: ComposerSendInput) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps verbatim from App() (OCV5-472); authRef, collabEpochRef, draftProjectRef, selectedSessionIdRef, sendImplicitRatingRef, setBusy, setChatError, setCollabSaveError, setCollabUi, setMessages, setStreamText, sockRef, stopRef are App useState setter/useRef passed in, stable
  const send = useCallback(
    async (
      text: string,
      media?: MediaRef[],
      imageEdit?: InboundMessage["content"]["imageEdit"],
      displayText?: string,
      replyTo?: MessageReplyQuote,
      target?: { sessionId: string; projectId?: string | null },
    ) => {
      setChatError(null);
      const visibleText = displayText ?? text;
      const sessionTitle = sessionTitleFromText(visibleText);

      // demo：本地流式回放（无网络），仅用于离线预览设计。
      if (demo) {
        const userMsg: Message = {
          id: `tmp-${Date.now()}`,
          role: "user",
          content: visibleText,
          createdAt: new Date().toISOString(),
        };
        setMessages((m) => [...m, userMsg]);
        sendScrollRef?.current?.();
        setBusy(true);
        setStreamText("");
        stopRef.current = false;
        const full = demoReply(text);
        for (let i = 0; i < full.length && !stopRef.current; i += 3) {
          setStreamText(full.slice(0, i + 3));
          await new Promise((r) => setTimeout(r, 12));
        }
        setMessages((m) => [
          ...m,
          { id: `a-${Date.now()}`, role: "assistant", content: full, createdAt: new Date().toISOString() },
        ]);
        setStreamText("");
        setBusy(false);
        return true;
      }

      if (!user || !sockRef.current) {
        if (target) throw new Error("登录状态或会话连接不可用");
        return false;
      }
      const sendProjectId = target ? target.projectId : draftProjectRef.current;
      // 隐式负反馈（改写重发）：发送前用**当前会话**的现有消息判定「5min 内高相似改写」——
      // 命中即对被改写轮的末条 assistant 静默记 implicit down（空会话无历史 → 命中不了）。
      // 现场取消息（sockRef.current === chat，稳定句柄）而非捕获每帧刷新的 wsMessages。
      if (!target) {
        const rewriteTarget = findRewriteTarget(
          sockRef.current?.getMessages(activeId) ?? [],
          visibleText,
          Date.now(),
        );
        if (rewriteTarget) sendImplicitRatingRef.current?.(rewriteTarget, { reason: "改写重发" });
      }
      // 非 demo：经真实 WS 引擎发送（inbound.message）。确保有会话承载本轮（peer.id）。
      const originalSessionId = target?.sessionId ?? activeId;
      const sessionId = originalSessionId ?? draftSessionId;
      let createdSession: Session | null = null;
      const recoveryEpoch = collabEpochRef.current;
      const recoverySelection = selectedSessionIdRef.current;
      const recoveryIdentity = auth?.snapshot().epoch;
      const recoveryIdentityIsCurrent = () => auth?.snapshot().epoch === recoveryIdentity;
      const recoveryIsCurrent = () => collabEpochRef.current === recoveryEpoch
        && selectedSessionIdRef.current === recoverySelection && (!target || target.sessionId === recoverySelection) && recoveryIdentityIsCurrent();
      if (!originalSessionId) stopPreparing();
      const recovery = await prepareAdvisorSend({
        agentId: agent.id, original: collabUi, auth, sessionId: originalSessionId,
        parentEngine: models.find((row) => row.id === modelId)?.engine ?? collabUi.parentEngine,
        isCurrent: recoveryIdentityIsCurrent,
        update: (state, recovered) => {
          if (!recoveryIsCurrent()) return false;
          setCollabUi(state);
          setCollabSaveError(null);
          if (recovered) toast("顾问暂不可用，已由当前主模型继续处理", "info");
        },
      });
      if (!recovery || !recoveryIdentityIsCurrent()) return false;
      let latestCollab = recovery.state;
      const recoveredAdvisor = recovery.recoveredAdvisor;
      if (!originalSessionId) {
        createdSession = {
          id: sessionId,
          title: sessionTitle,
          ownerUserId: user.id,
          updatedAt: new Date().toISOString(),
          messageCount: 0,
          // 项目下新建：草稿建行即归属目标项目（侧栏首帧正确分组；服务端归属在下方首发收尾 PATCH）。
          ...(sendProjectId ? { projectId: sendProjectId } : {}),
          // 首发定格会话模型:当前有效模型(含空态显式选择)落为该会话的 per-session 选择,
          // 之后 default_model 变更/其它会话换模都不影响它。
          ...(modelId ? { modelId } : {}),
        };
        // 显式档位选择存在才落地(未选择 = 继续继承全局偏好,不写键)。
        if (sessionEffort !== undefined) writeSessionEffort(sessionId, sessionEffort);
        writeContextTier(sessionId, contextTier);
        writeSessionServiceTier(sessionId, serviceTier);
        sockRef.current?.ensureSession(sessionId, agent.id, sessionTitle);
        if (modelId) sockRef.current?.setSessionModel(sessionId, modelId);
        if (auth && agent.id === "main" && !recoveredAdvisor) {
          const collabAuth = auth;
          const identityEpoch = collabAuth.snapshot().epoch;
          try {
            const ensured = await sockRef.current?.ensureServerSession(sessionId, agent.id, sessionTitle);
            if (collabAuth.snapshot().epoch !== identityEpoch) return false;
            if (!ensured) throw new Error("会话尚未创建成功，请检查网络后重试");
            const doc = await saveInitialCollaboration(auth, sessionId, latestCollab, collabAsDefault, identityEpoch);
            if (!doc || collabAuth.snapshot().epoch !== identityEpoch) return false;
            if (recoveryIsCurrent()) applyCollabDoc(doc);
            latestCollab = docToUiState(doc);
          } catch (err) {
            if (collabAuth.snapshot().epoch !== identityEpoch) return false;
            // Team still sends: it rides on the turn frame. Only advisor needs the saved config.
            const msg = apiErrorMessage(err, "协作配置保存失败，请重新选择后重试");
            setCollabSaveError(msg);
            toast(msg, "error");
            if (!keepCollabChoiceOnSaveFailure(latestCollab.mode)) return false;
          }
        }
      }
      const sendCollab = sendCollabFields({
        ...latestCollab, agentId: agent.id,
        parentEngine: models.find((row) => row.id === modelId)?.engine ?? latestCollab.parentEngine,
      });
      if (sendCollab.blockedReason) {
        toast(sendCollab.blockedReason, "error");
        return false;
      }
      const authorization=!imageEdit&&modelId&&authorizeSwitch?await authorizeSwitch({
        sessionId,requestId:mintMsgId(),targetModel:modelId,agentId:agent.id,teamMode:sendCollab.teamMode,
        text:formatMessageReplyPrompt(text,replyTo),mediaCount:media?.length??0,
        ...(cursorModelSupportsContextTier(modelId)?{contextTier}:{}),
        ...(serviceTier==='fast'&&supportsFastServiceTier(modelId)?{serviceTier}:{}),
      },{useCachedRequestId:true,allowOfflineQueue:true,
        canPrompt:recoveryIsCurrent,
        isCurrent:()=>recoveryIdentityIsCurrent()&&(!originalSessionId||!!sockRef.current?.getSession(sessionId))}):undefined;
      if(!imageEdit&&modelId&&authorizeSwitch&&!authorization)return false;
      const materializedDraft =
        !createdSession && (
          sessions.some((session) => session.id === sessionId && session.messageCount === 0) ||
          (!!target && (sockRef.current?.getMessages(sessionId).length ?? 0) === 0)
        );
      // 项目草稿被首轮前操作（Goal / GitHub 绑定）物化成会话行的场景：归属同样在首发落定。
      if (materializedDraft && sendProjectId) {
        const draftPid = sendProjectId;
        setSessions((c) =>
          c.map((x) => (x.id === sessionId && !x.projectId ? { ...x, projectId: draftPid } : x)),
        );
      }
      sockRef.current?.ensureSession(sessionId, agent.id, sessionTitle);
      if (materializedDraft) {
        // Goal/GitHub 可在首条消息前物化服务端行。首发时须同步收敛真正标题；否则
        // 后端幂等 INSERT 不更新既有行，刷新后 listSessions 会把「新对话」盖回来。
        sockRef.current?.renameSession(sessionId, sessionTitle);
        void api.patchSessionTitle(authRef.current, sessionId, sessionTitle).catch(() => {
          // 行尚未建时 PATCH 可 404；随后 send 的幂等 PUT 会使用上面已更新的 socket 标题。
        });
      }
      // model / effortLevel 都是 inbound.message 顶层路由字段。用户未设置 effort 或
      // 当前模型不支持时省略(null=显式清除回模型默认),让模型沿用自身默认。
      // effort 来源:本会话显式选择(sessionEffort,聊天头档位选择器)优先,缺省回落
      // 用户全局偏好(preferences.default_effort);effortForModel 负责按当前执行模型
      // 的支持集过滤(不支持 → null 发送,不硬塞)。
      // media：已上传附件（图片/文件等），随 inbound.message.content.media 发送。
      // teamMode 只对 main 队长生效(其它 agent 无委派语义),故非 main 恒 false。
      if (!target || target.sessionId === selectedSessionIdRef.current) {
        sendScrollRef?.current?.();
      }
      const teamLeaderTurn = sendCollab.teamMode;
      const sent=await sockRef.current?.send({
        ...(authorization?{switchAuthorization:authorization}:{}),
        sessId: sessionId,
        agentId: agent.id,
        text,
        ...(displayText !== undefined && displayText !== text ? { displayText } : {}),
        model: modelId,
        effortLevel: effortForModel(
          models,
          effectiveEffortModelId(modelId, teamLeaderTurn),
          sessionEffort !== undefined ? sessionEffort : preferenceEffort,
        ),
        media,
        imageEdit,
        replyTo,
        teamMode: teamLeaderTurn,
        collabMode: sendCollab.collabMode,
        ...(sendCollab.collabMode === "advisor"
          ? {
              advisorModel: sendCollab.advisorModel,
              collabConfigVersion: sendCollab.collabConfigVersion,
            }
          : {}),
        // Cursor Opus/Fable 上下文档位:只在当前模型支持分档时随帧发送;其它模型不带该字段
        // (master 对非分档模型本就忽略,但不发送可以让路由快照/日志更干净)。
        ...(cursorModelSupportsContextTier(modelId) ? { contextTier } : {}),
        // OCV5-434 GPT Fast:只在当前模型支持且用户开着时随帧发送;不带 = 标准。
        ...(serviceTier === "fast" && supportsFastServiceTier(modelId) ? { serviceTier } : {}),
      });
      if(sent===false)return false;
      // Fee confirmation keeps ownership of the draft until the send is accepted.
      if (createdSession && recoveryIsCurrent()) {
        promoteDraftCollab(sessionId, latestCollab, false);
        setActiveId(sessionId);
      }
      if (recoveredAdvisor && auth) void persistRecoveredAdvisor({
        auth, sessionId, rev: latestCollab.rev, isCurrent: recoveryIsCurrent,
        ensureSession: (recoverySession) => sockRef.current?.ensureServerSession(recoverySession, agent.id, sessionTitle),
      });
      // 侧栏：提到顶 + 更新标题/时间/计数（计数仅作排序提示，权威消息在 WS service）。
      setSessions((c) => {
        const sid = sessionId!;
        const found = c.find((s) => s.id === sid);
        const base: Session =
          found ?? createdSession ?? { id: sid, title: sessionTitle, ownerUserId: user.id, updatedAt: "", messageCount: 0 };
        const updated: Session = {
          ...base,
          id: sid,
          title: found?.title && found.messageCount > 0 ? found.title : sessionTitle,
          updatedAt: new Date().toISOString(),
          messageCount: (found?.messageCount ?? 0) + 1,
        };
        return [updated, ...c.filter((s) => s.id !== sid)];
      });
      // 首发收尾：把「项目下新建」的归属落到服务端 canonical。行由 WS 受理 / 幂等 PUT 建立，
      // PATCH 可能在建行前到达（404），补一次延迟重试；仍失败则放弃——本地归属已正确，
      // 用户可手动移动，下次 listSessions server-wins 会盖回，不阻塞首发。
      if (sendProjectId && sessionId) {
        const draftPid = sendProjectId;
        if (createdSession || materializedDraft) {
          if (
            draftProjectRef.current === draftPid &&
            (!target || selectedSessionIdRef.current === sessionId)
          ) setDraftProject(null);
          const applyProject = (retries: number) => {
            api.patchSessionMeta(authRef.current, sessionId!, { projectId: draftPid }).catch((e: unknown) => {
              if (retries > 0) window.setTimeout(() => applyProject(retries - 1), 1500);
              else console.warn("patchSessionMeta(projectId) failed", e);
            });
          };
          applyProject(1);
        }
      }
      return true;
    },
    // teamMode 不再入依赖:自 08326136f 起 send 只从 collabUi/collabMode 取模式(sendCollabFields),
    // 不读 teamMode 本身(OCV5-376)。applyCollabDoc/toast/setDraftProject 都是稳定引用,补齐不改重建时机。
    // setSessions/setActiveId 是 useSessionList 透传的 useState dispatcher(恒稳定),入 deps
    // 仅为满足 lint(跨 hook 返回值 biome 不再推断稳定性),不改变 send 的重建时机。
    [
      activeId,
      authorizeSwitch,
      draftSessionId,
      stopPreparing,
      auth,
      demo,
      user,
      agent,
      modelId,
      models,
      preferenceEffort,
      sessionEffort,
      contextTier,
      serviceTier,
      collabUi,
      collabAsDefault,
      sessions,
      setSessions,
      setActiveId,
      applyCollabDoc,
      promoteDraftCollab,
      toast,
      setDraftProject,
    ],
  );

  // 项目主页「在 X 里开始…」/ 快捷开始：先进入该项目的空白草稿，再在草稿就位后发送首条消息。
  // 不能与 newSessionInProject 同一拍调用 send：send 同步读 draftProjectRef，但 activeId、模型、
  // 思考档位、上下文档位、团队模式都取自闭包；它们由「activeId 变化」触发的 effect 重置为新会话
  // 的默认值，同一轮 effect 里拿到的 send 仍是旧会话的配置(会把旧会话的模型定格进新会话)。
  // 所以分两拍：①草稿就位(对话工作区 + 无选中 + 草稿归属该项目)时只「上膛」——此时各重置 effect
  // 的 setState 与上膛同批提交；②下一次渲染后的 effect 用新的 send 发送，与手动新建会话后再发一致。
  // nonce 保证只发一次；任一拍发现草稿不在(用户已走开 / 未登录 newSession 直接返回)即丢弃，
  // 不把消息发进别的会话。
  const [pendingProjectStart, setPendingProjectStart] = useState<
    { projectId: string; text: string; nonce: number; armed: boolean } | null
  >(null);
  const consumedProjectStartRef = useRef(0);
  const startInProject = useCallback(
    (projectId: string, text: string) => {
      const t = text.trim();
      if (!t) return;
      setBoardOpen(false);
      newSessionInProject(projectId);
      setPendingProjectStart({ projectId, text: t, nonce: Date.now() + Math.random(), armed: false });
    },
    [setBoardOpen, newSessionInProject],
  );
  useEffect(() => {
    const p = pendingProjectStart;
    if (!p || consumedProjectStartRef.current === p.nonce) return;
    // demo 的 newSession 会立即建一条本地会话并选中，所以 demo 不要求 activeId 为空。
    const draftReady =
      (demo || activeId === undefined) &&
      !boardOpen &&
      !projectHome &&
      draftProjectId === p.projectId;
    if (!draftReady) {
      consumedProjectStartRef.current = p.nonce;
      setPendingProjectStart(null);
      return;
    }
    if (!p.armed) {
      if (demo && activeId) {
        // demo 的 send 不建会话也不落项目：把刚建的本地会话直接归入项目，侧栏与主页才看得到。
        const title = p.text.slice(0, 40);
        setSessions((c) =>
          c.map((x) =>
            x.id === activeId ? { ...x, projectId: p.projectId, title, messageCount: 1 } : x,
          ),
        );
      }
      setPendingProjectStart({ ...p, armed: true });
      return;
    }
    consumedProjectStartRef.current = p.nonce;
    setPendingProjectStart(null);
    void send(p.text);
  }, [pendingProjectStart, activeId, boardOpen, projectHome, draftProjectId, send, demo, setSessions]);

  // 上传单文件 → MediaRef（kind 以服务端 mimeType 为准，退回 file.type）。供 Composer 附件。
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps verbatim from App() (OCV5-472); authRef is App useState setter/useRef passed in, stable
  const uploadMedia = useCallback(async (file: File): Promise<MediaRef> => {
    const r = await api.uploadFile(authRef.current, file);
    const mime = r.mimeType || file.type || "";
    const kind: MediaRef["kind"] = mime.startsWith("image/")
      ? "image"
      : mime.startsWith("audio/")
        ? "audio"
        : mime.startsWith("video/")
          ? "video"
          : "file";
    // 乐观本地渲染:上传时 File 字节在手,建 blob URL 让气泡先渲(消除服务端回显/签名前的裂图
    // 窗口)。仅可预览媒体(image/video/audio)需要;file 走下载卡无预览。localSrc 仅本机 UI:
    // socket.sendMessage 出站帧 + 跨设备持久化 + toStored(IndexedDB)都显式剥离,刷新即回落签名管线。
    const localSrc =
      kind !== "file" ? URL.createObjectURL(file) : undefined;
    return {
      kind,
      url: r.url,
      mimeType: mime || undefined,
      filename: file.name,
      ...(localSrc ? { localSrc } : {}),
    };
  }, []);

  // 统一图片编辑提交 handler（需求 B/§5）：编辑/评论/调整大小三态联合 → 进主对话生成。
  // 复用 send()→乐观 user 行 + 生成占位卡（socket 注入）。持久化天然满足（guide 非 hidden、
  // 结果走 recordExternalTurn）。ImageAnnotationEditor.onSubmit（无 mode 的 ImageAnnotationExport）
  // 天然落 annotated 分支，向后兼容。
  const submitImageEdit = useCallback(
    async (value: ImageEditSubmit) => {
      if (value.mode === "resize") {
        // 调整大小（outpaint）：源图（hidden）+ guide（可见），无 mask；带目标比例 targetAspect。
        const [sourceMedia, guideMedia] = await Promise.all([
          uploadMedia(value.source),
          uploadMedia(value.guide),
        ]);
        const media: MediaRef[] = [{ ...sourceMedia, hidden: true }, guideMedia];
        await send(value.prompt, media, {
          mode: "outpaint",
          targetAspect: value.targetAspect,
          clientJobId: value.clientJobId,
          sourceIndex: 0,
          guideIndex: 1,
          width: value.width,
          height: value.height,
        });
        toast("已提交调整大小，成功生成后扣 50 积分", "success");
        return;
      }
      // 编辑/评论（annotated）：源图 + mask（均 hidden）+ guide 三件套（既有链路，逐字保留）。
      const [sourceMedia, maskMedia, guideMedia] = await Promise.all([
        uploadMedia(value.source),
        uploadMedia(value.mask),
        uploadMedia(value.guide),
      ]);
      const media: MediaRef[] = [
        { ...sourceMedia, hidden: true },
        { ...maskMedia, hidden: true },
        guideMedia,
      ];
      await send(value.prompt, media, {
        mode: "annotated",
        clientJobId: value.clientJobId,
        sourceIndex: 0,
        maskIndex: 1,
        guideIndex: 2,
        width: value.width,
        height: value.height,
      });
      toast("已提交精确修改，成功生成后扣 50 积分", "success");
    },
    [send, toast, uploadMedia],
  );

  // 评论模式提交（ChatGPT 同款「模型驱动精确修改」）：不再合成 mask/guide,而是一条**普通对话
  // 消息** —— media=[原图(可见)] + text=固定前导 + 每锚点百分比坐标行。原图能复用持久
  // /api/media 引用就直接复用(reuseUrl),否则用 ImageCommentMode 取到的字节(sourceFile)上传
  // 一次。由 GPT 看图+坐标调它自己的原生 imagegen 完成精确修改。
  const submitImageComment = useCallback(
    async (value: ImageCommentSubmit) => {
      const ref: MediaRef = value.reuseUrl
        ? { kind: "image", url: value.reuseUrl }
        : await uploadMedia(value.sourceFile as File);
      await send(value.text, [ref]);
      toast("已提交标注修改，模型将按坐标精确修改", "success");
    },
    [send, uploadMedia, toast],
  );

  // 图片编辑可用性(image2 门控):image2 特性开放 + 当前模型是 GPT 引擎时才可编辑。
  // **单一权威**:注入 submitImageEdit / annotate 与否即"可否编辑"的唯一判定,聊天缩略图
  // 「编辑」浮钮、全屏查看器动作、composer 附件编辑按钮全部据此显隐/禁用。
  // 可编辑判定的**确定性**收口(image r4 §5b):publicCfg / modelId 都是刷新后 async 加载,
  // 若「未知即不可编辑」,编辑入口会在加载完成的一瞬从无到有——刷新后「编辑按钮时有时无」
  // 的抖动根因。改为:**加载未知期乐观视为可用**(不闪),仅在**确定**关闭时才收起——
  //   · featureOff  = publicCfg 已到且 featureImage2 !== true(平台维护/未开放)
  //   · modelKnownUnsupported = modelId 已到且非 GPT 引擎模型
  // 真实提交仍受下游 image2 门控兜底;错判窗口仅存在于首帧加载的数百 ms,且只影响罕见的
  // 非 GPT 会话(GPT 会话——商业版绝大多数——从首帧起即稳定显示,消除 boss 复现的闪烁)。
  const image2FeatureOff = publicCfg != null && publicCfg.featureImage2 !== true;
  const modelKnownUnsupported = !!modelId && !isCodexEngineModel(modelId);
  const image2Available = !demo && !image2FeatureOff && !modelKnownUnsupported;
  const image2UnavailableReason = image2Available
    ? undefined
    : image2FeatureOff
      ? "Image 2 暂未开放或正在维护"
      : "当前模型不支持 Image 2 圈选修改，请切换到 GPT 模型";
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps verbatim from App() (OCV5-472); setImageAnnotationSource is App useState setter/useRef passed in, stable
  const imageEditActions = useMemo<ImageEditActions>(
    () => ({
      submitImageEdit: image2Available ? submitImageEdit : undefined,
      submitImageComment: image2Available ? submitImageComment : undefined,
      annotate: image2Available ? setImageAnnotationSource : undefined,
      annotateUnavailableReason: image2UnavailableReason,
    }),
    [image2Available, submitImageEdit, submitImageComment, image2UnavailableReason],
  );

  return {
    image2Available,
    imageEditActions,
    send,
    startInProject,
    submitImageEdit,
    uploadMedia,
  };
}
