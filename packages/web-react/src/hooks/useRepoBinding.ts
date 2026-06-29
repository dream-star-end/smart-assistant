import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { RepoBindErrorWire, RepoStatusWire } from "../lib/chat/frames";
import {
  estimateCloningProgress,
  githubErrorText,
  shouldDropFrame,
  VERSION_SENTINEL_CLEARED,
} from "../lib/github";
import type { AuthSession, RepoSelection, RepoStatus } from "../lib/types";
import type { ToastTone } from "../components/ui";

/**
 * GitHub 仓库绑定的状态归属（v5 React 版的 v3 github.js）。单一权威：当前活动会话的
 * selection + 克隆进度 + 版本门控。
 *
 * 数据流：切会话 / boot 用 GET 权威化 selection + selection_version；confirm 走 PUT →
 * socket.sendRepoBind；unbind 走 DELETE → socket.sendRepoUnbind + 版本哨兵；容器经 WS 推
 * outbound.control.session_repo_status（pending→cloning→ready/failed）由 onRepoStatus 消费，
 * bridge 校验失败推 session_repo_bind_error 由 onRepoBindError 消费。两个帧处理器都做版本门控
 * （shouldDropFrame，防 stale 回滚）且**只在帧属于当前活动会话时**才动 UI。
 *
 * onRepoStatus / onRepoBindError 是稳定引用，供 App 透传进 useChatSocket（经 ref 间接）。
 */
export function useRepoBinding(opts: {
  auth: AuthSession | null;
  activeId: string | undefined;
  /** 当前会话 agent（绑定帧的 agentId，用于 bridge/容器 peer 路由）。*/
  agentId: string;
  enabled: boolean;
  sendRepoBind: (sessId: string, agentId: string, version: number) => void;
  sendRepoUnbind: (sessId: string, version: number) => void;
  toast: (message: string, tone?: ToastTone) => void;
}) {
  const { auth, activeId, agentId, enabled, sendRepoBind, sendRepoUnbind, toast } = opts;

  const [selection, setSelection] = useState<RepoSelection | null>(null);
  const [progressPct, setProgressPct] = useState(0);
  const [bannerDismissed, setBannerDismissed] = useState(false);

  // 永远读最新值的 ref（帧处理器是稳定引用，不能依赖 state 闭包）。
  const authRef = useRef(auth);
  authRef.current = auth;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const agentIdRef = useRef(agentId);
  agentIdRef.current = agentId;
  const selectionRef = useRef<RepoSelection | null>(selection);
  selectionRef.current = selection;

  // 版本门控：sessId → 已知 selection_version（或 +Infinity 哨兵=已清空）。
  const knownVersionRef = useRef<Map<string, number>>(new Map());
  // 克隆进度计时器 + 起始时刻。
  const cloneStartRef = useRef<number | null>(null);
  const progressTimerRef = useRef<number | null>(null);
  const readyHideRef = useRef<number | null>(null);

  const stopProgressTimer = useCallback(() => {
    if (progressTimerRef.current != null) {
      window.clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }
    cloneStartRef.current = null;
  }, []);

  const startProgressTimer = useCallback(() => {
    if (progressTimerRef.current != null) return; // 已在跑：保留累计 elapsed
    if (cloneStartRef.current == null) cloneStartRef.current = Date.now();
    const tick = () => {
      const start = cloneStartRef.current;
      if (start == null) return;
      setProgressPct(estimateCloningProgress(start, Date.now()));
    };
    tick();
    progressTimerRef.current = window.setInterval(tick, 200);
  }, []);

  const clearReadyHide = useCallback(() => {
    if (readyHideRef.current != null) {
      window.clearTimeout(readyHideRef.current);
      readyHideRef.current = null;
    }
  }, []);

  const scheduleBannerHide = useCallback(() => {
    clearReadyHide();
    readyHideRef.current = window.setTimeout(() => setBannerDismissed(true), 3000);
  }, [clearReadyHide]);

  // 切会话 / boot：GET 权威化当前会话 selection + 版本。
  useEffect(() => {
    stopProgressTimer();
    clearReadyHide();
    setProgressPct(0);
    setBannerDismissed(false);
    if (!enabled || !auth || !activeId) {
      setSelection(null);
      return;
    }
    let alive = true;
    api
      .getRepoSelection(auth, activeId)
      .then((sel) => {
        if (!alive) return;
        if (sel.selected) {
          knownVersionRef.current.set(activeId, sel.selection_version);
          // 初次/切回已是 ready：不显示"已就绪" banner（对齐 v3 suppressReadyShow）。
          if (sel.status === "ready") setBannerDismissed(true);
          if (sel.status === "cloning") startProgressTimer();
        } else {
          knownVersionRef.current.set(activeId, VERSION_SENTINEL_CLEARED);
        }
        setSelection(sel);
      })
      .catch(() => {
        // 401/404 等都视为未绑定，不打扰用户。
        if (alive) setSelection({ selected: false });
      });
    return () => {
      alive = false;
    };
  }, [enabled, auth, activeId, startProgressTimer, stopProgressTimer, clearReadyHide]);

  // 卸载清计时器。
  useEffect(() => () => {
    stopProgressTimer();
    clearReadyHide();
  }, [stopProgressTimer, clearReadyHide]);

  const refresh = useCallback(() => {
    const a = authRef.current;
    const sid = activeIdRef.current;
    if (!a || !sid) return;
    api
      .getRepoSelection(a, sid)
      .then((sel) => {
        if (sid !== activeIdRef.current) return; // 期间切了会话，丢弃
        if (sel.selected) {
          knownVersionRef.current.set(sid, sel.selection_version);
          // 权威态非 cloning（如解绑后/ready）→ 停进度计时器，防泄漏（cloning 中解绑账号的边角）。
          if (sel.status === "cloning") startProgressTimer();
          else stopProgressTimer();
        } else {
          knownVersionRef.current.set(sid, VERSION_SENTINEL_CLEARED);
          stopProgressTimer();
          clearReadyHide();
          setProgressPct(0);
        }
        setSelection(sel);
      })
      .catch(() => {});
  }, [startProgressTimer, stopProgressTimer, clearReadyHide]);

  const confirm = useCallback(
    async (owner: string, repo: string, branch: string) => {
      const a = authRef.current;
      const sid = activeIdRef.current;
      if (!a || !sid) return;
      const res = await api.putRepoSelection(a, sid, { owner, repo, branch });
      if (!res.selected) throw new Error("后端响应格式异常");
      // PUT 成功 = 后端权威新版本，覆盖任何哨兵（unbind→rebind 同 tab）。
      knownVersionRef.current.set(sid, res.selection_version);
      stopProgressTimer();
      clearReadyHide();
      setProgressPct(0);
      setBannerDismissed(false);
      setSelection(res); // 立即本地 pending（不等 status 帧）
      sendRepoBind(sid, agentIdRef.current, res.selection_version);
    },
    [sendRepoBind, stopProgressTimer, clearReadyHide],
  );

  const unbind = useCallback(async () => {
    const a = authRef.current;
    const sid = activeIdRef.current;
    if (!a || !sid) return;
    const sel = selectionRef.current;
    const ver = sel?.selected ? sel.selection_version : 0;
    await api.deleteRepoSelection(a, sid);
    // DELETE 不返新版本 → 哨兵封顶，丢弃任何迟到的旧 status/error 帧。
    knownVersionRef.current.set(sid, VERSION_SENTINEL_CLEARED);
    sendRepoUnbind(sid, ver);
    stopProgressTimer();
    clearReadyHide();
    setProgressPct(0);
    setSelection({ selected: false });
  }, [sendRepoUnbind, stopProgressTimer, clearReadyHide]);

  const dismissBanner = useCallback(() => setBannerDismissed(true), []);

  // ── WS 帧消费（稳定引用，供 App 透传进 useChatSocket）──
  const onRepoStatus = useCallback(
    (frame: RepoStatusWire) => {
      const sid = frame.sessionId;
      if (!sid) return;
      const ver = typeof frame.selectionVersion === "number" ? frame.selectionVersion : -1;
      const known = knownVersionRef.current.get(sid) ?? -1;
      if (shouldDropFrame(known, ver)) return; // stale 回滚防护
      if (ver > known) knownVersionRef.current.set(sid, ver);
      if (sid !== activeIdRef.current) return; // 仅当前活动会话动 UI
      const status = frame.status as RepoStatus;
      setSelection((prev) => {
        const base = prev?.selected ? prev : null;
        return {
          selected: true,
          owner: frame.owner || base?.owner || "",
          repo: frame.repo || base?.repo || "",
          branch: frame.branch || base?.branch || "",
          default_branch: base?.default_branch,
          status,
          head_sha: frame.headSha || base?.head_sha,
          selection_version: ver >= 0 ? ver : (base?.selection_version ?? 0),
        };
      });
      setBannerDismissed(false);
      if (status === "cloning") {
        startProgressTimer();
      } else {
        stopProgressTimer();
      }
      if (status === "ready") {
        setProgressPct(100);
        scheduleBannerHide();
      } else if (status === "failed") {
        setProgressPct(0);
        toast(githubErrorText(frame.errorCode), "error");
      }
    },
    [startProgressTimer, stopProgressTimer, scheduleBannerHide, toast],
  );

  const onRepoBindError = useCallback(
    (frame: RepoBindErrorWire) => {
      const sid = frame.sessionId;
      if (!sid) return;
      const ver = typeof frame.selectionVersion === "number" ? frame.selectionVersion : -1;
      const known = knownVersionRef.current.get(sid) ?? -1;
      if (shouldDropFrame(known, ver)) return;
      // 失败 → 清 UI + 哨兵（防同版本迟到 status 复活已清状态，对齐 v3）。
      knownVersionRef.current.set(sid, VERSION_SENTINEL_CLEARED);
      if (sid !== activeIdRef.current) return;
      toast(githubErrorText(frame.errorCode), "error");
      stopProgressTimer();
      clearReadyHide();
      setProgressPct(0);
      setSelection({ selected: false });
    },
    [stopProgressTimer, clearReadyHide, toast],
  );

  // banner 可见性：未绑不显；已绑且未被收起且状态非空时显（ready 由 3s 定时收起）。
  const showBanner =
    !!selection && selection.selected && !bannerDismissed && selection.status != null;

  return {
    selection,
    progressPct,
    showBanner,
    confirm,
    unbind,
    refresh,
    dismissBanner,
    onRepoStatus,
    onRepoBindError,
  };
}
