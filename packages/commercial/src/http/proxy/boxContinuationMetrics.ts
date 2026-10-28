/** No request content, IDs, or caller-defined label values enter these metrics. */
import { boxContinuationCompatibility, boxContinuationRejections } from "../../admin/metrics.js";
import { BOX_CONTINUATION_REJECTION_REASONS, observeDurableHistogram } from "../../admin/durableMetricRollups.js";
import { rootLogger } from "../../logging/logger.js";

const log = rootLogger.child({ subsys: "box-continuation" });
export type BoxContinuationStage = "admission" | "claim" | "echo";
export type BoxCompatibilityReason = "envelope" | "opaque_content";

export function recordBoxContinuationCompatibility(stage: BoxContinuationStage,
  reason: BoxCompatibilityReason): void {
  boxContinuationCompatibility.inc({ stage, reason });
  observeDurableHistogram("box_continuation_decisions", `${stage}:compatible:${reason}`, [], 1);
  log.warn("box_continuation_shape_compatible", { stage, reason });
}

export function recordBoxContinuationRejection(stage: BoxContinuationStage, code: string): void {
  const reason = BOX_CONTINUATION_REJECTION_REASONS.has(code) ? code : "other";
  boxContinuationRejections.inc({ stage, reason });
  observeDurableHistogram("box_continuation_decisions", `${stage}:rejected:${reason}`, [], 1);
  log.warn("box_continuation_rejected", { stage, reason });
}
