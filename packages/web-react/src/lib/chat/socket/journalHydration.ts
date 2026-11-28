import type { DurableLiveFrame, DurableLiveFramePage } from "../../types";
import type { OutboundWire } from "../frames";
import { isDurableFramesPage, isLiveUnitsPage } from "../liveUnitsHydrate";
import type { ChatSession } from "../model";
import {
  isSessionSnapshot,
  type SessionSnapshot,
  shouldKeepLocalRowsOnDegradedRebuild,
} from "../sessionSnapshot";
import { isLiveJournalAbort, messageHasVisibleBody } from "../socketRecoveryHelpers";
import { applySnapshotHeadToSession } from "./snapshotSync";
import {
  LIVE_JOURNAL_MAX_MS,
  LIVE_JOURNAL_MAX_PAGES,
  LIVE_JOURNAL_OPEN_CURSOR,
  type DurableFrameSeqCheckpointEntry,
  type DurableJournalCheckpoint,
  type SocketCtx,
} from "./types";

type JournalReadRunState = {
  cursor: string;
  currentLiveOwners: Set<string>;
  resetOwnerIds: Set<string>;
  lastDurableFrameSeqBySessionKey: Map<string, DurableFrameSeqCheckpointEntry>;
  sawTapeProjection: boolean;
  latestSnapshot?: SessionSnapshot;
  maxTapeProjectionVersion?: number;
  degraded: boolean;
  startedAt: number;
  pagesRead: number;
};

export function runDurableLiveFrameHydrationSerial(
  ctx: SocketCtx,
  sessId: string,
  hydrate: () => Promise<void>,
): Promise<void> {
  const previous = ctx.durableHydrationTails.get(sessId) ?? Promise.resolve();
  const run = previous
    .catch((err) => {
      void err;
    })
    .then(async () => {
      const state = { buffered: [] as OutboundWire[] };
      ctx.durableHydrationStates.set(sessId, state);
      try {
        await hydrate();
      } finally {
        if (ctx.durableHydrationStates.get(sessId) === state) {
          ctx.durableHydrationStates.delete(sessId);
        }
        for (const frame of state.buffered) {
          try {
            ctx.dispatch(frame);
          } catch (err) {
            void err;
          }
        }
        if (state.buffered.length > 0) ctx.scheduleNotify();
      }
    });
  const tracked: Promise<void> = run.finally(() => {
    if (ctx.durableHydrationTails.get(sessId) === tracked) {
      ctx.durableHydrationTails.delete(sessId);
    }
  });
  ctx.durableHydrationTails.set(sessId, tracked);
  return tracked;
}

function recordPageMetadata(page: DurableLiveFramePage, state: JournalReadRunState): void {
  if (isSessionSnapshot(page.snapshot)) state.latestSnapshot = page.snapshot;
  state.sawTapeProjection ||= page.hasTapeProjection === true;
  if (typeof page.tapeProjectionVersion === "number") {
    state.maxTapeProjectionVersion = Math.max(
      state.maxTapeProjectionVersion ?? 0,
      page.tapeProjectionVersion,
    );
  }
  state.currentLiveOwners = new Set(page.streamClientMessageIds);
}

function collectResetOwnersFromFrames(
  frames: readonly DurableLiveFrame[],
  liveOwners: ReadonlySet<string>,
  resetOwnerIds: Set<string>,
): void {
  for (const cmid of liveOwners) resetOwnerIds.add(cmid);
  for (const frame of frames) {
    if (typeof frame.clientMessageId === "string" && frame.clientMessageId) {
      resetOwnerIds.add(frame.clientMessageId);
    }
  }
}

async function readJournalPagesLoop(
  ctx: SocketCtx,
  sessId: string,
  fetchPage: (after: string) => Promise<DurableLiveFramePage>,
  stage: DurableLiveFrame[] | null,
  state: JournalReadRunState,
): Promise<void> {
  for (;;) {
    if (
      state.pagesRead >= LIVE_JOURNAL_MAX_PAGES ||
      Date.now() - state.startedAt >= LIVE_JOURNAL_MAX_MS
    ) {
      state.degraded = true;
      break;
    }
    let page: DurableLiveFramePage;
    try {
      page = await fetchPage(state.cursor);
    } catch (error) {
      if (isLiveJournalAbort(error)) {
        state.degraded = true;
        return;
      }
      throw error;
    }
    state.pagesRead += 1;
    recordPageMetadata(page, state);
    if (stage) {
      collectResetOwnersFromFrames(page.frames, state.currentLiveOwners, state.resetOwnerIds);
      stage.push(...page.frames);
    } else if (page.frames.length > 0) {
      ctx.applyDurableLiveFrames(
        sessId,
        page.frames,
        [],
        state.lastDurableFrameSeqBySessionKey,
      );
    }
    if (page.hasMore && !page.nextCursor) {
      throw new Error("live frame page missing cursor");
    }
    if (page.nextCursor) state.cursor = page.nextCursor;
    else if (state.cursor === LIVE_JOURNAL_OPEN_CURSOR) state.cursor = "0";
    if (!page.hasMore) break;
  }
}

function filterSafeOwnerResets(
  ctx: SocketCtx,
  sessId: string,
  state: JournalReadRunState,
): string[] {
  const sessRaw = ctx.sessions.get(sessId);
  if (!state.degraded || !sessRaw) return [...state.resetOwnerIds];
  return [...state.resetOwnerIds].filter(
    (id) =>
      !shouldKeepLocalRowsOnDegradedRebuild(
        sessRaw,
        state.latestSnapshot?.streamKey,
        id,
        true,
        state.degraded,
      ),
  );
}

async function applyInitialUnitsPack(
  ctx: SocketCtx,
  sessId: string,
  raw: Extract<ReturnType<typeof isLiveUnitsPage>, boolean> extends never
    ? never
    : Parameters<typeof isLiveUnitsPage>[0] & {
        streamClientMessageIds: string[];
        units: Parameters<SocketCtx["applyLiveUnits"]>[1];
        hasTapeProjection?: boolean;
        tapeProjectionVersion?: number;
        resume?: { sessionKey: string; frameSeq: number; recordId: string; streamKey?: string };
        streamGeneration?: number;
        hasMoreBefore: boolean;
        beforeCursor: string | null;
      },
  fetchPage: (after: string) => Promise<DurableLiveFramePage>,
  state: JournalReadRunState,
): Promise<void> {
  state.currentLiveOwners = new Set(raw.streamClientMessageIds);
  for (const id of state.currentLiveOwners) state.resetOwnerIds.add(id);
  for (const unit of raw.units) {
    if (unit.clientMessageId) state.resetOwnerIds.add(unit.clientMessageId);
  }
  state.sawTapeProjection ||= raw.hasTapeProjection === true;
  if (typeof raw.tapeProjectionVersion === "number") {
    state.maxTapeProjectionVersion = Math.max(
      state.maxTapeProjectionVersion ?? 0,
      raw.tapeProjectionVersion,
    );
  }
  ctx.applyLiveUnits(
    sessId,
    raw.units,
    [...state.resetOwnerIds],
    raw.resume,
    raw.streamGeneration,
  );
  if (raw.resume) {
    state.cursor = raw.resume.recordId;
    const sessionKey = raw.resume.sessionKey;
    if (sessionKey) {
      state.lastDurableFrameSeqBySessionKey.set(sessionKey, {
        frameSeq: raw.resume.frameSeq,
        consumedAuthoritativeResetEpoch:
          ctx.authoritativeFrameSeqResetEpochBySessionKey.get(sessionKey) ?? 0,
      });
    }
  }
  const sessForUnits = ctx.sessions.get(sessId);
  if (sessForUnits) {
    sessForUnits._liveUnitsPackApplied = true;
    sessForUnits._liveUnitsHasMoreBefore = raw.hasMoreBefore;
    sessForUnits._liveUnitsBeforeCursor = raw.beforeCursor;
    if (sessForUnits._recoveryStatus?.kind !== "stopping") {
      sessForUnits._recoveryStatus = { kind: "resumed" };
    }
  }
  if (raw.resume && !state.degraded) {
    await readJournalPagesLoop(ctx, sessId, fetchPage, null, state);
  }
}

async function applyInitialDurableFramesFirstPage(
  ctx: SocketCtx,
  sessId: string,
  firstPage: DurableLiveFramePage,
  fetchPage: (after: string) => Promise<DurableLiveFramePage>,
  state: JournalReadRunState,
): Promise<void> {
  recordPageMetadata(firstPage, state);
  const stagedFrames: DurableLiveFrame[] = [...firstPage.frames];
  collectResetOwnersFromFrames(stagedFrames, state.currentLiveOwners, state.resetOwnerIds);
  if (firstPage.nextCursor) state.cursor = firstPage.nextCursor;
  if (firstPage.hasMore) await readJournalPagesLoop(ctx, sessId, fetchPage, stagedFrames, state);
  const safeResets = filterSafeOwnerResets(ctx, sessId, state);
  ctx.applyDurableLiveFrames(
    sessId,
    stagedFrames,
    safeResets,
    state.lastDurableFrameSeqBySessionKey,
  );
  if (!state.degraded) await readJournalPagesLoop(ctx, sessId, fetchPage, null, state);
}

function isTypedDurableFramesPage(raw: unknown): raw is DurableLiveFramePage {
  return isDurableFramesPage(raw);
}

async function runInitialJournalHydration(
  ctx: SocketCtx,
  sessId: string,
  fetchPage: (after: string) => Promise<DurableLiveFramePage>,
  fetchUnits: ((query?: { before?: string | null }) => Promise<unknown>) | undefined,
  state: JournalReadRunState,
): Promise<void> {
  let usedUnits = false;
  if (fetchUnits) {
    try {
      const raw = await fetchUnits();
      if (isLiveUnitsPage(raw) && raw.degraded !== "fallback") {
        usedUnits = true;
        await applyInitialUnitsPack(ctx, sessId, raw, fetchPage, state);
      } else if (!isLiveUnitsPage(raw) && isTypedDurableFramesPage(raw)) {
        await applyInitialDurableFramesFirstPage(ctx, sessId, raw, fetchPage, state);
        usedUnits = true;
      }
    } catch (error) {
      if (isLiveJournalAbort(error)) state.degraded = true;
      else usedUnits = false;
    }
  }
  if (!usedUnits) {
    const stagedFrames: DurableLiveFrame[] = [];
    await readJournalPagesLoop(ctx, sessId, fetchPage, stagedFrames, state);
    const safeResets = filterSafeOwnerResets(ctx, sessId, state);
    ctx.applyDurableLiveFrames(
      sessId,
      stagedFrames,
      safeResets,
      state.lastDurableFrameSeqBySessionKey,
    );
    if (!state.degraded) await readJournalPagesLoop(ctx, sessId, fetchPage, null, state);
  }
}

function turnAssistantIsEmpty(sess: ChatSession): boolean {
  const cmid = sess._activeClientMessageId;
  const assistants = sess.messages.filter((message) => {
    if (message.role !== "assistant") return false;
    if (cmid && message._clientMessageId && message._clientMessageId !== cmid) return false;
    return true;
  });
  if (assistants.length === 0) return true;
  return assistants.every((message) => !messageHasVisibleBody(message));
}

function shouldTriggerJournalTapeProjection(
  sess: ChatSession | undefined,
  checkpoint: DurableJournalCheckpoint | undefined,
  previousLiveOwners: ReadonlySet<string>,
  state: JournalReadRunState,
): boolean {
  const activeCmid = sess?._activeClientMessageId;
  if (sess?._sendingInFlight && activeCmid && state.currentLiveOwners.has(activeCmid)) {
    return false;
  }
  const liveOwnerProjectedToTape = [...previousLiveOwners].some(
    (cmid) => !state.currentLiveOwners.has(cmid),
  );
  const versionAdvanced =
    typeof state.maxTapeProjectionVersion === "number" &&
    (checkpoint?.tapeProjectionVersion === undefined
      ? state.maxTapeProjectionVersion > 0
      : state.maxTapeProjectionVersion > checkpoint.tapeProjectionVersion);
  const tapeProjectionAppeared =
    typeof state.maxTapeProjectionVersion !== "number" &&
    state.sawTapeProjection &&
    checkpoint?.sawTapeProjection !== true;
  const noLiveOwner = !activeCmid || !state.currentLiveOwners.has(activeCmid);
  const emptyInFlightBubble =
    Boolean(sess?._sendingInFlight) && noLiveOwner && (sess ? turnAssistantIsEmpty(sess) : true);
  return (
    versionAdvanced ||
    tapeProjectionAppeared ||
    liveOwnerProjectedToTape ||
    state.degraded ||
    (state.sawTapeProjection && emptyInFlightBubble)
  );
}

export function hydrateDurableLiveFrameJournalFlow(
  ctx: SocketCtx,
  sessId: string,
  fetchPage: (after: string) => Promise<DurableLiveFramePage>,
  applyTapeProjection: () => Promise<void>,
  fetchUnits?: (query?: { before?: string | null }) => Promise<unknown>,
): Promise<void> {
  return ctx.runDurableLiveFrameHydration(sessId, async () => {
    const checkpoint = ctx.durableLiveJournalCheckpoints.get(sessId);
    const previousLiveOwners = checkpoint?.liveClientMessageIds ?? new Set<string>();
    const state: JournalReadRunState = {
      cursor: checkpoint?.cursor ?? LIVE_JOURNAL_OPEN_CURSOR,
      currentLiveOwners: new Set(previousLiveOwners),
      resetOwnerIds: new Set<string>(),
      lastDurableFrameSeqBySessionKey: new Map(
        checkpoint?.lastDurableFrameSeqBySessionKey ?? [],
      ),
      sawTapeProjection: false,
      degraded: false,
      startedAt: Date.now(),
      pagesRead: 0,
    };

    if (checkpoint === undefined) {
      await runInitialJournalHydration(ctx, sessId, fetchPage, fetchUnits, state);
    } else {
      await readJournalPagesLoop(ctx, sessId, fetchPage, null, state);
    }

    const sess = ctx.sessions.get(sessId);
    if (sess && state.latestSnapshot) {
      ctx.snapshotAckAt.set(sessId, Date.now());
      applySnapshotHeadToSession(ctx, sess, state.latestSnapshot, true, false);
    }
    if (shouldTriggerJournalTapeProjection(sess, checkpoint, previousLiveOwners, state)) {
      try {
        await applyTapeProjection();
      } catch {
        state.degraded = true;
      }
    }
    if (sess) {
      if (state.degraded) {
        sess._liveJournalDegraded = true;
        ctx.scheduleDegradedJournalRetry(sessId);
      } else {
        ctx.clearLiveJournalDegraded(sess);
      }
      ctx.scheduleNotify();
    }
    const nextVersion =
      typeof state.maxTapeProjectionVersion === "number"
        ? state.maxTapeProjectionVersion
        : checkpoint?.tapeProjectionVersion;
    ctx.durableLiveJournalCheckpoints.set(sessId, {
      cursor: state.cursor,
      ...(state.sawTapeProjection || checkpoint?.sawTapeProjection
        ? { sawTapeProjection: true }
        : {}),
      ...(nextVersion !== undefined ? { tapeProjectionVersion: nextVersion } : {}),
      liveClientMessageIds: state.currentLiveOwners,
      lastDurableFrameSeqBySessionKey: state.lastDurableFrameSeqBySessionKey,
    });
  });
}
