import { Brain, ChevronRight, Layers, Pencil, Search, Terminal, Users, type LucideIcon } from "lucide-react";
import { Fragment } from "react";
import type { ChatMessage } from "../../lib/chat/model";
import type { StepTiming } from "./ProcessDisclosure";
import { buildPhaseTimeline, type PhaseKind, type PhaseSegment, type PhaseTimelineData } from "./phaseTimeline";
import "./phaseTimeline.css";

const PHASE_ICON: Record<PhaseKind, LucideIcon> = {
  explore: Search,
  edit: Pencil,
  verify: Terminal,
  collab: Users,
  plan: Brain,
};

/**
 * Compact tabular duration formatter for quiet phase telemetry:
 * <100ms -> "<0.1s", <10s -> "1.5s"/"2s", <60s -> "14s",
 * <1h -> "07:05"/"21:34", >=1h -> "1:03:05".
 */
export function formatPhaseDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return "";
  if (ms < 100) return "<0.1s";
  if (ms < 10_000) {
    const sec = (ms / 1000).toFixed(1).replace(/\.0$/, "");
    return `${sec}s`;
  }
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  const mmss = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return hours > 0 ? `${hours}:${mmss}` : mmss;
}

/**
 * Lazy-chunk entrypoint for collapsed ProcessDisclosure: computes the phase timeline
 * inside the async chunk so neither phaseTimeline.ts nor PhaseTimelineSummary enters
 * the first-screen static modulepreload graph.
 */
export function PhaseTimelineStripFromMessages({
  messages,
  stepTimings,
  active,
  selectedPhase = null,
  hideFileMetric = false,
  onSelectPhase,
}: {
  messages: readonly ChatMessage[];
  stepTimings: ReadonlyMap<string, StepTiming>;
  active: boolean;
  selectedPhase?: PhaseKind | null;
  hideFileMetric?: boolean;
  onSelectPhase?: (kind: PhaseKind) => void;
}) {
  const timeline = buildPhaseTimeline(messages, { stepTimings, active });
  return (
    <PhaseTimelineStrip
      timeline={timeline}
      selectedPhase={selectedPhase}
      hideFileMetric={hideFileMetric}
      onSelectPhase={onSelectPhase}
    />
  );
}

/**
 * Compact horizontal phase capsule trail shown beneath the collapsed ProcessDisclosure header
 * for multi-phase or long turns. Clicking a phase capsule opens the timeline filtered to that phase.
 */
export function PhaseTimelineStrip({
  timeline,
  selectedPhase = null,
  hideFileMetric = false,
  onSelectPhase,
}: {
  timeline: PhaseTimelineData;
  selectedPhase?: PhaseKind | null;
  hideFileMetric?: boolean;
  onSelectPhase?: (kind: PhaseKind) => void;
}) {
  if (!timeline.showCompactBar) return null;

  const substantive = timeline.phases.filter((phase) => phase.kind !== "plan");
  const visiblePhases = substantive.length > 0 ? substantive : timeline.phases;

  return (
    <div
      role="region"
      aria-label="执行阶段概览"
      data-testid="phase-timeline-strip"
      className="oc-phase-strip"
    >
      {visiblePhases.map((phase, index) => {
        const Icon = PHASE_ICON[phase.kind];
        const duration = formatPhaseDuration(phase.durationMs);
        const pressed = selectedPhase === phase.kind;
        const ariaLabel = duration
          ? `查看${phase.label}阶段（${phase.stepCount} 项，用时 ${duration}）`
          : `查看${phase.label}阶段（${phase.stepCount} 项）`;
        return (
          <Fragment key={phase.kind}>
            {index > 0 ? <ChevronRight size={11} aria-hidden className="oc-phase-connector" /> : null}
            <button
              type="button"
              data-testid={`phase-pill-${phase.kind}`}
              data-phase-kind={phase.kind}
              data-phase-active={phase.active ? "true" : "false"}
              aria-pressed={pressed}
              aria-label={ariaLabel}
              title={duration ? `${phase.label} · ${duration}` : phase.label}
              onClick={() => onSelectPhase?.(phase.kind)}
              className="oc-phase-crumb"
            >
              {phase.active ? (
                <span
                  aria-hidden
                  data-testid={`phase-active-dot-${phase.kind}`}
                  className="oc-phase-active-dot"
                />
              ) : null}
              <Icon size={11} strokeWidth={2} aria-hidden className="oc-phase-pill-icon" />
              <span>{phase.shortLabel}</span>
              <span className="oc-phase-pill-count">{phase.stepCount}</span>
              {duration ? <span className="oc-phase-pill-duration">{duration}</span> : null}
            </button>
          </Fragment>
        );
      })}
      {!hideFileMetric && timeline.metrics.changedFileCount > 0 ? (
        <span data-testid="phase-metric-files" className="oc-phase-metric">
          改 {timeline.metrics.changedFileCount} 文件
        </span>
      ) : null}
    </div>
  );
}

/**
 * Interactive phase filter bar and one-line summary shown at the top of an expanded
 * ProcessDisclosure when a turn spans multiple semantic phases.
 */
export function PhaseTimelineFilterBar({
  timeline,
  selectedPhase,
  onSelectPhase,
}: {
  timeline: PhaseTimelineData;
  selectedPhase: PhaseKind | null;
  onSelectPhase: (kind: PhaseKind | null) => void;
}) {
  if (!timeline.showFilterBar) return null;

  return (
    <div data-testid="phase-filter-bar" className="oc-phase-filter-bar">
      <span data-testid="phase-summary-text" className="sr-only">
        {timeline.summaryText}
      </span>
      <div role="group" aria-label="按阶段筛选步骤" className="oc-phase-filter-pills">
        <button
          type="button"
          data-testid="phase-filter-all"
          aria-pressed={selectedPhase === null}
          onClick={() => onSelectPhase(null)}
          className="oc-phase-pill"
        >
          <Layers size={11} strokeWidth={2} aria-hidden className="oc-phase-pill-icon" />
          <span>全部</span>
          <span className="oc-phase-pill-count">{timeline.totalSteps}</span>
        </button>
        {timeline.phases.map((phase) => {
          const Icon = PHASE_ICON[phase.kind];
          const pressed = selectedPhase === phase.kind;
          const duration = formatPhaseDuration(phase.durationMs);
          return (
            <button
              key={phase.kind}
              type="button"
              data-testid={`phase-filter-${phase.kind}`}
              data-phase-kind={phase.kind}
              data-phase-active={phase.active ? "true" : "false"}
              aria-pressed={pressed}
              aria-label={`筛选${phase.label}（${phase.stepCount} 项）`}
              onClick={() => onSelectPhase(pressed ? null : phase.kind)}
              className="oc-phase-pill"
            >
              {phase.active ? (
                <span
                  aria-hidden
                  data-testid={`phase-active-dot-${phase.kind}`}
                  className="oc-phase-active-dot"
                />
              ) : null}
              <Icon size={11} strokeWidth={2} aria-hidden className="oc-phase-pill-icon" />
              <span>{phase.shortLabel}</span>
              <span className="oc-phase-pill-count">{phase.stepCount}</span>
              {duration ? <span className="oc-phase-pill-duration">{duration}</span> : null}
            </button>
          );
        })}
      </div>
      {selectedPhase !== null ? (
        <button
          type="button"
          data-testid="phase-filter-reset"
          onClick={() => onSelectPhase(null)}
          className="oc-phase-reset"
        >
          显示全部
        </button>
      ) : null}
    </div>
  );
}

/**
 * Compact header rendered above filtered phase steps so the user stays oriented.
 */
export function PhaseGroupHeader({
  phase,
}: {
  phase: PhaseSegment;
}) {
  const Icon = PHASE_ICON[phase.kind];
  const duration = formatPhaseDuration(phase.durationMs);
  return (
    <div data-testid="phase-group-header" data-phase-kind={phase.kind} className="oc-phase-group-head">
      <span className="oc-icon-badge oc-icon-badge-accent flex size-5 shrink-0 items-center justify-center rounded-sm">
        <Icon size={11} strokeWidth={1.85} aria-hidden />
      </span>
      <span className="font-semibold text-fg">{phase.label}</span>
      <span className="tabular-nums text-faint">· {phase.stepCount} 项</span>
      {phase.changedFileCount > 0 ? (
        <span className="tabular-nums text-faint">· 改动 {phase.changedFileCount} 个文件</span>
      ) : null}
      {duration ? <span className="ml-auto font-mono tabular-nums text-faint">{duration}</span> : null}
    </div>
  );
}
