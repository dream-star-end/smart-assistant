/**
 * Side effects for the G8 replay checkpoint.
 * Production startup does not call installG8ReplayCheckpoint, so the check
 * stays off: no metric sample, no log line, no outbox row, no session stop.
 * Installing it records through the existing metric and logger, and a severe
 * verdict goes to the existing alert outbox only.
 */
import {
  runG8ReplayCheckpoint,
  setG8ReplayCheckpoint,
  type G8ReplayVerdict,
} from "@openclaude/protocol";

import { rootLogger } from "../logging/logger.js";
import { EVENTS } from "./alertEvents.js";
import { safeEnqueueAlert, type AlertEventInput } from "./alertOutbox.js";
import { incG8ReplayCheck } from "./metrics.js";

const log = rootLogger.child({ subsys: "g8-replay" });
const BUCKET_MS = 15 * 60 * 1000;

export interface G8ReplayPorts {
  record(verdict: G8ReplayVerdict): void;
  alert(event: AlertEventInput): void;
  now(): number;
}

/** Operator alert. Null when the verdict is not severe. Never a stop action. */
export function g8ReplayAlertEvent(
  verdict: G8ReplayVerdict,
  nowMs: number,
): AlertEventInput | null {
  if (!verdict.alert) return null;
  const trace = verdict.traceId;
  const bucket = Math.floor(nowMs / BUCKET_MS);
  const traceLine = trace
    ? `npx tsx scripts/oc-trace.ts ${trace}`
    : "无 trace";
  return {
    event_type: EVENTS.OPS_G8_REPLAY_SEVERE,
    severity: verdict.severity === "critical" ? "critical" : "warning",
    title: "回放检查发现需人工看的问题",
    body: [
      `point=${verdict.point}`,
      `verdict=${verdict.verdict}`,
      `reason=${verdict.reason}`,
      traceLine,
    ].join("\n"),
    dedupe_key: [
      EVENTS.OPS_G8_REPLAY_SEVERE,
      verdict.point,
      verdict.verdict,
      trace ?? "none",
      String(bucket),
    ].join(":"),
    payload: {
      point: verdict.point,
      verdict: verdict.verdict,
      reason: verdict.reason,
      traceId: trace,
    },
  };
}

export function deliverG8Replay(verdict: G8ReplayVerdict, ports: G8ReplayPorts): void {
  ports.record(verdict);
  const event = g8ReplayAlertEvent(verdict, ports.now());
  if (event) ports.alert(event);
}

export function defaultG8ReplayPorts(): G8ReplayPorts {
  return {
    record(verdict) {
      incG8ReplayCheck(verdict.point, verdict.verdict);
      log.info("g8_replay_check", {
        traceId: verdict.traceId,
        point: verdict.point,
        verdict: verdict.verdict,
        severity: verdict.severity,
        reason: verdict.reason,
      });
    },
    alert(event) {
      safeEnqueueAlert(event);
    },
    now: () => Date.now(),
  };
}

/**
 * Arms the checkpoint. Not called from startup in this slice, so the
 * default remains off. A listener failure cannot stop a session: the
 * runner swallows it, and this function has no stop or billing call.
 */
export function installG8ReplayCheckpoint(
  ports: G8ReplayPorts = defaultG8ReplayPorts(),
): void {
  setG8ReplayCheckpoint((verdict) => {
    deliverG8Replay(verdict, ports);
  });
}

export { runG8ReplayCheckpoint };
