/**
 * Egress → master cost receipt transport.
 *
 * Persist events are written to a fsync'd file-per-event outbox before the
 * proxy hook resolves. They have no TTL and no overflow eviction: a billed
 * turn's refresh-visible cost component remains until master acknowledges it.
 * Broadcast events are live UX hints only and stay in memory. FIFO single-
 * event sends keep persist-before-broadcast ordering and make persist retries
 * idempotent without replaying a whole mixed batch.
 */

import { randomBytes } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { request as undiciRequest } from "undici";

import { paths } from "@openclaude/storage";

import { rootLogger, type Logger } from "../logging/logger.js";
import {
  COST_EVENT_PATH,
  EGRESS_SECRET_HEADER,
  type CostEvent,
  type CostEventBroadcast,
  type CostEventPersist,
} from "../http/internalCostEvent.js";

const BASE_RETRY_MS = 1_000;
const MAX_RETRY_MS = 10_000;
const ATTEMPT_TIMEOUT_MS = 5_000;

interface QueuedEvent {
  ev: CostEvent;
  enqueuedAt: number;
  /** Present only for fsync'd persist events. */
  receipt?: string;
}

interface DurableCostEventFile {
  schemaVersion: 1;
  ev: CostEventPersist;
  enqueuedAt: number;
}

export interface CostEventSinkOpts {
  /** master 控制口 base,如 http://127.0.0.1:18894 */
  controlBaseUrl: string;
  secret: string;
  logger?: Logger;
  fetcher?: typeof undiciRequest;
  now?: () => number;
  /** Override only for tests. */
  dir?: string;
}

/**
 * egress /healthz compatibility counters. Drop counters remain in the wire
 * shape so deploy tooling can verify they stay exactly zero after the
 * lossless policy removed TTL and queue-overflow deletion.
 */
export interface CostSinkHealthCounters {
  pendingCostEvents: number;
  enqueuedTotal: number;
  sentTotal: number;
  expiredDropsTotal: number;
  overflowDropsTotal: number;
  oldestPendingAgeMs: number;
}

export class CostEventSink {
  private readonly queue: QueuedEvent[] = [];
  private readonly log: Logger;
  private readonly fetcher: typeof undiciRequest;
  private readonly now: () => number;
  private readonly dir: string;
  private sending = false;
  private inflightPump: Promise<void> | null = null;
  private initPromise: Promise<void> | null = null;
  private retryMs = BASE_RETRY_MS;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private enqueuedTotal = 0;
  private sentTotal = 0;

  constructor(private readonly opts: CostEventSinkOpts) {
    this.log = (opts.logger ?? rootLogger).child({ subsys: "costEventSink" });
    this.fetcher = opts.fetcher ?? undiciRequest;
    this.now = opts.now ?? Date.now;
    this.dir = opts.dir ?? join(paths.home, "v5-egress-cost-retry.d");
  }

  /** Load every durable persist receipt before accepting proxy traffic. */
  init(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.loadDurableQueue();
    return this.initPromise;
  }

  /** Live-only broadcast. The corresponding persist event is queued first. */
  enqueue(ev: CostEventBroadcast): void {
    if (this.stopped) return;
    this.queue.push({ ev, enqueuedAt: this.now() });
    this.enqueuedTotal += 1;
    void this.pump();
  }

  /** Fsync a billed-turn cost component before returning to the proxy hook. */
  async enqueueDurable(ev: CostEventPersist): Promise<void> {
    if (this.stopped) throw new Error("cost event sink is stopped");
    await this.init();
    const enqueuedAt = this.now();
    const receipt = `${enqueuedAt}-${randomBytes(8).toString("hex")}.json`;
    await this.atomicWriteJson(join(this.dir, receipt), {
      schemaVersion: 1,
      ev,
      enqueuedAt,
    } satisfies DurableCostEventFile);
    this.queue.push({ ev, enqueuedAt, receipt });
    this.enqueuedTotal += 1;
    void this.pump();
  }

  /** Join the current attempt and run one more pass. Failure leaves receipts. */
  async flush(): Promise<void> {
    await this.init();
    if (this.inflightPump) await this.inflightPump;
    await this.pump();
    if (this.inflightPump) await this.inflightPump;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  get pending(): number {
    return this.queue.length;
  }

  healthCounters(): CostSinkHealthCounters {
    const oldestPendingAgeMs =
      this.queue.length > 0 ? Math.max(0, this.now() - this.queue[0]!.enqueuedAt) : 0;
    return {
      pendingCostEvents: this.queue.length,
      enqueuedTotal: this.enqueuedTotal,
      sentTotal: this.sentTotal,
      expiredDropsTotal: 0,
      overflowDropsTotal: 0,
      oldestPendingAgeMs,
    };
  }

  private async loadDurableQueue(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const names = (await readdir(this.dir))
      .filter((name) => name.endsWith(".json") && !name.includes(".tmp-"))
      .sort();
    for (const receipt of names) {
      const filepath = join(this.dir, receipt);
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(filepath, "utf8"));
      } catch (err) {
        this.log.warn("cost_event_durable_file_malformed_quarantined", {
          receipt,
          err: (err as Error).message,
        });
        await this.quarantine(filepath, "malformed");
        continue;
      }
      if (!isDurableCostEventFile(parsed)) {
        this.log.warn("cost_event_durable_file_schema_quarantined", { receipt });
        await this.quarantine(filepath, "schema");
        continue;
      }
      this.queue.push({ ev: parsed.ev, enqueuedAt: parsed.enqueuedAt, receipt });
      this.enqueuedTotal += 1;
    }
    await this.fsyncDir();
    if (this.queue.length > 0) void this.pump();
  }

  private scheduleRetry(): void {
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pump();
    }, this.retryMs);
    this.timer.unref?.();
    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
  }

  private pump(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inflightPump) return this.inflightPump;
    this.inflightPump = this.pumpLoop().finally(() => {
      this.inflightPump = null;
    });
    return this.inflightPump;
  }

  private async pumpLoop(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queue.length > 0) {
        // One event per request: a persist retry is idempotent, and a live
        // broadcast is never replayed merely because a later persist failed.
        const item = this.queue[0]!;
        try {
          const r = await this.fetcher(`${this.opts.controlBaseUrl}${COST_EVENT_PATH}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              [EGRESS_SECRET_HEADER]: this.opts.secret,
            },
            body: JSON.stringify({ events: [item.ev] }),
            headersTimeout: ATTEMPT_TIMEOUT_MS,
            bodyTimeout: ATTEMPT_TIMEOUT_MS,
          });
          await r.body.text().catch(() => "");
          if (r.statusCode !== 200) throw new Error(`HTTP ${r.statusCode}`);
          if (item.receipt) {
            await this.unlinkIgnoreEnoent(join(this.dir, item.receipt));
            await this.fsyncDir();
          }
          this.queue.shift();
          this.sentTotal += 1;
          this.retryMs = BASE_RETRY_MS;
        } catch (err) {
          this.log.warn("cost_event_send_failed_will_retry", {
            pending: this.queue.length,
            kind: item.ev.kind,
            durable: item.receipt !== undefined,
            err: (err as Error).message,
          });
          this.scheduleRetry();
          return;
        }
      }
    } finally {
      this.sending = false;
    }
  }

  private async atomicWriteJson(filepath: string, value: DurableCostEventFile): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${filepath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    const fh = await open(tmp, "w");
    try {
      await fh.writeFile(JSON.stringify(value), "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, filepath);
    await this.fsyncDir();
  }

  private async fsyncDir(): Promise<void> {
    const fh = await open(this.dir, "r");
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  private async quarantine(filepath: string, reason: string): Promise<void> {
    try {
      await rename(filepath, `${filepath}.quarantine-${reason}-${this.now()}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  private async unlinkIgnoreEnoent(filepath: string): Promise<void> {
    try {
      await unlink(filepath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}

function isDurableCostEventFile(value: unknown): value is DurableCostEventFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  if (obj.schemaVersion !== 1 || typeof obj.enqueuedAt !== "number" || !Number.isFinite(obj.enqueuedAt)) {
    return false;
  }
  const ev = obj.ev;
  if (!ev || typeof ev !== "object" || Array.isArray(ev)) return false;
  const event = ev as Record<string, unknown>;
  return event.kind === "persist" &&
    typeof event.requestId === "string" &&
    typeof event.uid === "string" && /^\d+$/.test(event.uid) &&
    typeof event.costCredits === "string" && /^\d+$/.test(event.costCredits) &&
    (event.turnKey === undefined || event.turnKey === null ||
      (typeof event.turnKey === "string" && /^[0-9a-f]{64}$/.test(event.turnKey))) &&
    (event.parentTurnKey === undefined || event.parentTurnKey === null ||
      (typeof event.parentTurnKey === "string" && /^[0-9a-f]{64}$/.test(event.parentTurnKey)));
}
