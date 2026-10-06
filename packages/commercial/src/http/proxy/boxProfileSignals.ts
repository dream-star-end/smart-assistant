/** What a Box Claude run says about the login it ran under, read from the
 * stream-json lines the CLI prints. Pure text parsing, no credentials: the
 * CLI never prints any. Real shapes (Claude Code 2.1.288, 2026-10-06):
 *   {"type":"rate_limit_event","rate_limit_info":{"status":"rejected",
 *     "resetsAt":1791300000,"rateLimitType":"five_hour",
 *     "unifiedWindows":{"five_hour":{"utilization":1.04,"resetsAt":...},
 *       "seven_day":{"utilization":0.4,"resetsAt":...}}}}
 *   {"type":"assistant","message":{"model":"<synthetic>","content":[{"type":"text",
 *     "text":"You've hit your session limit · resets 11:20pm (Asia/Taipei)"}]}}
 *   {"type":"assistant","message":{"model":"<synthetic>","content":[{"type":"text",
 *     "text":"Not logged in · Please run /login"}]}} */

export type BoxProfileSignal =
  | { kind: "rate_limit"; status: "allowed" | "allowed_warning" | "rejected" | "other";
      /** Highest utilization over the reported windows, 0..1+ (null: not reported). */
      utilization: number | null; resetsAtMs: number | null }
  | { kind: "login_required" }
  /** Set by the Box-side guard, not read from a stream: the login no longer meets the safety checks. */
  | { kind: "profile_unsafe" };

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseLine(line: string): BoxProfileSignal | null {
  if (line.length < 20 || line.length > 65_536) return null;
  const rate = line.includes('"rate_limit_event"');
  const synthetic = line.includes("<synthetic>");
  if (!rate && !synthetic) return null;
  let record: unknown;
  try { record = JSON.parse(line); } catch { return null; }
  if (!record || typeof record !== "object") return null;
  const top = record as { type?: unknown; rate_limit_info?: unknown; message?: unknown };
  if (top.type === "rate_limit_event") {
    const info = top.rate_limit_info;
    if (!info || typeof info !== "object") return null;
    const body = info as { status?: unknown; resetsAt?: unknown; utilization?: unknown;
      unifiedWindows?: unknown };
    const status = body.status === "allowed" || body.status === "allowed_warning"
      || body.status === "rejected" ? body.status : "other";
    let utilization = num(body.utilization);
    let resetsAt = num(body.resetsAt);
    const windows = body.unifiedWindows;
    if (windows && typeof windows === "object") {
      for (const value of Object.values(windows as Record<string, unknown>)) {
        if (!value || typeof value !== "object") continue;
        const window = value as { utilization?: unknown; resetsAt?: unknown };
        const used = num(window.utilization);
        if (used !== null && (utilization === null || used > utilization)) {
          utilization = used;
          // The binding window's reset is the one that matters for a rejection.
          if (status === "rejected" || resetsAt === null) resetsAt = num(window.resetsAt) ?? resetsAt;
        }
      }
    }
    return { kind: "rate_limit", status, utilization,
      resetsAtMs: resetsAt === null ? null : Math.round(resetsAt * 1000) };
  }
  if (top.type === "assistant" && top.message && typeof top.message === "object") {
    const message = top.message as { model?: unknown; content?: unknown };
    if (message.model !== "<synthetic>" || !Array.isArray(message.content)) return null;
    for (const block of message.content) {
      const text = block && typeof block === "object" ? (block as { text?: unknown }).text : null;
      if (typeof text === "string" && /^Not logged in\b/.test(text)) return { kind: "login_required" };
    }
  }
  return null;
}

/** Signals found in one stdout chunk, in order. A line cut by a chunk boundary
 * is skipped; every run repeats these lines, so a miss only delays learning. */
export function readBoxProfileSignals(chunk: string): BoxProfileSignal[] {
  if (!chunk.includes("rate_limit_event") && !chunk.includes("<synthetic>")) return [];
  const found: BoxProfileSignal[] = [];
  for (const line of chunk.split("\n")) {
    const signal = parseLine(line);
    if (signal) found.push(signal);
  }
  return found;
}

/** Reassembles stdout chunks into whole lines (Box Exec splits them anywhere) and reports the signals
 * in each complete line. The unfinished tail is held (capped) and read by `end()`. */
export class BoxProfileSignalTap {
  private tail = "";
  constructor(private readonly onSignal: (signal: BoxProfileSignal) => void) {}
  push(chunk: string): void {
    const text = this.tail + chunk;
    const cut = text.lastIndexOf("\n");
    if (cut < 0) { this.tail = text.length > 65_536 ? "" : text; return; }
    this.tail = text.slice(cut + 1).length > 65_536 ? "" : text.slice(cut + 1);
    for (const signal of readBoxProfileSignals(text.slice(0, cut + 1))) this.onSignal(signal);
  }
  end(): void {
    const rest = this.tail;
    this.tail = "";
    for (const signal of readBoxProfileSignals(rest)) this.onSignal(signal);
  }
}
