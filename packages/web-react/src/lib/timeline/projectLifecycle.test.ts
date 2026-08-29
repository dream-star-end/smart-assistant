import { describe, expect, test } from "vitest";
import { EPOCH_BAND, packEpoch, timelineIdentity } from "@openclaude/protocol";
import type { ChatMessage } from "../chat/model";
import {
  identityOf,
  lifecycleOf,
  projectTimeline,
} from "./projectLifecycle";

const OWNER = "cm-1";

function row(partial: Partial<ChatMessage> & Pick<ChatMessage, "id" | "role">): ChatMessage {
  return {
    text: "",
    ts: 1,
    _clientMessageId: OWNER,
    ...partial,
  };
}

function stamped(
  partial: Partial<ChatMessage> & Pick<ChatMessage, "id" | "role">,
  lifecycle: ChatMessage["_lifecycle"],
  processKey: string,
  epoch: number,
): ChatMessage {
  return row({
    ...partial,
    _lifecycle: lifecycle,
    _lifecycleEpoch: epoch,
    _timelineProcessKey: processKey,
    _timelineIdentity: timelineIdentity(OWNER, partial.role, processKey),
  });
}

describe("projectTimeline dual-slot (B1)", () => {
  test("A1/A2/A4: live + deferred without exact keeps both slots", () => {
    const live = stamped(
      { id: "live-ag", role: "agent-group", text: "rich live", _delegateRunId: "run-1" },
      "live_closed",
      "run-1",
      packEpoch(EPOCH_BAND.LIVE, 0, 10, 0),
    );
    const stub = stamped(
      {
        id: "tape-ag",
        role: "agent-group",
        text: "",
        _payloadDeferred: true,
        _source: "server",
        _delegateRunId: "run-1",
      },
      "exact_deferred",
      "run-1",
      packEpoch(EPOCH_BAND.TAPE, 0, 12, 0),
    );
    const out = projectTimeline([live, stub]);
    const same = out.filter((m) => identityOf(m) === identityOf(live));
    expect(same).toHaveLength(2);
    expect(same.some((m) => lifecycleOf(m) === "live_closed" && m.text === "rich live")).toBe(true);
    expect(same.some((m) => lifecycleOf(m) === "exact_deferred")).toBe(true);
    expect(out.some((m) => m.id === "live-ag")).toBe(true);
  });

  test("A3: exact_displayable converges the identity to one row", () => {
    const live = stamped(
      { id: "live-ag", role: "agent-group", text: "rich live", _delegateRunId: "run-1" },
      "live_closed",
      "run-1",
      packEpoch(EPOCH_BAND.LIVE, 0, 10, 0),
    );
    const stub = stamped(
      { id: "tape-ag", role: "agent-group", text: "", _payloadDeferred: true, _delegateRunId: "run-1" },
      "exact_deferred",
      "run-1",
      packEpoch(EPOCH_BAND.TAPE, 0, 12, 0),
    );
    const exact = stamped(
      { id: "exact-ag", role: "agent-group", text: "full body", _source: "server", _delegateRunId: "run-1" },
      "exact_displayable",
      "run-1",
      packEpoch(EPOCH_BAND.TAPE, 0, 12, 1),
    );
    const out = projectTimeline([live, stub, exact]);
    const same = out.filter((m) => identityOf(m) === identityOf(live));
    expect(same).toHaveLength(1);
    expect(lifecycleOf(same[0]!)).toBe("exact_displayable");
    expect(same[0]!.id).toBe("exact-ag");
  });

  test("1MiB×6: six live cards plus six stubs", () => {
    const input: ChatMessage[] = [];
    for (let i = 0; i < 6; i++) {
      const key = `run-${i}`;
      input.push(stamped(
        { id: `live-${i}`, role: "agent-group", text: `live-${i}`, _delegateRunId: key },
        "live_closed",
        key,
        packEpoch(EPOCH_BAND.LIVE, 0, 10 + i, 0),
      ));
      input.push(stamped(
        { id: `stub-${i}`, role: "agent-group", text: "", _payloadDeferred: true, _delegateRunId: key },
        "exact_deferred",
        key,
        packEpoch(EPOCH_BAND.TAPE, 0, 20 + i, 0),
      ));
    }
    const out = projectTimeline(input);
    expect(out.filter((m) => m.id.startsWith("live-"))).toHaveLength(6);
    expect(out.filter((m) => m.id.startsWith("stub-"))).toHaveLength(6);
  });
});

describe("projectTimeline processKey (B2)", () => {
  test("two thinking segments split by a tool stay two identities", () => {
    const thinkA = stamped(
      { id: "th-a", role: "thinking", text: "A" },
      "live_closed",
      "seg:10:recA",
      packEpoch(EPOCH_BAND.LIVE, 0, 10, 0),
    );
    const tool = stamped(
      { id: "tool-1", role: "tool", text: "", blockId: "b1" },
      "live_closed",
      "b1",
      packEpoch(EPOCH_BAND.LIVE, 0, 20, 0),
    );
    const thinkB = stamped(
      { id: "th-b", role: "thinking", text: "B" },
      "live_closed",
      "seg:40:recB",
      packEpoch(EPOCH_BAND.LIVE, 0, 40, 0),
    );
    const exactA = stamped(
      { id: "ex-a", role: "thinking", text: "A", _source: "server" },
      "exact_displayable",
      "seg:10:recA",
      packEpoch(EPOCH_BAND.TAPE, 0, 1, 1),
    );
    const exactB = stamped(
      { id: "ex-b", role: "thinking", text: "B", _source: "server" },
      "exact_displayable",
      "seg:40:recB",
      packEpoch(EPOCH_BAND.TAPE, 0, 3, 1),
    );
    const out = projectTimeline([thinkA, tool, thinkB, exactA, exactB]);
    expect(out.filter((m) => m.role === "thinking")).toHaveLength(2);
    expect(out.some((m) => m.id === "ex-a")).toBe(true);
    expect(out.some((m) => m.id === "ex-b")).toBe(true);
    expect(out.some((m) => m.id === "th-a" || m.id === "th-b")).toBe(false);
  });
});

describe("projectTimeline epoch (B3)", () => {
  test("seqLast=101 wins over a later seqLast=100 snapshot", () => {
    const newer = stamped(
      { id: "th-101", role: "thinking", text: "AB" },
      "live_open",
      "seg:1:r",
      packEpoch(EPOCH_BAND.LIVE, 0, 101, 0),
    );
    const older = stamped(
      { id: "th-100", role: "thinking", text: "A" },
      "live_open",
      "seg:1:r",
      packEpoch(EPOCH_BAND.LIVE, 0, 100, 0),
    );
    const out = projectTimeline([newer, older]);
    const thinking = out.filter((m) => m.role === "thinking");
    expect(thinking).toHaveLength(1);
    expect(thinking[0]!.text).toBe("AB");
    expect(thinking[0]!.id).toBe("th-101");
  });

  test("equal-epoch overlay refuses to shorten text", () => {
    const epoch = packEpoch(EPOCH_BAND.LIVE, 0, 50, 0);
    const long = stamped(
      { id: "th-long", role: "thinking", text: "ABCDEF" },
      "live_open",
      "k",
      epoch,
    );
    const short = stamped(
      { id: "th-short", role: "thinking", text: "AB" },
      "live_open",
      "k",
      epoch,
    );
    const out = projectTimeline([long, short]);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe("ABCDEF");
  });

  test("streamGen+1 with seq=1 beats old gen seq=101", () => {
    const oldGen = stamped(
      { id: "old", role: "thinking", text: "OLD" },
      "live_open",
      "k",
      packEpoch(EPOCH_BAND.LIVE, 0, 101, 0),
    );
    const newGen = stamped(
      { id: "new", role: "thinking", text: "NEW" },
      "live_open",
      "k",
      packEpoch(EPOCH_BAND.LIVE, 1, 1, 0),
    );
    const out = projectTimeline([oldGen, newGen]);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe("NEW");
  });

  test("runtime-event legacy keys include logicalIndex and do not merge", () => {
    const a = stamped(
      { id: "e0", role: "runtime-event", text: "one" },
      "exact_displayable",
      "legacy:tape:8:0",
      packEpoch(EPOCH_BAND.TAPE, 0, 8, 1),
    );
    const b = stamped(
      { id: "e1", role: "runtime-event", text: "two" },
      "exact_displayable",
      "legacy:tape:8:1",
      packEpoch(EPOCH_BAND.TAPE, 0, 8, 1),
    );
    const out = projectTimeline([a, b]);
    expect(out.filter((row) => row.role === "runtime-event")).toHaveLength(2);
  });
});
