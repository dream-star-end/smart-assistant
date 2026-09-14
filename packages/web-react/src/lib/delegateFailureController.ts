import type { AuthSession } from "./types";
import {
  delegateFailureApi, delegateRetryActionId, failureErrorText, failureKey,
  type DelegateFailure, type DelegateFailurePage, type DelegateFailureSummary, type DelegateRetryResult,
} from "./delegateFailures";

export type FailureInboxState = Readonly<{
  open: boolean;
  summary: DelegateFailureSummary | null;
  page: DelegateFailurePage | null;
  loading: boolean;
  error: string | null;
  before: string | null;
  previous: readonly (string | null)[];
  pending: Readonly<Record<string, "ack" | "retry">>;
  messages: Readonly<Record<string, string>>;
  retries: Readonly<Record<string, DelegateRetryResult>>;
}>;
export const EMPTY_FAILURE_INBOX: FailureInboxState = Object.freeze({
  open: false, summary: null, page: null, loading: false, error: null, before: null,
  previous: [], pending: {}, messages: {}, retries: {},
});

/** A single account-scoped read model, not another ACK queue or durable-result store. */
export class DelegateFailureController {
  private state: FailureInboxState = EMPTY_FAILURE_INBOX;
  private listeners = new Set<() => void>();
  private active = false;
  private revision = 0;
  private epoch: number;
  private flight: Promise<void> | null = null;
  private refreshAgain = false;
  private reads: AbortController | null = null;
  private writes = new Set<AbortController>();
  private actions = new Map<string, Promise<void>>();

  constructor(private readonly auth: AuthSession, private readonly userId: string,
    private readonly scopeCurrent: () => boolean = () => true) {
    this.epoch = auth.snapshot().epoch;
  }
  private current = () => this.active && this.scopeCurrent() && !!this.userId &&
    this.auth.snapshot().epoch === this.epoch && !!this.auth.snapshot().token;
  getSnapshot = (): FailureInboxState => this.current() ? this.state : EMPTY_FAILURE_INBOX;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<FailureInboxState>) {
    if (!this.current()) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  start = () => { this.active = true; void this.refresh(); };
  stop = () => {
    this.active = false; this.revision++; this.refreshAgain = false;
    this.reads?.abort(); for (const write of this.writes) write.abort();
    // StrictMode setup/cleanup/setup must not revive old promises or pending buttons.
    this.state = EMPTY_FAILURE_INBOX;
    this.actions.clear();
    for (const listener of this.listeners) listener();
  };
  private invalidate() { this.revision++; this.reads?.abort(); }

  refresh = (): Promise<void> => {
    if (!this.current()) return Promise.resolve();
    this.refreshAgain = true;
    if (this.flight) return this.flight;
    this.flight = this.drain().finally(() => { this.flight = null; });
    return this.flight;
  };
  private async drain() {
    while (this.current() && this.refreshAgain) {
      this.refreshAgain = false;
      const revision = this.revision, before = this.state.before, open = this.state.open;
      const signal = new AbortController(); this.reads = signal;
      const valid = () => this.current() && revision === this.revision && !signal.signal.aborted;
      this.publish({ loading: true });
      try {
        const summary = await delegateFailureApi.summary(this.auth, signal.signal);
        if (!valid()) continue;
        const page = open ? await delegateFailureApi.page(this.auth, before, signal.signal) : null;
        if (!valid()) continue;
        const visible = new Set(page?.items.map(failureKey));
        const keep = <T>(values: Readonly<Record<string, T>>) => Object.fromEntries(
          Object.entries(values).filter(([key]) => visible.has(key) || key in this.state.pending),
        );
        this.publish({ summary, ...(open ? { page, messages: keep(this.state.messages), retries: keep(this.state.retries) } : {}),
          error: null, loading: false });
      } catch (err) {
        if (valid()) this.publish({ error: failureErrorText(err), loading: false });
      } finally { if (this.reads === signal) this.reads = null; }
    }
  }
  setOpen = (open: boolean) => {
    if (!this.current()) return;
    this.invalidate(); this.publish({ open }); void this.refresh();
  };
  firstPage = () => this.navigate(null, []);
  nextPage = () => {
    if (!this.current() || !this.state.page?.nextCursor || this.state.previous.length >= 100) return;
    this.navigate(this.state.page.nextCursor, [...this.state.previous, this.state.before]);
  };
  previousPage = () => {
    if (!this.current() || !this.state.previous.length) return;
    const stack = this.state.previous;
    this.navigate(stack[stack.length - 1], stack.slice(0, -1));
  };
  private navigate(before: string | null, previous: readonly (string | null)[]) {
    if (!this.current()) return;
    this.invalidate(); this.publish({ before, previous, page: null, error: null }); void this.refresh();
  }

  acknowledge = (row: DelegateFailure) => this.act(row, "ack");
  /** confirmSameIntent is explicit: it can POST, not a promised read-only status query. */
  retry = (row: DelegateFailure, confirmSameIntent = false) => {
    if (!row.retry.available && !confirmSameIntent) return Promise.resolve();
    return this.act(row, "retry");
  };
  private act(row: DelegateFailure, kind: "ack" | "retry"): Promise<void> {
    if (!this.current()) return Promise.resolve();
    const key = failureKey(row), existing = this.actions.get(key);
    if (existing) return existing;
    const signal = new AbortController(); this.writes.add(signal);
    const valid = () => this.current() && !signal.signal.aborted;
    this.invalidate();
    this.publish({ pending: { ...this.state.pending, [key]: kind }, messages: { ...this.state.messages, [key]: "" } });
    const task = (async () => {
      try {
        if (kind === "ack") {
          await delegateFailureApi.acknowledge(this.auth, row, signal.signal);
          if (!valid()) return;
          this.invalidate();
          const page = this.state.page;
          this.publish({ summary: null, page: page ? { ...page, items: page.items.filter(item => failureKey(item) !== key) } : null });
        } else {
          const actionId = await delegateRetryActionId(this.userId, row);
          if (!valid()) return;
          const result = await delegateFailureApi.retry(this.auth, row, actionId, signal.signal);
          if (!valid()) return;
          this.invalidate();
          this.publish({ retries: { ...this.state.retries, [key]: result } });
        }
      } catch (err) {
        if (valid()) this.publish({ messages: { ...this.state.messages, [key]: failureErrorText(err) } });
      } finally {
        this.writes.delete(signal);
        // A cleaned up lifecycle may already own a new operation at the same key.
        if (valid()) {
          this.actions.delete(key);
          const pending = { ...this.state.pending }; delete pending[key]; this.publish({ pending });
          await this.refresh();
        }
      }
    })();
    this.actions.set(key, task);
    return task;
  }
}
