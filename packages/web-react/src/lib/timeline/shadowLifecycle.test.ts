import { afterEach, describe, expect, test } from "vitest";
import { EPOCH_BAND, packEpoch, timelineIdentity } from "@openclaude/protocol";
import type { ChatMessage } from "../chat/model";
import {
  observeTimelineShadow,
  resetShadowStatsForTests,
  timelineLifecycleMode,
} from "./shadowLifecycle";

const OWNER = "cm-shadow";

function stamped(
  partial: Partial<ChatMessage> & Pick<ChatMessage, "id" | "role">,
  lifecycle: ChatMessage["_lifecycle"],
  processKey: string,
): ChatMessage {
  return {
    text: "",
    ts: 1,
    _clientMessageId: OWNER,
    _lifecycle: lifecycle,
    _lifecycleEpoch: packEpoch(EPOCH_BAND.LIVE, 0, 1, 0),
    _timelineProcessKey: processKey,
    _timelineIdentity: timelineIdentity(OWNER, partial.role, processKey),
    ...partial,
  };
}

afterEach(() => {
  delete (globalThis as { __OC_TIMELINE_LIFECYCLE_V1?: string }).__OC_TIMELINE_LIFECYCLE_V1;
  delete (globalThis as { __OC_TIMELINE_LIFECYCLE_SHADOW_FORCE?: boolean }).__OC_TIMELINE_LIFECYCLE_SHADOW_FORCE;
  resetShadowStatsForTests();
});

describe("shadow observer", () => {
  test("default mode is off and is a no-op", () => {
    expect(timelineLifecycleMode()).toBe("off");
    const live = stamped({ id: "l", role: "thinking", text: "x" }, "live_open", "k");
    expect(observeTimelineShadow({ entry: "full", input: [live], oldOutput: [live] })).toBeNull();
  });

  test("shadow mode reports zero mismatch when outputs match", () => {
    (globalThis as { __OC_TIMELINE_LIFECYCLE_V1?: string }).__OC_TIMELINE_LIFECYCLE_V1 = "shadow";
    (globalThis as { __OC_TIMELINE_LIFECYCLE_SHADOW_FORCE?: boolean }).__OC_TIMELINE_LIFECYCLE_SHADOW_FORCE = true;
    const live = stamped({ id: "l", role: "thinking", text: "x" }, "live_open", "k");
    const obs = observeTimelineShadow({ entry: "full", input: [live], oldOutput: [live], oldMs: 0.4 });
    expect(obs?.mismatchCount).toBe(0);
    expect(obs?.sampled).toBe(true);
    expect((obs?.totalMs ?? 0) >= (obs?.oldMs ?? 0)).toBe(true);
  });

  test("shadow mode counts a dual-slot vs old-single mismatch", () => {
    (globalThis as { __OC_TIMELINE_LIFECYCLE_V1?: string }).__OC_TIMELINE_LIFECYCLE_V1 = "shadow";
    (globalThis as { __OC_TIMELINE_LIFECYCLE_SHADOW_FORCE?: boolean }).__OC_TIMELINE_LIFECYCLE_SHADOW_FORCE = true;
    const live = stamped({ id: "live", role: "agent-group", text: "rich" }, "live_closed", "run-1");
    const stub = stamped(
      { id: "stub", role: "agent-group", text: "", _payloadDeferred: true },
      "exact_deferred",
      "run-1",
    );
    const obs = observeTimelineShadow({
      entry: "live-units",
      input: [live, stub],
      oldOutput: [stub],
    });
    expect(obs?.mismatchCount).toBeGreaterThan(0);
    expect(obs?.mismatches.some((row) =>
      row.identity.includes("agent-group") && (row.oldText !== row.newText || row.oldKeep !== row.newKeep),
    )).toBe(true);
  });
});
