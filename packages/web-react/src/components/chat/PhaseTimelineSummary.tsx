import { Brain, ChevronRight, Layers, Pencil, Search, Terminal, Users, type LucideIcon } from "lucide-react";
import { Fragment } from "react";
import type { ChatMessage } from "../../lib/chat/model";
import { formatStepDuration, type StepTiming } from "./ProcessDisclosure";
import { buildPhaseTimeline, type PhaseKind, type PhaseSegment, type PhaseTimelineData } from "./phaseTimeline";
import "./phaseTimeline.css";

const PHASE_ICON: Record<PhaseKind, LucideIcon> = {
  explore: Search,
  edit: Pencil,
  verify: Terminal,
  collab: Users,
  plan: Brain,
};

function formatPhaseDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return "";
  return formatStepDuration(ms);
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
  onSelectPhase,
}: {
  messages: readonly ChatMessage[];
  stepTimings: ReadonlyMap<string, StepTiming>;
  active: boolean;
  selectedPhase?: PhaseKind | null;
  onSelectPhase?: (kind: PhaseKind) => void;
}) {
  const timeline = buildPhaseTimeline(messages, { stepTimings, active });
  return <PhaseTimelineStrip timeline={timeline} selectedPhase={selectedPhase} onSelectPhase={onSelectPhase} />;
}

/**
 * Compact horizontal phase capsule trail shown beneath the collapsed ProcessDisclosure header
 * for multi-phase or long turns. Clicking a phase capsule opens the timeline filtered to that phase.
 */
export function PhaseTimelineStrip({
  timeline,
  selectedPhase = null,
  onSelectPhase,
}: {
  timeline: PhaseTimelineData;
  selectedPhase?: PhaseKind | null;
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
              title={phase.label}
              onClick={() => onSelectPhase?.(phase.kind)}
              className="oc-phase-pill"
            >
              <Icon size={11} strokeWidth={2} aria-hidden className="oc-phase-pill-icon" />
              <span>{phase.shortLabel}</span>
              <span className="oc-phase-pill-count">{phase.stepCount}</span>
              {duration ? <span className="oc-phase-pill-count">· {duration}</span> : null}
            </button>
          </Fragment>
        );
      })}
      {timeline.metrics.changedFileCount > 0 ? (
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
      <div className="oc-phase-filter-top">
        <span data-testid="phase-summary-text" className="oc-phase-summary-text" title={timeline.summaryText}>
          {timeline.summaryText}
        </span>
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
              <Icon size={11} strokeWidth={2} aria-hidden className="oc-phase-pill-icon" />
              <span>{phase.shortLabel}</span>
              <span className="oc-phase-pill-count">{phase.stepCount}</span>
              {duration ? <span className="oc-phase-pill-count">· {duration}</span> : null}
            </button>
          );
        })}
      </div>
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
      <Icon size={12} strokeWidth={2} aria-hidden className="text-accent" />
      <span>{phase.label}</span>
      <span className="tabular-nums text-faint">· {phase.stepCount} 项</span>
      {phase.changedFileCount > 0 ? (
        <span className="tabular-nums text-faint">· 改动 {phase.changedFileCount} 个文件</span>
      ) : null}
      {duration ? <span className="ml-auto tabular-nums text-faint">{duration}</span> : null}
    </div>
  );
}
