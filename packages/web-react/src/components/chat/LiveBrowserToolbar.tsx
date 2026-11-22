/**
 * Clarvy Atelier browser chrome toolbar, tab strip & integrated telemetry ribbon (OCV5-857).
 *
 * Uses CSS Container Queries (`@container lb-shell`) to adapt cleanly across 320–440px sidebars
 * and fullscreen theater mode without squishing the address bar or stacking duplicate headers.
 */
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  Copy,
  CornerDownLeft,
  Globe,
  Hand,
  Lock,
  Maximize2,
  Minimize2,
  Plus,
  Power,
  RotateCw,
  Send,
  ShieldAlert,
  X,
} from "lucide-react";
import { type FormEvent, type RefObject, useEffect, useRef, useState } from "react";
import type { LiveBrowserTabInfo } from "../../lib/liveBrowserApi";
import type {
  LiveBrowserConnectionStatus,
  LiveBrowserStreamStats,
} from "../../lib/liveBrowserStreamClient";
import { Popover, PopoverContent, PopoverTrigger, Spinner } from "../ui";
import type { LiveBrowserZoomMode } from "./LiveBrowserCanvas";

const QUICK_PRESETS = [
  { label: "Google Scholar", url: "https://scholar.google.com" },
  { label: "arXiv", url: "https://arxiv.org" },
  { label: "GitHub", url: "https://github.com" },
] as const;

const QUICK_KEYS = [
  { label: "Enter", key: "Enter" },
  { label: "Tab", key: "Tab" },
  { label: "退格", key: "Backspace" },
  { label: "上翻", key: "PageUp" },
  { label: "下翻", key: "PageDown" },
  { label: "Esc", key: "Escape" },
] as const;

export function LiveBrowserLoadingView() {
  return (
    <div className="lb-root" data-testid="live-browser-loading">
      <div className="lb-idle-surface oc-surface-card">
        <span className="lb-idle-icon oc-icon-badge oc-icon-badge-accent" aria-hidden>
          <Spinner size={18} />
        </span>
        <h3 className="lb-idle-title">云端实时浏览器</h3>
        <p className="lb-idle-desc">正在连接云端浏览器视口…</p>
      </div>
    </div>
  );
}

export function LiveBrowserUnavailableView({
  reason,
  onRetry,
}: {
  reason?: string;
  onRetry: () => void;
}) {
  const customReason = reason && reason !== "unavailable" ? reason : null;
  return (
    <div className="lb-root" data-testid="live-browser-unavailable">
      <div className="lb-idle-surface oc-surface-card" data-tone="warning">
        <span className="lb-idle-icon oc-icon-badge oc-icon-badge-warning" aria-hidden>
          <ShieldAlert size={18} />
        </span>
        <h3 className="lb-idle-title">当前环境未启用云端浏览器</h3>
        <p className="lb-idle-desc">
          {customReason
            ? `${customReason}（系统将自动重试检测，你也可以立即点击重新检测；历史步骤快照仍可在「步骤记录」查看）`
            : "该运行容器暂未挂载实时浏览器引擎，系统将自动退避重试检测；助手的浏览器步骤快照仍可在「步骤记录」中查看。"}
        </p>
        <button
          type="button"
          className="lb-preset-chip oc-btn-tactile oc-btn-secondary-craft"
          data-testid="live-browser-retry-available"
          onClick={onRetry}
        >
          <RotateCw size={12} aria-hidden />
          重新检测
        </button>
      </div>
    </div>
  );
}

export function LiveBrowserErrorBanner({
  error,
  onRetry,
  onDismiss,
}: {
  error: string;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="lb-error-banner oc-callout oc-callout-danger" role="alert" data-testid="live-browser-error">
      <span>{error}</span>
      <div className="lb-error-actions">
        <button
          type="button"
          className="lb-error-retry oc-btn-tactile oc-btn-secondary-craft"
          data-testid="live-browser-error-retry"
          onClick={onRetry}
        >
          立即重试
        </button>
        <button type="button" className="lb-error-close" aria-label="关闭提示" onClick={onDismiss}>
          <X size={13} />
        </button>
      </div>
    </div>
  );
}

export function LiveBrowserIdleView({
  error,
  handoffWaiting,
  launchUrl,
  busy,
  lockedByAssistant,
  onLaunchUrlChange,
  onLaunchSubmit,
  onSelectPreset,
  onRetry,
  onDismissError,
}: {
  error: string | null;
  handoffWaiting: boolean;
  launchUrl: string;
  busy: boolean;
  lockedByAssistant: boolean;
  onLaunchUrlChange: (url: string) => void;
  onLaunchSubmit: (e: FormEvent) => void;
  onSelectPreset: (url: string) => void;
  onRetry: () => void;
  onDismissError: () => void;
}) {
  return (
    <div className="lb-root" data-testid="live-browser-idle">
      {error && <LiveBrowserErrorBanner error={error} onRetry={onRetry} onDismiss={onDismissError} />}
      {handoffWaiting && (
        <div className="lb-handoff-banner oc-callout oc-callout-info" role="status" data-testid="live-browser-handoff-waiting">
          <span className="lb-handoff-body">
            <Spinner size={13} className="shrink-0 text-accent" />
            <span>助手正在操作浏览器，当前步骤完成后将自动为你开启接管…</span>
          </span>
        </div>
      )}
      <div className="lb-idle-surface oc-surface-card">
        <span className="lb-idle-icon oc-icon-badge oc-icon-badge-accent" aria-hidden>
          <Globe size={18} />
        </span>
        <h3 className="lb-idle-title">云端实时浏览器</h3>
        <p className="lb-idle-desc">
          助手操作网页时会自动同步实时画面；你也可以现在启动，直接登录学术库或处理验证，页面状态与助手共享。
        </p>
        <form className="lb-launch-form" onSubmit={onLaunchSubmit}>
          <input
            type="text"
            value={launchUrl}
            disabled={lockedByAssistant}
            onChange={(e) => onLaunchUrlChange(e.target.value)}
            placeholder="输入网址，例如 https://arxiv.org"
            aria-label="启动网址"
            className="lb-launch-input oc-surface-recessed"
            data-testid="live-browser-launch-input"
          />
          <button
            type="submit"
            disabled={busy || lockedByAssistant}
            className="lb-launch-btn oc-btn-tactile oc-btn-primary-craft"
            data-testid="live-browser-launch-btn"
          >
            {busy ? <Spinner size={13} /> : <Globe size={13} />}
            启动
          </button>
        </form>
        <div className="lb-presets" aria-label="快捷入口">
          {QUICK_PRESETS.map((preset) => (
            <button
              key={preset.url}
              type="button"
              disabled={busy || lockedByAssistant}
              className="lb-preset-chip oc-btn-tactile oc-btn-secondary-craft"
              onClick={() => onSelectPreset(preset.url)}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function LiveBrowserTakeoverDock({
  typeDraft,
  busy,
  onTypeDraftChange,
  onSendText,
  onPressQuickKey,
}: {
  typeDraft: string;
  busy: boolean;
  onTypeDraftChange: (v: string) => void;
  onSendText: (submit: boolean) => void;
  onPressQuickKey: (key: string) => void;
}) {
  const composingRef = useRef(false);
  return (
    <div className="lb-takeover-dock" data-testid="live-browser-takeover-dock">
      <form
        className="lb-type-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (composingRef.current) return;
          onSendText(true);
        }}
      >
        <input
          type="text"
          value={typeDraft}
          onChange={(e) => onTypeDraftChange(e.target.value)}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (composingRef.current || e.nativeEvent.isComposing)) {
              e.preventDefault();
            }
          }}
          placeholder="输入文字或验证码发送到页面焦点（也可直接点击画面打字/粘贴）…"
          aria-label="向云端浏览器输入文字"
          className="lb-type-input oc-surface-recessed"
          data-testid="live-browser-type-input"
        />
        <button
          type="button"
          disabled={busy || !typeDraft}
          className="lb-type-btn oc-btn-tactile oc-btn-secondary-craft"
          data-testid="live-browser-type-send"
          onClick={() => onSendText(false)}
        >
          <Send size={12} />
          输入
        </button>
        <button
          type="submit"
          disabled={busy || !typeDraft}
          className="lb-type-btn oc-btn-tactile oc-btn-primary-craft"
          data-primary="true"
          title="输入并按回车"
          aria-label="输入并按回车"
          data-testid="live-browser-type-submit"
        >
          <CornerDownLeft size={12} />
        </button>
      </form>
      <div className="lb-keys-row" aria-label="快捷按键">
        {QUICK_KEYS.map((item) => (
          <button
            key={item.key}
            type="button"
            disabled={busy}
            className="lb-key-chip oc-kbd oc-btn-tactile"
            onClick={() => onPressQuickKey(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export interface LiveBrowserToolbarProps {
  url?: string;
  title?: string;
  loading?: boolean;
  capturedAt?: number;
  tabs: readonly LiveBrowserTabInfo[];
  addressDraft: string;
  onAddressDraftChange: (value: string) => void;
  onAddressEditingChange: (editing: boolean) => void;
  onAddressSubmit: (e: FormEvent) => void;
  effectiveTakeover: boolean;
  takeoverLeaseMode?: "none" | "exclusive" | "compat";
  lockedByAssistant: boolean;
  running: boolean;
  canPauseAndTakeover: boolean;
  canAutoSendContinue: boolean;
  originMismatchLocked: boolean;
  originMismatchDismissed: boolean;
  onReopenOriginMismatch: () => void;
  busy: boolean;
  expanded: boolean;
  expandBtnRef?: RefObject<HTMLButtonElement | null>;
  zoomMode: LiveBrowserZoomMode;
  onToggleZoom: () => void;
  captureFocused: boolean;
  onReleaseCaptureFocus: () => void;
  connectionStatus: LiveBrowserConnectionStatus;
  hasConnectionError: boolean;
  streamStats: LiveBrowserStreamStats;
  onHistory: (action: "back" | "forward" | "reload" | "stop") => void;
  onTabSelect: (tab: LiveBrowserTabInfo) => void;
  onTabClose: (tab: LiveBrowserTabInfo) => void;
  onTabNew: () => void;
  onEnterTakeover: () => void;
  onPauseAndTakeover: () => void;
  onHandBackAndContinue: () => void;
  onHandBackOnly: () => void;
  onToggleExpand: () => void;
  onCloseBrowser: () => void;
  onCopyUrl: () => void;
  onScreenshot: () => void;
}

function formatSyncTime(ts?: number): string {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}

export function LiveBrowserToolbar({
  url,
  title,
  loading = false,
  capturedAt,
  tabs,
  addressDraft,
  onAddressDraftChange,
  onAddressEditingChange,
  onAddressSubmit,
  effectiveTakeover,
  takeoverLeaseMode = "none",
  lockedByAssistant,
  running,
  canPauseAndTakeover,
  canAutoSendContinue,
  originMismatchLocked,
  originMismatchDismissed,
  onReopenOriginMismatch,
  busy,
  expanded,
  expandBtnRef,
  zoomMode,
  onToggleZoom,
  captureFocused,
  onReleaseCaptureFocus,
  connectionStatus,
  hasConnectionError,
  streamStats,
  onHistory,
  onTabSelect,
  onTabClose,
  onTabNew,
  onEnterTakeover,
  onPauseAndTakeover,
  onHandBackAndContinue,
  onHandBackOnly,
  onToggleExpand,
  onCloseBrowser,
  onCopyUrl,
  onScreenshot,
}: LiveBrowserToolbarProps) {
  const [closePopoverOpen, setClosePopoverOpen] = useState(false);
  const [urlCopied, setUrlCopied] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    };
  }, []);

  const isHttps = (url ?? "").startsWith("https://");
  const isReconnecting = connectionStatus === "reconnecting";
  const isReplaced = connectionStatus === "replaced";
  const isDisconnected = isReconnecting || isReplaced || hasConnectionError;

  const dotState = isDisconnected
    ? isReconnecting || isReplaced
      ? "reconnecting"
      : "error"
    : lockedByAssistant
      ? "busy"
      : effectiveTakeover
        ? "takeover"
        : "live";

  const telemetryText = (() => {
    if (isReplaced) return "已被替换";
    if (isReconnecting) return "重连中";
    if (connectionStatus === "connected" && streamStats.mode === "ws") {
      const parts = ["WS"];
      if (streamStats.fps > 0) parts.push(`${streamStats.fps} fps`);
      if (streamStats.rttMs !== null) parts.push(`${streamStats.rttMs}ms`);
      return parts.join(" · ");
    }
    const ts = formatSyncTime(capturedAt);
    return ts ? `轮询 · ${ts}` : "轮询";
  })();

  const handleCopyClick = () => {
    if (!url) return;
    onCopyUrl();
    setUrlCopied(true);
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = window.setTimeout(() => {
      copiedTimerRef.current = null;
      setUrlCopied(false);
    }, 1500);
  };

  return (
    <>
      {/* Unified Clarvy Atelier Browser Chrome */}
      <div className="lb-toolbar" data-expanded={expanded ? "true" : "false"}>
        {expanded && (
          <span className="lb-chrome-dots" aria-hidden>
            <span />
            <span />
            <span />
          </span>
        )}

        <div className="lb-nav-group">
          <button
            type="button"
            className="lb-icon-btn oc-btn-tactile"
            aria-label="后退"
            title={lockedByAssistant ? "助手执行中，暂不可操作" : "后退"}
            disabled={busy || lockedByAssistant}
            onClick={() => onHistory("back")}
          >
            <ArrowLeft size={14} />
          </button>
          <button
            type="button"
            className="lb-icon-btn oc-btn-tactile"
            aria-label="前进"
            title={lockedByAssistant ? "助手执行中，暂不可操作" : "前进"}
            disabled={busy || lockedByAssistant}
            onClick={() => onHistory("forward")}
          >
            <ArrowRight size={14} />
          </button>
          {loading ? (
            <button
              type="button"
              className="lb-icon-btn oc-btn-tactile"
              aria-label="停止加载"
              title={lockedByAssistant ? "助手执行中，暂不可操作" : "停止加载"}
              disabled={lockedByAssistant}
              data-testid="live-browser-stop-btn"
              onClick={() => onHistory("stop")}
            >
              <X size={13} />
            </button>
          ) : (
            <button
              type="button"
              className="lb-icon-btn oc-btn-tactile"
              aria-label="刷新页面"
              title={lockedByAssistant ? "助手执行中，暂不可操作" : "刷新页面"}
              disabled={busy || lockedByAssistant}
              onClick={() => onHistory("reload")}
            >
              <RotateCw size={13} className={busy ? "lb-spin" : undefined} />
            </button>
          )}
        </div>

        <form className="lb-address-form oc-surface-recessed" onSubmit={onAddressSubmit}>
          <span className="lb-address-icon" data-secure={isHttps ? "true" : "false"} aria-hidden>
            {isHttps ? <Lock size={11} /> : <Globe size={11} />}
          </span>
          <input
            type="text"
            value={addressDraft}
            readOnly={lockedByAssistant}
            onFocus={() => {
              if (!lockedByAssistant) onAddressEditingChange(true);
            }}
            onBlur={() => onAddressEditingChange(false)}
            onChange={(e) => onAddressDraftChange(e.target.value)}
            placeholder="输入网址并回车…"
            aria-label="浏览器地址栏"
            className="lb-address-input"
            data-testid="live-browser-address"
          />
          {url && (
            <button
              type="button"
              className="lb-address-copy"
              aria-label="复制当前网址"
              title="复制当前网址"
              data-testid="live-browser-copy-url"
              onClick={handleCopyClick}
            >
              {urlCopied ? <Check size={11} className="text-success" /> : <Copy size={11} />}
            </button>
          )}
        </form>

        <div className="lb-toolbar-actions">
          {effectiveTakeover ? (
            <>
              <button
                type="button"
                className="lb-cta-btn oc-btn-tactile oc-btn-accent-craft"
                data-variant="takeover"
                data-testid="live-browser-handback-btn"
                title={
                  canAutoSendContinue
                    ? "交还控制权并立即通知助手继续当前任务"
                    : "交还控制权并将续跑指令填入输入框"
                }
                onClick={onHandBackAndContinue}
              >
                <Check size={13} />
                {canAutoSendContinue ? "交还并继续" : "交还助手"}
              </button>
              <button
                type="button"
                className="lb-cta-btn lb-cta-secondary oc-btn-tactile oc-btn-secondary-craft"
                data-variant="secondary"
                data-testid="live-browser-handback-only-btn"
                title="仅退出人工接管，不发送对话消息"
                onClick={onHandBackOnly}
              >
                仅交还
              </button>
            </>
          ) : lockedByAssistant && running && canPauseAndTakeover ? (
            <button
              type="button"
              className="lb-cta-btn oc-btn-tactile"
              data-variant="watch"
              title="暂停当前助手回合，并自动进入人工接管"
              data-testid="live-browser-pause-takeover-btn"
              onClick={onPauseAndTakeover}
            >
              <Hand size={13} />
              暂停并接管
            </button>
          ) : (
            <button
              type="button"
              className="lb-cta-btn oc-btn-tactile"
              data-variant="watch"
              disabled={lockedByAssistant || originMismatchLocked}
              title={
                lockedByAssistant
                  ? "助手正在操作浏览器，本轮结束或停止后即可接管"
                  : originMismatchLocked
                    ? "请先核对域名提示并确认后再接管"
                    : "接管云端浏览器"
              }
              data-testid="live-browser-takeover-btn"
              onClick={onEnterTakeover}
            >
              <Hand size={13} />
              {lockedByAssistant ? "助手操作中" : "接管"}
            </button>
          )}

          <div className="lb-util-group">
            {tabs.length <= 1 && (
              <button
                type="button"
                className="lb-icon-btn oc-btn-tactile"
                aria-label="新建标签页"
                title="新建标签页"
                disabled={busy || lockedByAssistant}
                data-testid="live-browser-new-tab-btn"
                onClick={onTabNew}
              >
                <Plus size={13} />
              </button>
            )}
            <button
              type="button"
              className="lb-zoom-btn oc-btn-tactile"
              data-active={zoomMode === "1:1" ? "true" : "false"}
              aria-label={zoomMode === "fit" ? "切换为 1:1 原始比例" : "切换为适应视口"}
              title={zoomMode === "fit" ? "切换为 1:1 原始像素比例" : "切换为自适应缩放"}
              data-testid="live-browser-zoom-btn"
              onClick={onToggleZoom}
            >
              {zoomMode === "1:1" ? "1:1" : "适应"}
            </button>
            <button
              type="button"
              className="lb-icon-btn lb-util-optional oc-btn-tactile"
              aria-label="保存当前画面截图"
              title="保存当前画面截图"
              data-testid="live-browser-screenshot-btn"
              onClick={onScreenshot}
            >
              <Camera size={13} />
            </button>
            <button
              ref={expanded ? undefined : expandBtnRef}
              type="button"
              className="lb-icon-btn oc-btn-tactile"
              aria-label={expanded ? "退出放大视图" : "放大浏览器视图"}
              title={expanded ? "缩小回侧栏 (Esc)" : "放大为沉浸全屏视口"}
              data-testid="live-browser-expand-btn"
              onClick={onToggleExpand}
            >
              {expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            </button>
            <Popover open={closePopoverOpen} onOpenChange={setClosePopoverOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="lb-icon-btn lb-icon-btn-danger oc-btn-tactile"
                  aria-label="关闭云端浏览器"
                  title={lockedByAssistant ? "助手执行中，暂不可关闭" : "关闭云端浏览器"}
                  disabled={busy || lockedByAssistant}
                  data-testid="live-browser-close-btn"
                >
                  <Power size={13} />
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" sideOffset={8} className="w-64 p-3">
                <p className="text-section font-semibold text-fg">关闭云端浏览器？</p>
                <p className="mt-1 text-caption leading-relaxed text-muted">
                  将结束当前云端浏览器进程（已保存的 Cookie 与登录态持久化目录仍会保留）。
                </p>
                <div className="mt-3 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    className="lb-overlay-btn oc-btn-tactile oc-btn-secondary-craft"
                    onClick={() => setClosePopoverOpen(false)}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="lb-overlay-btn lb-overlay-btn-danger oc-btn-tactile"
                    data-testid="live-browser-close-confirm"
                    onClick={() => {
                      setClosePopoverOpen(false);
                      onCloseBrowser();
                    }}
                  >
                    确认关闭
                  </button>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>
      </div>

      {/* Multi-tab strip (rendered when >1 tab; single-tab + button stays in toolbar) */}
      {tabs.length > 1 && (
        <div className="lb-tabs" role="tablist" aria-label="浏览器标签页" data-testid="live-browser-tabs">
          {tabs.map((t) => (
            <div key={t.id ?? t.index} className="lb-tab" data-active={t.active ? "true" : "false"}>
              <button
                type="button"
                role="tab"
                aria-selected={t.active}
                disabled={busy || lockedByAssistant}
                className="lb-tab-select"
                title={t.title || t.url}
                onClick={() => onTabSelect(t)}
              >
                {t.title || t.url || `标签页 ${t.index + 1}`}
              </button>
              <button
                type="button"
                disabled={busy || lockedByAssistant}
                className="lb-tab-close"
                aria-label={`关闭标签页 ${t.title || t.index + 1}`}
                onClick={() => onTabClose(t)}
              >
                <X size={11} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="lb-icon-btn oc-btn-tactile"
            aria-label="新建标签页"
            title="新建标签页"
            disabled={busy || lockedByAssistant}
            data-testid="live-browser-new-tab-btn"
            onClick={onTabNew}
          >
            <Plus size={12} />
          </button>
        </div>
      )}

      {/* Integrated Status & Telemetry Ribbon */}
      <div
        className="lb-status-ribbon"
        data-takeover={effectiveTakeover ? "true" : "false"}
        data-connection={dotState}
        data-testid="live-browser-status"
      >
        <div className="lb-status-left">
          <span
            className="lb-live-dot"
            data-state={dotState}
            data-takeover={effectiveTakeover ? "true" : "false"}
            data-busy={lockedByAssistant ? "true" : "false"}
            aria-hidden
          />
          <span className="lb-status-text">
            {isReplaced
              ? "已在其他标签页接管实时画面 · 可点击画布上方「重新连接」切回本页"
              : isReconnecting
                ? "实时连接已中断，正在自动重连…"
                : lockedByAssistant
                  ? "助手正在操作浏览器 · 实时观看中（本轮结束或停止后可一键接管）"
                  : effectiveTakeover
                    ? (() => {
                        const prefix =
                          takeoverLeaseMode === "exclusive"
                            ? "独占接管中"
                            : takeoverLeaseMode === "compat"
                              ? "兼容接管（无独占锁）"
                              : "已接管";
                        return title
                          ? `${prefix} · ${title}`
                          : `${prefix} · 可直接键鼠操作或粘贴文本，完成后交还助手`;
                      })()
                    : title
                      ? `实时画面 · ${title}`
                      : "实时画面同步中 · 点击画布或「接管」即可操作"}
          </span>
        </div>

        <div className="lb-status-right">
          {originMismatchLocked && originMismatchDismissed && !effectiveTakeover && (
            <button
              type="button"
              className="lb-status-action oc-btn-tactile"
              data-testid="live-browser-reopen-mismatch"
              onClick={onReopenOriginMismatch}
            >
              <ShieldAlert size={11} aria-hidden />
              核对跨域
            </button>
          )}
          {effectiveTakeover && captureFocused && (
            <button
              type="button"
              className="lb-status-kbd-hint lb-status-kbd-btn"
              title="按 Shift+Esc 或点击此处退出键盘捕获"
              onClick={onReleaseCaptureFocus}
            >
              <kbd className="oc-kbd">Shift</kbd>
              <span>+</span>
              <kbd className="oc-kbd">Esc</kbd>
              <span>退出捕获</span>
            </button>
          )}
          {expanded && !captureFocused && (
            <span className="lb-status-kbd-hint">
              <kbd className="oc-kbd">Esc</kbd>
              <span>返回侧栏</span>
            </span>
          )}
          <span
            className="lb-status-meta"
            data-mode={connectionStatus === "connected" ? "ws" : isDisconnected ? "warn" : "polling"}
            data-testid="live-browser-telemetry"
          >
            {telemetryText}
          </span>
        </div>
      </div>
    </>
  );
}
