/**
 * Frontend zero-token auto-resume state machine & UI-only context formatter (OCV5-864).
 *
 * Manages:
 * - 2-second local pointer/keyboard/typing silence guard (`AUTO_RESUME_IDLE_GUARD_MS`)
 * - 3-second graceful countdown (or custom `resumeWhen.autoResumeDelayMs`)
 * - Immediate cancellation on any user pointer/keyboard/wheel/text input, "再等等" click,
 *   server `handoff_vetoed` revocation (B3), WS disconnect / CDP loss, or card switch (B4)
 * - Generation & context fencing (`epoch`, `handoffNonce`, `handoffId`) so stale timers or
 *   cross-card callbacks can NEVER hand back a newer card or disconnected session
 * - Anti-tug-of-war circuit breaker: if 2 consecutive automatic handbacks are each
 *   followed within 15s by a new takeover/re-block in the same session, locks the session
 *   to manual "交还并继续" clicks until session switch or explicit manual recovery.
 * - Strict trust boundary (B2): auto-resume NEVER interpolates untrusted webpage URL or
 *   server-suggested filename into user chat messages (`AUTO_RESUME_SAFE_CONTINUE_MESSAGE`).
 */
import type {
  BrowserHandoffResumeWhen,
  LiveBrowserHandoffReadyMessage,
} from "@openclaude/protocol/browser";

export const AUTO_RESUME_IDLE_GUARD_MS = 2_000;
export const AUTO_RESUME_DEFAULT_COUNTDOWN_MS = 3_000;
export const AUTO_RESUME_TRIP_WINDOW_MS = 15_000;
export const AUTO_RESUME_MAX_RAPID_LOOPS = 2;
/** Fixed trusted continuation message (B2: never interpolate third-party page URL/filename). */
export const AUTO_RESUME_SAFE_CONTINUE_MESSAGE = "我已完成浏览器接管操作，请继续处理。";
const COUNTDOWN_TICK_MS = 250;

export type AutoResumePhase = "idle" | "waiting_idle" | "countdown" | "circuit_open";

export interface AutoResumeBindingContext {
  readonly handoffNonce: number | null;
  readonly handoffId: string | null;
}

export interface AutoResumeSnapshot {
  readonly phase: AutoResumePhase;
  readonly event: LiveBrowserHandoffReadyMessage | null;
  readonly remainingSec: number;
  readonly totalSec: number;
  readonly circuitOpen: boolean;
}

export interface LiveBrowserAutoResumeControllerOptions {
  idleGuardMs?: number;
  defaultCountdownMs?: number;
  tripWindowMs?: number;
  maxRapidLoops?: number;
  now?: () => number;
  onChange?: (snapshot: AutoResumeSnapshot) => void;
  onAutoHandBack?: (event: LiveBrowserHandoffReadyMessage, context: AutoResumeBindingContext) => void;
}

/**
 * Sanitized filename strictly for passive UI display in the countdown strip (NEVER sent as user text).
 */
export function formatAutoResumeUiFilename(raw?: string): string | null {
  if (!raw) return null;
  const cleaned = raw
    .split(/[\\/]/)
    .pop()
    ?.replace(/[\x00-\x1f\x7f"'`<>]/g, "")
    .trim();
  return cleaned ? cleaned.slice(0, 80) : null;
}

function eventDedupKey(evt: LiveBrowserHandoffReadyMessage): string {
  return `${evt.signal}\0${evt.url}\0${evt.filename ?? ""}`;
}

export class LiveBrowserAutoResumeController {
  private readonly idleGuardMs: number;
  private readonly defaultCountdownMs: number;
  private readonly tripWindowMs: number;
  private readonly maxRapidLoops: number;
  private readonly now: () => number;
  private readonly onChange?: (snapshot: AutoResumeSnapshot) => void;
  private readonly onAutoHandBack?: (
    event: LiveBrowserHandoffReadyMessage,
    context: AutoResumeBindingContext,
  ) => void;

  private disposed = false;
  private epoch = 0;
  private takeoverActive = false;
  private resumeWhen: BrowserHandoffResumeWhen | null = null;
  private bindingContext: AutoResumeBindingContext = { handoffNonce: null, handoffId: null };
  private watchIdRequired = false;
  private isTyping = false;
  private lastActivityAt = 0;

  private phase: AutoResumePhase = "idle";
  private pendingEvent: LiveBrowserHandoffReadyMessage | null = null;
  private dismissedKey: string | null = null;
  private countdownEndAt = 0;
  private totalCountdownMs = AUTO_RESUME_DEFAULT_COUNTDOWN_MS;
  private remainingSec = 0;

  private lastAutoHandbackAt: number | null = null;
  private rapidReTakeoverCount = 0;
  private circuitOpen = false;

  private idleTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private countdownTimer: ReturnType<typeof globalThis.setInterval> | null = null;

  constructor(opts: LiveBrowserAutoResumeControllerOptions = {}) {
    this.idleGuardMs = opts.idleGuardMs ?? AUTO_RESUME_IDLE_GUARD_MS;
    this.defaultCountdownMs = opts.defaultCountdownMs ?? AUTO_RESUME_DEFAULT_COUNTDOWN_MS;
    this.tripWindowMs = opts.tripWindowMs ?? AUTO_RESUME_TRIP_WINDOW_MS;
    this.maxRapidLoops = opts.maxRapidLoops ?? AUTO_RESUME_MAX_RAPID_LOOPS;
    this.now = opts.now ?? (() => Date.now());
    this.onChange = opts.onChange;
    this.onAutoHandBack = opts.onAutoHandBack;
  }

  public getSnapshot(): AutoResumeSnapshot {
    return {
      phase: this.phase,
      event: this.pendingEvent,
      remainingSec: this.remainingSec,
      totalSec: Math.max(1, Math.ceil(this.totalCountdownMs / 1_000)),
      circuitOpen: this.circuitOpen,
    };
  }

  public onTakeoverEntered(
    resumeWhen?: BrowserHandoffResumeWhen | null,
    context?: Partial<AutoResumeBindingContext>,
  ): void {
    if (this.disposed) return;
    const t = this.now();
    this.epoch += 1;
    this.takeoverActive = true;
    this.resumeWhen = resumeWhen ?? null;
    this.bindingContext = {
      handoffNonce: context?.handoffNonce ?? null,
      handoffId: context?.handoffId ?? null,
    };
    this.lastActivityAt = t;
    this.dismissedKey = null;
    this.pendingEvent = null;
    this.clearTimers();

    if (this.lastAutoHandbackAt !== null) {
      if (t - this.lastAutoHandbackAt <= this.tripWindowMs) {
        this.rapidReTakeoverCount += 1;
        if (this.rapidReTakeoverCount >= this.maxRapidLoops) {
          this.circuitOpen = true;
        }
      } else {
        this.rapidReTakeoverCount = 0;
      }
      this.lastAutoHandbackAt = null;
    }

    this.phase = "idle";
    this.remainingSec = 0;
    this.emitChange();
  }

  /**
   * B4: Switch bound handoff card/request while staying in manual takeover.
   * Immediately voids any pending countdown/ready event from the previous card.
   */
  public onHandoffContextChanged(
    resumeWhen?: BrowserHandoffResumeWhen | null,
    context?: Partial<AutoResumeBindingContext>,
  ): void {
    if (this.disposed) return;
    this.epoch += 1;
    this.resumeWhen = resumeWhen ?? null;
    this.bindingContext = {
      handoffNonce: context?.handoffNonce ?? null,
      handoffId: context?.handoffId ?? null,
    };
    // Require explicit matching watchId on subsequent ready events after a live card switch
    // so late in-flight events from Card A (even without watchId) cannot hijack Card B.
    this.watchIdRequired = this.bindingContext.handoffNonce !== null;
    this.lastActivityAt = this.now();
    this.dismissedKey = null;
    this.pendingEvent = null;
    this.clearTimers();
    this.phase = "idle";
    this.remainingSec = 0;
    this.emitChange();
  }

  /**
   * B4: Invalidate any pending/running auto-resume countdown on WS disconnect or CDP loss
   * WITHOUT revoking the user's current manual takeover.
   */
  public invalidatePending(): void {
    if (this.disposed) return;
    this.epoch += 1;
    this.clearTimers();
    this.pendingEvent = null;
    this.dismissedKey = null;
    if (this.phase !== "idle" || this.remainingSec !== 0) {
      this.phase = "idle";
      this.remainingSec = 0;
      this.emitChange();
    }
  }

  /**
   * B3: Server revoked a previously emitted `handoff_ready` (e.g., async SPA mounted OTP/blocker
   * or explicit `resumeWhen` condition became false again). Immediately cancel countdown while
   * preserving manual takeover and allowing a future genuine completion to re-trigger.
   */
  public onHandoffVetoed(): void {
    this.invalidatePending();
  }

  public onTakeoverExited(): void {
    if (this.disposed) return;
    this.epoch += 1;
    this.takeoverActive = false;
    this.resumeWhen = null;
    this.bindingContext = { handoffNonce: null, handoffId: null };
    this.watchIdRequired = false;
    this.isTyping = false;
    this.pendingEvent = null;
    this.dismissedKey = null;
    this.clearTimers();
    this.phase = "idle";
    this.remainingSec = 0;
    this.emitChange();
  }

  public resetSession(): void {
    if (this.disposed) return;
    this.epoch += 1;
    this.clearTimers();
    this.takeoverActive = false;
    this.resumeWhen = null;
    this.bindingContext = { handoffNonce: null, handoffId: null };
    this.isTyping = false;
    this.pendingEvent = null;
    this.dismissedKey = null;
    this.lastAutoHandbackAt = null;
    this.rapidReTakeoverCount = 0;
    this.circuitOpen = false;
    this.phase = "idle";
    this.remainingSec = 0;
    this.emitChange();
  }

  public setTyping(typing: boolean): void {
    if (this.disposed) return;
    const prev = this.isTyping;
    this.isTyping = typing;
    if (typing) {
      this.recordUserActivity();
      return;
    }
    if (prev && !typing && this.phase === "waiting_idle" && this.pendingEvent && this.takeoverActive) {
      this.lastActivityAt = this.now();
      this.scheduleIdleGuard(this.epoch);
    }
  }

  public recordUserActivity(): void {
    if (this.disposed || !this.takeoverActive) return;
    this.lastActivityAt = this.now();
    if (this.phase === "countdown") {
      // User moved mouse or pressed a key during countdown: cancel immediately, never steal focus.
      if (this.pendingEvent) {
        this.dismissedKey = eventDedupKey(this.pendingEvent);
      }
      this.epoch += 1;
      this.clearTimers();
      this.pendingEvent = null;
      this.phase = "idle";
      this.remainingSec = 0;
      this.emitChange();
      return;
    }
    if (this.phase === "waiting_idle") {
      if (this.isTyping) {
        this.clearIdleTimer();
      } else {
        this.scheduleIdleGuard(this.epoch);
      }
    }
  }

  public onPageLoading(): void {
    if (this.disposed) return;
    if (this.phase === "waiting_idle" || this.phase === "countdown") {
      this.invalidatePending();
    }
  }

  public onHandoffReady(event: LiveBrowserHandoffReadyMessage): void {
    if (this.disposed || !this.takeoverActive) return;
    // B4: When a watchId (card switch nonce) is bound, ignore late in-flight events from an earlier card.
    const expectedWatchId =
      this.bindingContext.handoffNonce !== null ? `handoff-${this.bindingContext.handoffNonce}` : null;
    if (expectedWatchId && event.watchId !== undefined && event.watchId !== expectedWatchId) {
      return;
    }
    if (expectedWatchId && event.watchId === undefined && this.watchIdRequired) {
      return;
    }
    const key = eventDedupKey(event);
    if (this.dismissedKey === key) return;

    if (this.circuitOpen) {
      this.clearTimers();
      this.pendingEvent = event;
      this.phase = "circuit_open";
      this.remainingSec = 0;
      this.emitChange();
      return;
    }

    if (this.phase === "countdown" && this.pendingEvent && eventDedupKey(this.pendingEvent) === key) {
      return;
    }

    this.pendingEvent = event;
    this.totalCountdownMs = this.resolveCountdownMs();
    const myEpoch = this.epoch;
    if (this.isTyping) {
      this.clearTimers();
      this.phase = "waiting_idle";
      this.remainingSec = Math.max(1, Math.ceil(this.totalCountdownMs / 1_000));
      this.emitChange();
      return;
    }

    const elapsed = this.now() - this.lastActivityAt;
    if (elapsed >= this.idleGuardMs) {
      this.startCountdown(myEpoch);
    } else {
      this.phase = "waiting_idle";
      this.remainingSec = Math.max(1, Math.ceil(this.totalCountdownMs / 1_000));
      this.scheduleIdleGuard(myEpoch);
      this.emitChange();
    }
  }

  public cancelByUser(): void {
    if (this.disposed) return;
    if (this.pendingEvent) {
      this.dismissedKey = eventDedupKey(this.pendingEvent);
    }
    this.epoch += 1;
    this.clearTimers();
    this.pendingEvent = null;
    this.phase = "idle";
    this.remainingSec = 0;
    this.emitChange();
  }

  public triggerNow(isAutomatic = false): void {
    if (this.disposed) return;
    const evt = this.pendingEvent;
    const ctx: AutoResumeBindingContext = { ...this.bindingContext };
    this.epoch += 1;
    this.clearTimers();
    this.pendingEvent = null;
    this.phase = "idle";
    this.remainingSec = 0;
    if (!evt || !this.takeoverActive) {
      this.emitChange();
      return;
    }
    if (isAutomatic) {
      this.lastAutoHandbackAt = this.now();
    } else {
      // Explicit human confirmation resets tug-of-war streak.
      this.lastAutoHandbackAt = null;
      this.rapidReTakeoverCount = 0;
    }
    this.emitChange();
    this.onAutoHandBack?.(evt, ctx);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch += 1;
    this.clearTimers();
    this.pendingEvent = null;
  }

  private resolveCountdownMs(): number {
    const custom = this.resumeWhen?.autoResumeDelayMs;
    if (typeof custom === "number" && Number.isFinite(custom) && custom >= 500) {
      return Math.min(15_000, Math.round(custom));
    }
    return this.defaultCountdownMs;
  }

  private scheduleIdleGuard(expectedEpoch: number): void {
    this.clearIdleTimer();
    const remaining = Math.max(0, this.idleGuardMs - (this.now() - this.lastActivityAt));
    this.idleTimer = globalThis.setTimeout(() => {
      this.idleTimer = null;
      if (
        this.disposed ||
        this.epoch !== expectedEpoch ||
        !this.takeoverActive ||
        !this.pendingEvent ||
        this.circuitOpen
      ) {
        return;
      }
      if (this.isTyping) return;
      const elapsed = this.now() - this.lastActivityAt;
      if (elapsed < this.idleGuardMs) {
        this.scheduleIdleGuard(expectedEpoch);
        return;
      }
      this.startCountdown(expectedEpoch);
    }, remaining);
  }

  private startCountdown(expectedEpoch: number): void {
    this.clearTimers();
    if (
      this.disposed ||
      this.epoch !== expectedEpoch ||
      !this.takeoverActive ||
      !this.pendingEvent ||
      this.circuitOpen
    ) {
      return;
    }
    this.totalCountdownMs = this.resolveCountdownMs();
    this.countdownEndAt = this.now() + this.totalCountdownMs;
    this.phase = "countdown";
    this.remainingSec = Math.max(1, Math.ceil(this.totalCountdownMs / 1_000));
    this.emitChange();

    this.countdownTimer = globalThis.setInterval(() => {
      if (
        this.disposed ||
        this.epoch !== expectedEpoch ||
        !this.takeoverActive ||
        this.phase !== "countdown"
      ) {
        this.clearCountdownTimer();
        return;
      }
      const leftMs = this.countdownEndAt - this.now();
      if (leftMs <= 0) {
        this.triggerNow(true);
        return;
      }
      const nextSec = Math.max(1, Math.ceil(leftMs / 1_000));
      if (nextSec !== this.remainingSec) {
        this.remainingSec = nextSec;
        this.emitChange();
      }
    }, COUNTDOWN_TICK_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      globalThis.clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private clearCountdownTimer(): void {
    if (this.countdownTimer !== null) {
      globalThis.clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearIdleTimer();
    this.clearCountdownTimer();
  }

  private emitChange(): void {
    if (this.disposed) return;
    this.onChange?.(this.getSnapshot());
  }
}
