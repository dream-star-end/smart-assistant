import { createHash, randomUUID } from "node:crypto";
import { tx } from "../db/queries.js";
import { controlPlaneIdentity } from "./observabilityIdentity.js";

const FIVE_MINUTES_MS = 5 * 60_000;
const FLUSH_INTERVAL_MS = 60_000;
const MAX_SERIES_PER_BUCKET = 256;
const MAX_KEPT_BUCKETS = 2;

export type DurableHistogramMetric =
  | "anthropic_proxy_ttft_seconds"
  | "anthropic_proxy_stream_duration_seconds"
  | "container_ensure_duration_seconds"
  | "ws_bridge_ttft_seconds";

type MetricSpec = {
  labelName: "family" | "kind";
  allowedValues: ReadonlySet<string>;
};

const MODEL_FAMILIES = new Set([
  "claude", "gpt", "deepseek", "glm", "qwen", "kimi", "minimax",
  "cursor", "grok", "zcode", "other",
]);
const COLD_WARM = new Set(["cold", "warm"]);

const SPECS: Record<DurableHistogramMetric, MetricSpec> = {
  anthropic_proxy_ttft_seconds: { labelName: "family", allowedValues: MODEL_FAMILIES },
  anthropic_proxy_stream_duration_seconds: { labelName: "family", allowedValues: MODEL_FAMILIES },
  container_ensure_duration_seconds: { labelName: "kind", allowedValues: COLD_WARM },
  ws_bridge_ttft_seconds: { labelName: "kind", allowedValues: COLD_WARM },
};

type RollupEntry = {
  bucketStartMs: number;
  metric: DurableHistogramMetric;
  labels: Record<string, string>;
  labelsHash: string;
  bounds: readonly number[];
  counts: number[];
  sampleCount: number;
  sampleSum: number;
  sampleMin: number;
  sampleMax: number;
  version: number;
};

type Snapshot = RollupEntry & { version: number };

const processRunId = randomUUID();
const processStartedBucketMs = bucketStart(Date.now());
const entries = new Map<string, RollupEntry>();
let flushTimer: NodeJS.Timeout | null = null;
let flushInFlight: Promise<void> | null = null;
let droppedSeriesTotal = 0;
let lastPersistedDroppedSeriesTotal = 0;
let lastDropWarnAt = 0;

function enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OC_DURABLE_METRIC_ROLLUPS === "1";
}

function bucketStart(nowMs: number): number {
  return Math.floor(nowMs / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
}

function modelFamily(model: string): string {
  const value = model.trim().toLowerCase();
  const family = value.startsWith("claude") ? "claude"
    : value.startsWith("gpt") ? "gpt"
    : value.startsWith("deepseek") ? "deepseek"
    : value.startsWith("glm") ? "glm"
    : value.startsWith("qwen") ? "qwen"
    : value.startsWith("kimi") || value.startsWith("k3") ? "kimi"
    : value.startsWith("minimax") ? "minimax"
    : value.startsWith("cursor") ? "cursor"
    : value.startsWith("grok") ? "grok"
    : value.startsWith("zcode") ? "zcode"
    : "other";
  return MODEL_FAMILIES.has(family) ? family : "other";
}

function normalizeLabel(metric: DurableHistogramMetric, raw: string): Record<string, string> {
  const spec = SPECS[metric];
  const candidate = spec.labelName === "family" ? modelFamily(raw) : raw;
  return {
    [spec.labelName]: spec.allowedValues.has(candidate)
      ? candidate
      : spec.labelName === "family" ? "other" : "warm",
  };
}

function labelsKey(labels: Record<string, string>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))),
  );
}

function seriesKey(bucketMs: number, metric: string, hash: string): string {
  return `${bucketMs}:${metric}:${hash}`;
}

function countSeriesForBucket(bucketMs: number): number {
  let count = 0;
  for (const entry of entries.values()) if (entry.bucketStartMs === bucketMs) count += 1;
  return count;
}

function noteDroppedSeries(nowMs: number): void {
  droppedSeriesTotal += 1;
  scheduleFlush();
  if (nowMs - lastDropWarnAt < 60_000) return;
  lastDropWarnAt = nowMs;
  console.warn("[durableMetricRollups] observation data dropped before durable flush", {
    cap: MAX_SERIES_PER_BUCKET,
    droppedSeriesTotal,
  });
}

function scheduleFlush(): void {
  if (flushTimer || !enabled()) return;
  flushTimer = setInterval(() => {
    void flushDurableMetricRollups().catch((err) => {
      console.warn("[durableMetricRollups] flush failed", {
        message: err instanceof Error ? err.message : String(err),
      });
    });
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref?.();
}

export function observeDurableHistogram(
  metric: DurableHistogramMetric,
  rawLabelValue: string,
  bounds: readonly number[],
  value: number,
  nowMs = Date.now(),
): boolean {
  if (!enabled() || !Number.isFinite(value) || value < 0) return false;
  const labels = normalizeLabel(metric, rawLabelValue);
  const labelsJson = labelsKey(labels);
  const labelsHash = createHash("sha256").update(labelsJson).digest("hex");
  const bucketMs = bucketStart(nowMs);
  const oldestAllowed = bucketMs - FIVE_MINUTES_MS * (MAX_KEPT_BUCKETS - 1);
  for (const [oldKey, oldEntry] of entries) {
    if (oldEntry.bucketStartMs < oldestAllowed) {
      entries.delete(oldKey);
      // version=0 means the absolute snapshot was already committed. Evicting a
      // clean bucket is normal retention, not telemetry loss.
      if (oldEntry.version > 0) noteDroppedSeries(nowMs);
    }
  }
  const key = seriesKey(bucketMs, metric, labelsHash);
  let entry = entries.get(key);
  if (!entry) {
    if (countSeriesForBucket(bucketMs) >= MAX_SERIES_PER_BUCKET) {
      noteDroppedSeries(nowMs);
      return false;
    }
    entry = {
      bucketStartMs: bucketMs,
      metric,
      labels,
      labelsHash,
      bounds: [...bounds],
      counts: new Array(bounds.length + 1).fill(0),
      sampleCount: 0,
      sampleSum: 0,
      sampleMin: value,
      sampleMax: value,
      version: 0,
    };
    entries.set(key, entry);
  }
  for (let i = 0; i < entry.bounds.length; i += 1) {
    if (value <= entry.bounds[i]!) entry.counts[i]! += 1;
  }
  entry.counts[entry.counts.length - 1]! += 1;
  entry.sampleCount += 1;
  entry.sampleSum += value;
  entry.sampleMin = Math.min(entry.sampleMin, value);
  entry.sampleMax = Math.max(entry.sampleMax, value);
  entry.version += 1;
  scheduleFlush();
  return true;
}

export function durableMetricDroppedSeriesTotal(): number {
  return droppedSeriesTotal;
}

export function durableMetricSnapshotForTest(): Array<{
  metric: DurableHistogramMetric;
  labels: Record<string, string>;
  counts: number[];
  sampleCount: number;
}> {
  return [...entries.values()].map((entry) => ({
    metric: entry.metric,
    labels: { ...entry.labels },
    counts: [...entry.counts],
    sampleCount: entry.sampleCount,
  }));
}

function snapshotEntries(): Snapshot[] {
  return [...entries.values()].filter((entry) => entry.version > 0).map((entry) => ({
    ...entry,
    labels: { ...entry.labels },
    bounds: [...entry.bounds],
    counts: [...entry.counts],
    version: entry.version,
  }));
}

export async function flushDurableMetricRollups(): Promise<void> {
  if (!enabled()) return;
  if (flushInFlight) return flushInFlight;
  const snapshots = snapshotEntries();
  const droppedSnapshot = droppedSeriesTotal;
  const persistDroppedCounter = droppedSnapshot !== lastPersistedDroppedSeriesTotal;
  if (snapshots.length === 0 && !persistDroppedCounter) return;
  const { release, commit } = controlPlaneIdentity();
  const instanceId = (process.env.OC_INSTANCE_ID ?? "unknown").slice(0, 128);
  const slot = (process.env.OC_SLOT ?? "unknown").slice(0, 32);
  const component = process.env.OC_EGRESS_PROCESS === "1" ? "egress" : "master";

  flushInFlight = tx(async (client) => {
    for (const row of snapshots) {
      await client.query(
        `INSERT INTO telemetry_metric_rollups
           (process_run_id,bucket_start,instance_id,slot,component,
            control_plane_release,control_plane_commit,metric,labels_hash,labels,
            histogram_bounds,histogram_counts,sample_count,sample_sum,sample_min,sample_max,
            counter_value,updated_at)
         VALUES ($1,to_timestamp($2/1000.0),$3,$4,$5,$6,$7,$8,$9,$10::jsonb,
                 $11::double precision[],$12::bigint[],$13,$14,$15,$16,0,NOW())
         ON CONFLICT (process_run_id,bucket_start,metric,labels_hash) DO UPDATE SET
           instance_id=EXCLUDED.instance_id, slot=EXCLUDED.slot,
           component=EXCLUDED.component,
           control_plane_release=EXCLUDED.control_plane_release,
           control_plane_commit=EXCLUDED.control_plane_commit,
           labels=EXCLUDED.labels,
           histogram_bounds=EXCLUDED.histogram_bounds,
           histogram_counts=EXCLUDED.histogram_counts,
           sample_count=EXCLUDED.sample_count, sample_sum=EXCLUDED.sample_sum,
           sample_min=EXCLUDED.sample_min, sample_max=EXCLUDED.sample_max,
           updated_at=NOW()`,
        [processRunId, row.bucketStartMs, instanceId, slot, component, release, commit,
          row.metric, row.labelsHash, JSON.stringify(row.labels), row.bounds, row.counts,
          row.sampleCount, row.sampleSum, row.sampleMin, row.sampleMax],
      );
    }
    if (persistDroppedCounter) {
      const emptyLabels = "{}";
      const emptyLabelsHash = createHash("sha256").update(emptyLabels).digest("hex");
      await client.query(
        `INSERT INTO telemetry_metric_rollups
           (process_run_id,bucket_start,instance_id,slot,component,
            control_plane_release,control_plane_commit,metric,labels_hash,labels,
            histogram_bounds,histogram_counts,sample_count,sample_sum,sample_min,sample_max,
            counter_value,updated_at)
         VALUES ($1,to_timestamp($2/1000.0),$3,$4,$5,$6,$7,
                 'telemetry_rollup_dropped_series_total',$8,'{}'::jsonb,
                 NULL,NULL,0,0,NULL,NULL,$9,NOW())
         ON CONFLICT (process_run_id,bucket_start,metric,labels_hash) DO UPDATE SET
           instance_id=EXCLUDED.instance_id, slot=EXCLUDED.slot,
           component=EXCLUDED.component,
           control_plane_release=EXCLUDED.control_plane_release,
           control_plane_commit=EXCLUDED.control_plane_commit,
           counter_value=EXCLUDED.counter_value,
           updated_at=NOW()`,
        [processRunId, processStartedBucketMs, instanceId, slot, component,
          release, commit, emptyLabelsHash, droppedSnapshot],
      );
    }
  }).then(() => {
    if (persistDroppedCounter) lastPersistedDroppedSeriesTotal = droppedSnapshot;
    const currentBucket = bucketStart(Date.now());
    for (const snapshot of snapshots) {
      const key = seriesKey(snapshot.bucketStartMs, snapshot.metric, snapshot.labelsHash);
      const current = entries.get(key);
      if (!current || current.version !== snapshot.version) continue;
      current.version = 0;
      if (snapshot.bucketStartMs < currentBucket) entries.delete(key);
    }
    const oldestAllowed = currentBucket - FIVE_MINUTES_MS * (MAX_KEPT_BUCKETS - 1);
    for (const [key, entry] of entries) {
      if (entry.bucketStartMs < oldestAllowed && entry.version === 0) entries.delete(key);
    }
  }).finally(() => { flushInFlight = null; });
  return flushInFlight;
}

export async function shutdownDurableMetricRollups(): Promise<void> {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = null;
  await flushDurableMetricRollups();
}

export function resetDurableMetricRollupsForTest(): void {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = null;
  flushInFlight = null;
  entries.clear();
  droppedSeriesTotal = 0;
  lastPersistedDroppedSeriesTotal = 0;
  lastDropWarnAt = 0;
}
