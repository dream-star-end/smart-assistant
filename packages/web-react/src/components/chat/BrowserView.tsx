/**
 * 详情面板「浏览器」页(OCV5-374,懒加载):这一轮里助手用浏览器做了什么。
 *
 * 上面是一扇浏览器窗口:地址、标题、选中那一步的截图(运行中自动跟最新一步);
 * 下面是操作记录,每步一行(动作、页面、缩略图),点一行换上面的截图,「详情」进步骤页看完整输入输出。
 * 数据全部来自 browserSteps.collectBrowserSteps;不新增请求,截图走现有的签名媒体通道。
 */
import { ArrowDownToLine, ChevronRight, Globe, ImageOff } from "lucide-react";
import { Suspense, lazy, useEffect, useState } from "react";
import type { AuthSession } from "../../lib/types";
import { cn } from "../../lib/utils";
import { ActionTrail, AddressBar, PlainSignedImg, ShotThumb } from "../tool/BrowserStepCard";
import { type BrowserTurnStep, collectBrowserSteps, displayAddress } from "../tool/browserSteps";
import type { ToolLike } from "../tool/format";
import { Spinner, StatusPill } from "../ui";
import type { LiveBrowserHandoffRequest } from "./inspectorState";
import { SignedImg } from "./media";
import { TurnBar } from "./OutputsView";
import type { WorkTurn } from "./workTurns";
import "./liveBrowser.css";

const LiveBrowserStage = lazy(() =>
  import("./LiveBrowserStage").then((m) => ({ default: m.LiveBrowserStage })),
);

function idOf(m: { id?: string }): string {
  return typeof m.id === "string" ? m.id : "";
}

/** 默认看哪一步:点进来指定的那步;否则最后一张有截图的步,没有截图就最后一步。 */
function defaultIndex(steps: readonly BrowserTurnStep[], focusId: string | null): number {
  if (focusId) {
    const i = steps.findIndex((s) => idOf(s.message) === focusId);
    if (i >= 0) return i;
  }
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i]?.step;
    if (s && (s.shots.length > 0 || s.requestedShots.length > 0)) return i;
  }
  return steps.length - 1;
}

/** 选中那一步时页面停在哪:这一步自己没有地址就往前找最近一次。 */
function pageAt(steps: readonly BrowserTurnStep[], index: number): { url: string; title: string } {
  for (let i = index; i >= 0; i--) {
    const s = steps[i]?.step;
    if (s?.url) return { url: s.url, title: s.title };
  }
  return { url: "", title: "" };
}

function Window({ item, steps, index }: { item: BrowserTurnStep; steps: readonly BrowserTurnStep[]; index: number }) {
  const { step } = item;
  const shots = step.shots.length > 0 ? step.shots : step.requestedShots;
  const [picked, setPicked] = useState(shots.length - 1);
  const shot = shots[Math.max(0, Math.min(picked, shots.length - 1))] ?? null;
  const page = pageAt(steps, index);
  const title = step.title || page.title;
  return (
    <div className="oc-surface-card mx-4 overflow-hidden rounded-lg" data-testid="browser-window">
      <div className="lb-window-chrome">
        <span aria-hidden className="lb-chrome-dots">
          <span />
          <span />
          <span />
        </span>
        {page.url ? (
          <AddressBar url={page.url} className="flex-1" />
        ) : (
          <span className="oc-surface-recessed flex-1 truncate rounded-full px-3 py-1.5 text-caption text-faint">
            还没有打开网页
          </span>
        )}
      </div>
      {title && (
        <p
          className="truncate border-b border-border/60 bg-surface px-4 py-2 text-meta font-medium text-fg"
          title={title}
          data-testid="browser-window-title"
        >
          {title}
        </p>
      )}
      {shot ? (
        <div className="lb-window-stage-well" data-testid="browser-window-shot">
          <div className="overflow-hidden rounded-xs border border-border/70 bg-surface shadow-soft">
            <SignedImg src={shot} alt={title ? `${title} 截图` : "页面截图"} className="block max-h-[62vh] w-auto max-w-full object-contain" />
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2.5 bg-bg/40 px-6 py-10 text-center text-meta text-muted" data-testid="browser-window-noshot">
          <span
            aria-hidden
            className={cn(
              "oc-icon-badge size-10 rounded-md",
              step.error ? "oc-icon-badge-danger" : step.running ? "oc-icon-badge-accent" : undefined,
            )}
          >
            {step.running ? <Spinner size={16} /> : <ImageOff size={17} />}
          </span>
          <span>{step.running ? "正在操作浏览器…" : step.error ? "这一步没有成功，没有截图。" : "这一步没有截图。"}</span>
        </div>
      )}
      {shots.length > 1 && (
        <div className="border-t border-border/70 bg-bg/60 px-3 py-2">
          <fieldset className="m-0 flex min-w-0 gap-1.5 overflow-x-auto border-0 p-0">
            <legend className="sr-only">这一步的截图</legend>
            {shots.map((s, i) => (
              <ShotThumb key={s} src={s} n={i + 1} active={s === shot} onPick={() => setPicked(i)} />
            ))}
          </fieldset>
        </div>
      )}
      <div className="border-t border-border/70 bg-surface px-4 py-2.5">
        <ActionTrail step={step} />
        {step.error && <p className="mt-1.5 break-words text-meta text-danger">{step.error.slice(0, 240)}</p>}
      </div>
    </div>
  );
}

function LogRow({
  item,
  n,
  active,
  onPick,
  onOpenStep,
}: {
  item: BrowserTurnStep;
  n: number;
  active: boolean;
  onPick: () => void;
  onOpenStep: () => void;
}) {
  const { step } = item;
  const thumb = step.shots.at(-1) ?? step.requestedShots.at(-1) ?? null;
  const where = step.url ? displayAddress(step.url) : null;
  const badgeState = step.error ? "error" : active ? "active" : "idle";
  return (
    <li
      className={cn(
        "group relative flex items-center gap-3 rounded-md border px-2.5 py-2 transition-all",
        active
          ? "oc-surface-card border-accent/35 bg-accent-soft/40"
          : "border-transparent hover:border-border/70 hover:bg-hover/70",
      )}
      data-testid="browser-log-row"
      aria-current={active || undefined}
    >
      <button
        type="button"
        onClick={onPick}
        className="flex min-w-0 flex-1 items-center gap-3 text-left outline-none after:absolute after:inset-0 after:rounded-md focus-visible:after:ring-2 focus-visible:after:ring-ring"
      >
        <span aria-hidden className="lb-step-badge" data-state={badgeState}>
          {n}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-meta font-medium text-fg">
            {step.actions.map((a) => a.label).join(" → ") || "浏览器操作"}
          </span>
          {where && (
            <span className="block truncate font-mono text-caption text-faint">
              {where.host}
              {where.path}
            </span>
          )}
        </span>
        {thumb && (
          <span className="h-9 w-14 shrink-0 overflow-hidden rounded-xs border border-border/80 bg-surface shadow-soft">
            <PlainSignedImg src={thumb} className="h-full w-full object-cover object-top" />
          </span>
        )}
      </button>
      <button
        type="button"
        onClick={onOpenStep}
        aria-label={`第 ${n} 步的详情`}
        title="查看这一步的完整输入输出"
        className="oc-btn-tactile relative z-10 shrink-0 rounded-xs p-1 text-faint opacity-0 outline-none transition-opacity hover:bg-hover hover:text-fg focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 [@media(hover:none)]:opacity-100"
      >
        <ChevronRight size={14} aria-hidden />
      </button>
    </li>
  );
}

function TurnBrowser({
  turn,
  index,
  total,
  running,
  focusId,
  onSelectTurn,
  onOpenStep,
}: {
  turn: WorkTurn;
  index: number;
  total: number;
  running: boolean;
  focusId: string | null;
  onSelectTurn: (index: number) => void;
  onOpenStep: (message: ToolLike) => void;
}) {
  const steps = collectBrowserSteps(turn.steps);
  // null = 跟默认(运行中就是跟着最新一步走);点过某一行后停在那一行。
  const [pickedId, setPickedId] = useState<string | null>(focusId);
  const pickedIndex = pickedId ? steps.findIndex((s) => idOf(s.message) === pickedId) : -1;
  const current = pickedIndex >= 0 ? pickedIndex : defaultIndex(steps, null);
  const item = steps[current];
  const latestIdx = defaultIndex(steps, null);
  const viewingHistory = steps.length > 1 && pickedIndex >= 0 && current !== latestIdx;
  const isLive = running || Boolean(item?.step.running);

  return (
    <>
      <TurnBar
        turn={turn}
        index={index}
        total={total}
        running={running}
        fileCount={0}
        onPrev={() => onSelectTurn(index - 1)}
        onNext={() => onSelectTurn(index + 1)}
      />
      {item ? (
        <>
          <div
            className={cn(
              "oc-callout mx-4 mb-3 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-md px-3.5 py-2 text-caption text-muted",
              isLive && !viewingHistory
                ? "oc-callout-info"
                : viewingHistory
                  ? "oc-callout-warning"
                  : "oc-callout-success",
            )}
            data-testid="browser-status-banner"
          >
            {isLive && !viewingHistory ? (
              <>
                <StatusPill variant="pill" tone="running" mark="ring" label="实时快照跟随中" className="text-caption font-medium text-fg" />
                <span className="min-w-0 flex-1">
                  助手正在操作浏览器，截图随新步骤自动更新；点击下方记录可回看历史快照。
                </span>
              </>
            ) : viewingHistory ? (
              <>
                <StatusPill variant="pill" tone="attention" label={`历史快照 · 第 ${current + 1} / ${steps.length} 步`} className="text-caption font-medium text-fg" />
                <span className="min-w-0 flex-1">当前为只读快照回放，点击右侧可恢复最新画面。</span>
                <button
                  type="button"
                  onClick={() => setPickedId(null)}
                  data-testid="browser-back-latest"
                  className="oc-btn-tactile oc-btn-secondary-craft inline-flex min-h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-caption font-medium text-accent outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11"
                >
                  <ArrowDownToLine size={12} aria-hidden />
                  回到最新
                </button>
              </>
            ) : (
              <>
                <StatusPill variant="pill" tone="done" label="会话快照回放" className="text-caption font-medium text-fg" />
                <span className="min-w-0 flex-1">
                  展示本轮浏览器最新页面快照（只读回放）；点击下方记录切换步骤，或点击地址栏打开页面。
                </span>
              </>
            )}
          </div>
          {/* key:换一步时缩略图选择从头来。 */}
          <Window key={idOf(item.message) || current} item={item} steps={steps} index={current} />
          <section className="px-4 pt-5 pb-6" data-testid="browser-log">
            <h3 className="mb-2.5 flex items-center gap-2 text-caption font-semibold uppercase tracking-wide text-muted">
              <span aria-hidden className="oc-icon-badge size-5 rounded-xs">
                <Globe size={11} />
              </span>
              操作记录
              <span className="lb-seg-count">{steps.length}</span>
            </h3>
            <ol className="-mx-2 space-y-1">
              {steps.map((s, i) => (
                <LogRow
                  key={idOf(s.message) || i}
                  item={s}
                  n={i + 1}
                  active={i === current}
                  onPick={() => setPickedId(idOf(s.message) || null)}
                  onOpenStep={() => onOpenStep(s.message)}
                />
              ))}
            </ol>
          </section>
        </>
      ) : (
        <div className="oc-surface-card mx-4 my-4 flex flex-col items-center gap-2.5 rounded-lg px-8 py-12 text-center" data-testid="browser-empty">
          <span aria-hidden className="oc-icon-badge size-10 rounded-md">
            <Globe size={18} />
          </span>
          <p className="text-meta text-muted">这一轮没有用到浏览器。</p>
        </div>
      )}
    </>
  );
}

export function BrowserView({
  turns,
  index,
  running,
  liveRunning,
  focusId,
  onSelectTurn,
  onOpenStep,
  liveBrowserAgentId,
  liveBrowserAuth,
  liveHandoff,
  onHandoffSettled,
  onAnnotateToComposer,
}: {
  turns: readonly WorkTurn[];
  index: number;
  running: boolean;
  /** 当前是否有正在执行中的浏览器工具步，用于实时浏览器接管仲裁。 */
  liveRunning?: boolean;
  /** 从卡片点进来时要看的那一步(消息 id)。 */
  focusId: string | null;
  onSelectTurn: (index: number) => void;
  onOpenStep: (message: ToolLike) => void;
  /** 可选：启用云端实时浏览器视口与人工接管（OCV5-813）。 */
  liveBrowserAgentId?: string;
  liveBrowserAuth?: AuthSession | null;
  /** 可选：来自对话区 `browser_handoff` 卡片的一键接管/放大意图。 */
  liveHandoff?: (LiveBrowserHandoffRequest & { nonce: number }) | null;
  /** Handoff 被消费后通知上层记录已处理 nonce，防止切换模式重挂时重复触发。 */
  onHandoffSettled?: (nonce: number) => void;
  onAnnotateToComposer?: (draft: string) => void;
}) {
  const turn = turns[index];
  const stepCount = turn ? collectBrowserSteps(turn.steps).length : 0;
  const liveEnabled = Boolean(liveBrowserAgentId && liveBrowserAuth);
  const [mode, setMode] = useState<"live" | "steps">(() =>
    liveEnabled && (Boolean(liveHandoff) || !focusId || stepCount === 0) ? "live" : "steps",
  );
  const [liveActive, setLiveActive] = useState(false);

  // 从具体浏览器步骤卡片点进来时自动切到「步骤记录」定位那一步。
  useEffect(() => {
    if (focusId && stepCount > 0) setMode("steps");
  }, [focusId, stepCount]);

  // 从 `browser_handoff` 卡片一键接管时，强制切回「实时视口」。
  useEffect(() => {
    if (liveEnabled && liveHandoff) setMode("live");
  }, [liveEnabled, liveHandoff?.nonce]);

  if (!turn && !liveEnabled) return null;
  const effectiveMode: "live" | "steps" = !liveEnabled ? "steps" : stepCount === 0 ? "live" : mode;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="browser-view">
      {liveEnabled && stepCount > 0 && (
        <div className="lb-mode-bar" data-testid="browser-mode-switcher">
          <div className="lb-segmented oc-surface-recessed" role="tablist" aria-label="浏览器视图模式">
            <button
              type="button"
              role="tab"
              aria-selected={effectiveMode === "live"}
              data-active={effectiveMode === "live" ? "true" : "false"}
              className="lb-seg-btn oc-btn-tactile"
              data-testid="browser-mode-live"
              onClick={() => setMode("live")}
            >
              {liveActive && <span className="lb-live-dot" aria-hidden />}
              实时视口
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={effectiveMode === "steps"}
              data-active={effectiveMode === "steps" ? "true" : "false"}
              className="lb-seg-btn oc-btn-tactile"
              data-testid="browser-mode-steps"
              onClick={() => setMode("steps")}
            >
              步骤记录
              <span className="lb-seg-count">{stepCount}</span>
            </button>
          </div>
        </div>
      )}

      {effectiveMode === "live" && liveBrowserAgentId && liveBrowserAuth ? (
        <Suspense
          fallback={
            <div className="lb-root">
              <div className="oc-surface-card flex items-center justify-center gap-2.5 rounded-lg px-4 py-8 text-meta text-muted">
                <span aria-hidden className="oc-icon-badge oc-icon-badge-accent size-8 rounded-md">
                  <Spinner size={14} />
                </span>
                正在加载实时浏览器…
              </div>
            </div>
          }
        >
          <LiveBrowserStage
            agentId={liveBrowserAgentId}
            auth={liveBrowserAuth}
            running={liveRunning ?? running}
            handoffRequest={liveHandoff}
            onHandoffSettled={onHandoffSettled}
            onHandBackToComposer={onAnnotateToComposer}
            onActiveStateChange={setLiveActive}
          />
        </Suspense>
      ) : turn ? (
        /* key:换轮 / 换入口时选中重置。 */
        <TurnBrowser
          key={`${turn.key}:${focusId ?? ""}`}
          turn={turn}
          index={index}
          total={turns.length}
          running={running}
          focusId={focusId}
          onSelectTurn={onSelectTurn}
          onOpenStep={onOpenStep}
        />
      ) : null}
    </div>
  );
}
