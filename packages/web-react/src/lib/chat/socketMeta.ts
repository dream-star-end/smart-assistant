import { deriveLiveTerminalFromMessages, deriveSessionNeedsYou } from "../sessionStatus";
import type { ChatSession } from "./model";
import type { ChatStatusClass } from "./pure";

/** Escape-hatch timeout for an acknowledged Stop whose terminal frame/receipt never arrives. */
export const STOP_SETTLEMENT_TIMEOUT_MS = 15_000;
export const STOP_SETTLEMENT_TIMEOUT_NOTICE = "停止响应超时，已解除输入锁定，正在同步会话状态…";

/**
 * Low-frequency metadata signature for Sidebar / LiveActivityStrip / unread & needs-you signals.
 * Plain streaming text/thinking/tool-output deltas do NOT alter this signature, keeping
 * `metaVersion` stable during token streaming while bumping immediately on busy/idle,
 * needs_you (permission/options/approval), terminal outcome, title, model, or connection changes.
 */
export function computeSocketMetaSignature(input: {
  sessions: ReadonlyMap<string, ChatSession>;
  offlineSessionIds: ReadonlySet<string>;
  statusCls: ChatStatusClass;
  provisioning: boolean;
  browserOnline: boolean;
}): string {
  const parts: string[] = [
    `${input.statusCls}|${input.provisioning ? 1 : 0}|${input.browserOnline ? 1 : 0}`,
  ];
  for (const [id, s] of input.sessions) {
    const busy = s._sendingInFlight || !!s._stopSettlement || input.offlineSessionIds.has(id) ? 1 : 0;
    const needs = deriveSessionNeedsYou(s) ?? "";
    const terminal = deriveLiveTerminalFromMessages(s.messages);
    const termKey = terminal ? `${terminal.lastOutcome}:${terminal.lastErrorCode ?? ""}` : "";
    const turnStatusKey = typeof s._turnStatus === "string"
      ? s._turnStatus
      : s._turnStatus
        ? `${s._turnStatus.kind}:${s._turnStatus.attempt}`
        : "";
    parts.push(
      `${id}=${busy}|${needs}|${termKey}|${s.title}|${s.agentId}|${s._selectedModelId ?? ""}|${s._recoveryStatus?.kind ?? ""}|${turnStatusKey}`,
    );
  }
  return parts.join("\n");
}

/**
 * O(1) dirty-session fingerprint read directly from live `ChatSession` without invoking
 * `toStored()` (which filters/maps the entire message array). Used to collect
 * `dirtyPersistIds` for incremental IndexedDB persistence.
 */
export function quickSessionPersistFingerprint(s: ChatSession): string {
  const len = s.messages.length;
  const last = len > 0 ? s.messages[len - 1] : undefined;
  const lastSig = last
    ? `${last.id}/${last.text?.length ?? 0}/${last.output?.length ?? 0}/${last.partialJson?.length ?? 0}/${last._completed ? 1 : 0}/${last.status ?? ""}/${last._resolved ? 1 : 0}/${last._controlPending ? 1 : 0}/${last._behavior ?? ""}`
    : "";
  const inflightSig = s._sendingInFlight
    ? `1/${s._turnStartedAt ?? 0}/${s._lastFrameAt ?? 0}`
    : "0";
  const recoveryCount = s._automaticRecoveryDecisions
    ? Object.keys(s._automaticRecoveryDecisions).length
    : 0;
  return `${len}:${lastSig}:${s._lastFrameSeq ?? 0}:${s._maxSeq ?? 0}:${s.updatedAt ?? s.lastAt}:${s.title}:${s.agentId}:${s._selectedModelId ?? ""}:${inflightSig}:${s._trackerResetAt ?? 0}:${s._trackerResetServerTs ?? 0}:${s._localTeardownAt ?? 0}:${s._agentSwitchedAt ?? 0}:${recoveryCount}`;
}

/**
 * Encapsulates low-frequency metaVersion, incremental dirtyPersistIds tracking,
 * and stop-settlement timeout timers so ChatSocket stays compact.
 */
export class SocketMetaTracker {
  metaVersion = 0;
  private lastMetaSig = "";
  private dirtyPersistIds = new Set<string>();
  private persistFingerprints = new Map<string, string>();
  private stopTimers = new Map<string, ReturnType<typeof setTimeout>>();

  onFlush(input: {
    sessions: ReadonlyMap<string, ChatSession>;
    offlineQueue: ReadonlyArray<{ sessId: string }>;
    statusCls: ChatStatusClass;
    provisioning: boolean;
    browserOnline: boolean;
  }): void {
    const offlineSessionIds = new Set<string>();
    for (const item of input.offlineQueue) offlineSessionIds.add(item.sessId);
    const nextSig = computeSocketMetaSignature({
      sessions: input.sessions,
      offlineSessionIds,
      statusCls: input.statusCls,
      provisioning: input.provisioning,
      browserOnline: input.browserOnline,
    });
    if (nextSig !== this.lastMetaSig) {
      this.lastMetaSig = nextSig;
      this.metaVersion += 1;
    }
    for (const [id, s] of input.sessions) {
      const fp = quickSessionPersistFingerprint(s);
      if (this.persistFingerprints.get(id) !== fp) {
        this.persistFingerprints.set(id, fp);
        this.dirtyPersistIds.add(id);
      }
    }
    if (this.persistFingerprints.size > input.sessions.size) {
      for (const id of this.persistFingerprints.keys()) {
        if (!input.sessions.has(id)) {
          this.persistFingerprints.delete(id);
          this.dirtyPersistIds.delete(id);
        }
      }
    }
  }

  consumeDirtyPersistIds(): string[] {
    if (this.dirtyPersistIds.size === 0) return [];
    const out = [...this.dirtyPersistIds];
    this.dirtyPersistIds.clear();
    return out;
  }

  markPersisted(sessId: string, session?: ChatSession): void {
    this.dirtyPersistIds.delete(sessId);
    if (session) this.persistFingerprints.set(sessId, quickSessionPersistFingerprint(session));
  }

  armStopTimeout(sessId: string, onExpire: () => void, timeoutMs = STOP_SETTLEMENT_TIMEOUT_MS): void {
    this.clearStopTimeout(sessId);
    const timer = setTimeout(() => {
      this.stopTimers.delete(sessId);
      onExpire();
    }, timeoutMs);
    this.stopTimers.set(sessId, timer);
  }

  clearStopTimeout(sessId: string): void {
    const t = this.stopTimers.get(sessId);
    if (t !== undefined) {
      clearTimeout(t);
      this.stopTimers.delete(sessId);
    }
  }

  clearAllStopTimers(): void {
    for (const t of this.stopTimers.values()) clearTimeout(t);
    this.stopTimers.clear();
  }

  removeSession(sessId: string): void {
    this.clearStopTimeout(sessId);
    this.dirtyPersistIds.delete(sessId);
    this.persistFingerprints.delete(sessId);
  }

  reset(): void {
    this.clearAllStopTimers();
    this.dirtyPersistIds.clear();
    this.persistFingerprints.clear();
  }
}
