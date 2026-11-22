import type { LiveChildBlock, LiveUnit, LiveUnitsPage, SwarmSnapshot } from "@openclaude/protocol/browser";
import {
  EPOCH_BAND,
  SWARM_BOARD_TOOL_NAME,
  isSwarmSnapshot,
  packEpoch,
  timelineIdentity,
} from "@openclaude/protocol/browser";
import type { ChatMessage, ChildBlock } from "./model";

export function isLiveUnitsPage(value: unknown): value is LiveUnitsPage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  return rec.view === "units" && Array.isArray(rec.units);
}

export function isDurableFramesPage(value: unknown): value is {
  frames: unknown[];
  nextCursor: string | null;
  hasMore: boolean;
  streamClientMessageIds: string[];
  hasTapeProjection: boolean;
  tapeProjectionVersion?: number;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  return Array.isArray(rec.frames) && rec.view !== "units";
}

function roleFor(kind: LiveUnit["kind"]): ChatMessage["role"] {
  if (kind === "agent_group") return "agent-group";
  if (kind === "text") return "assistant";
  return kind;
}

function mapChild(child: LiveChildBlock): ChildBlock {
  return {
    kind: (child.kind as ChildBlock["kind"]) || "text",
    blockId: child.blockId,
    toolUseBlockId: child.toolUseBlockId,
    text: child.text,
    toolName: child.toolName,
    inputPreview: child.inputPreview,
    inputJson: child.inputJson,
    preview: child.preview,
    _partial: child._partial,
    _completed: child._completed,
    output: child.output,
    outputJson: child.outputJson,
    error: child.error,
    ...(child.payloadRef ? { payloadRef: child.payloadRef } : {}),
  };
}

function engineMessageId(unit: LiveUnit): string | undefined {
  const extra = unit as LiveUnit & { messageId?: string };
  return typeof extra.messageId === "string" && extra.messageId ? extra.messageId : undefined;
}

function toolInputPreviewOf(unit: LiveUnit): string | undefined {
  const extra = unit as LiveUnit & { inputPreview?: string };
  if (typeof extra.inputPreview === "string" && extra.inputPreview) return extra.inputPreview;
  // protocol fold 把 tool_use.inputPreview 存在 unit.text 里。
  if (unit.kind === "tool" && typeof unit.text === "string" && unit.text) return unit.text;
  return undefined;
}

function extractSwarmSnapshotFromUnit(unit: LiveUnit): SwarmSnapshot | undefined {
  if (unit.kind !== "tool" || unit.toolName !== SWARM_BOARD_TOOL_NAME) return undefined;
  const input = unit.inputJson;
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const rec = input as Record<string, unknown>;
  if (isSwarmSnapshot(rec.snapshot)) return rec.snapshot;
  if (isSwarmSnapshot(rec)) return rec;
  return undefined;
}

export function liveUnitToMessage(
  unit: LiveUnit,
  opts?: { streamGeneration?: number },
): ChatMessage {
  const role = roleFor(unit.kind);
  const text = unit.kind === "tool" ? "" : (unit.text || unit.goal || "");
  const inputPreview = toolInputPreviewOf(unit);
  const swarmSnapshot = extractSwarmSnapshotFromUnit(unit);
  const owner = unit.clientMessageId || "";
  const processKey = unit.timelineProcessKey ?? "";
  const streamGeneration = typeof unit.streamGeneration === "number"
    ? unit.streamGeneration
    : (opts?.streamGeneration ?? 0);
  const lifecycle = unit.open ? "live_open" as const : "live_closed" as const;
  return {
    id: engineMessageId(unit) || unit.id,
    role,
    text,
    ts: Date.now(),
    _liveUnit: true,
    _lifecycle: lifecycle,
    _lifecycleEpoch: packEpoch(EPOCH_BAND.LIVE, streamGeneration, unit.seqLast, 0),
    _timelineProcessKey: processKey,
    _timelineIdentity: timelineIdentity(owner, role, processKey),
    _timelineStreamGen: streamGeneration,
    ...(unit.clientMessageId ? {
      _clientMessageId: unit.clientMessageId,
      _turnOwnerId: unit.clientMessageId,
    } : {}),
    ...(unit.blockId && unit.kind !== "plan" ? { blockId: unit.blockId } : {}),
    ...(unit.toolName ? { toolName: unit.toolName } : {}),
    ...(inputPreview ? { inputPreview } : {}),
    ...(unit.inputJson !== undefined ? { inputJson: unit.inputJson } : {}),
    ...(swarmSnapshot ? { _swarmSnapshot: swarmSnapshot } : {}),
    ...(unit.output !== undefined ? { output: unit.output } : {}),
    ...(unit.outputJson !== undefined ? { outputJson: unit.outputJson } : {}),
    ...(unit.preview ? { preview: unit.preview } : {}),
    ...(unit.error ? { error: true } : {}),
    ...(unit.runId ? { _delegateRunId: unit.runId, runId: unit.runId } : {}),
    ...(unit.agentId ? { _delegateAgentId: unit.agentId, agentId: unit.agentId } : {}),
    ...(unit.goal ? { goal: unit.goal, _delegate: true, _delegateGoal: unit.goal } : {}),
    ...(unit.kind === "agent_group" ? {
      childBlocks: (unit.children ?? []).map(mapChild),
      _completed: !!unit.completed,
      startTime: Date.now(),
    } : {}),
    ...(unit.kind === "tool" ? { _completed: !unit.open } : {}),
    ...(unit.payloadRef ? { _payloadRef: unit.payloadRef } : {}),
  };
}

export function prependLiveUnitMessages(
  messages: ChatMessage[],
  incoming: ChatMessage[],
): ChatMessage[] {
  const seen = new Set(messages.map((m) => m.id));
  const fresh = incoming.filter((m) => !seen.has(m.id));
  if (fresh.length === 0) return messages;
  const insertAt = messages.findIndex((m) => m._liveUnit === true);
  if (insertAt < 0) return [...messages, ...fresh];
  return [...messages.slice(0, insertAt), ...fresh, ...messages.slice(insertAt)];
}

/**
 * Resolve the authoritative `{ streamKey, agentId }` for a `view=units` pack ONLY when
 * `resume.streamKey` is explicitly present (atomically paired with `resume.frameSeq` by
 * the protocol reducer). Never guess from arbitrary unit payloadRefs (OCV5-837).
 */
export function resolveLiveUnitsSnapshotStream(
  _units: readonly LiveUnit[],
  resume: { sessionKey?: string; streamKey?: string } | undefined,
  fallbackAgentId?: string,
): { streamKey: string; agentId: string } | null {
  const streamKey = typeof resume?.streamKey === "string" ? resume.streamKey : "";
  if (!streamKey) return null;
  const sessionKey = typeof resume?.sessionKey === "string" ? resume.sessionKey : "";
  const match = /^agent:([^:]+):/.exec(sessionKey);
  const agentId = (match?.[1] && match[1].trim()) || fallbackAgentId || "main";
  return { streamKey, agentId };
}

/**
 * Update a session's frameSeq watermark and `_snapshotStream` from a `view=units`
 * pack so subsequent WS `inbound.hello` reconnects report the matching streamKey
 * instead of triggering spurious `cursor_reset` rebuilds (OCV5-837).
 */
export function applyLiveUnitsResumeStream(
  sess: {
    agentId?: string;
    _activeAgentId?: string;
    _lastFrameSeqByKey?: Record<string, number>;
    _lastFrameSeq?: number;
    _snapshotStream?: { streamKey: string; agentId: string };
  },
  units: readonly LiveUnit[],
  resume: { sessionKey: string; frameSeq: number; recordId: string; streamKey?: string } | undefined,
  defaultAgentId?: string,
): void {
  if (!resume?.sessionKey || resume.frameSeq <= 0) return;
  if (!sess._lastFrameSeqByKey || typeof sess._lastFrameSeqByKey !== "object") {
    sess._lastFrameSeqByKey = {};
  }
  const resolvedStream = resolveLiveUnitsSnapshotStream(
    units,
    resume,
    sess._activeAgentId || sess.agentId || defaultAgentId || "main",
  );
  if (resolvedStream) {
    const prevSeq = sess._lastFrameSeqByKey[resume.sessionKey] ?? 0;
    const sameKnownStream = sess._snapshotStream?.streamKey === resolvedStream.streamKey;
    sess._lastFrameSeqByKey[resume.sessionKey] = sameKnownStream
      ? Math.max(prevSeq, resume.frameSeq)
      : resume.frameSeq;
    sess._lastFrameSeq = sameKnownStream
      ? Math.max(sess._lastFrameSeq || 0, resume.frameSeq)
      : resume.frameSeq;
    sess._snapshotStream = resolvedStream;
    return;
  }
  sess._lastFrameSeqByKey[resume.sessionKey] = resume.frameSeq;
  sess._lastFrameSeq = Math.max(sess._lastFrameSeq || 0, resume.frameSeq);
}

/**
 * Attempt self-healing recovery via `view=units` when a full snapshot rebuild hits the page cap (OCV5-837).
 * Strictly verifies the returned pack belongs to the target open dispatch/stream and carries
 * non-empty units + a valid resume cursor, so a post-completion empty pack or another turn's pack
 * can never wipe local cards or falsely clear `_liveJournalDegraded`.
 */
export async function fetchRecoverableLiveUnits(
  readLiveUnits: ((sessId: string) => Promise<unknown>) | undefined,
  sessId: string,
  expected: { clientMessageId: string; streamKey?: string | null },
): Promise<LiveUnitsPage | null> {
  if (!readLiveUnits) return null;
  const raw = await readLiveUnits(sessId).catch(() => null);
  if (!isLiveUnitsPage(raw) || raw.degraded === "fallback") return null;
  if (!raw.openDispatch || raw.units.length === 0) return null;
  if (!raw.streamClientMessageIds.includes(expected.clientMessageId)) return null;
  if (!raw.units.some((u) => u.clientMessageId === expected.clientMessageId)) return null;
  if (!raw.resume || !raw.resume.sessionKey || !(raw.resume.frameSeq > 0)) return null;
  if (expected.streamKey && raw.resume.streamKey !== expected.streamKey) {
    return null;
  }
  return raw;
}

/** Restore WS continuation pointers so the next delta appends the hydrated row. */
export function restoreLiveUnitStreamingState(
  sess: {
    messages: ChatMessage[];
    _streamingThinking?: ChatMessage | null;
    _streamingAssistant?: ChatMessage | null;
    _blockIdToMsgId?: Map<string, string>;
  },
  units: LiveUnit[],
): void {
  for (const unit of units) {
    const id = engineMessageId(unit) || unit.id;
    const row = sess.messages.find((m) => m.id === id);
    if (!row) continue;
    if (unit.blockId && unit.kind === "tool") {
      sess._blockIdToMsgId?.set(unit.blockId, row.id);
    }
    if (!unit.open) continue;
    if (unit.kind === "thinking") sess._streamingThinking = row;
    if (unit.kind === "text") sess._streamingAssistant = row;
  }
}
