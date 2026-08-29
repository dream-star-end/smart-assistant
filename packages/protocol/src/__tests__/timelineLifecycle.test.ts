import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EPOCH_BAND,
  deriveProcessKeyFromRecord,
  mintLiveProcessKey,
  packEpoch,
  packTapeSeq,
  streamGenerationFromLineage,
  streamGenerationFromStreamKey,
  timelineIdentity,
  unpackEpoch,
} from "../timelineLifecycle.js";

describe("packEpoch", () => {
  it("keeps any tape epoch above any live epoch", () => {
    const liveMax = packEpoch(EPOCH_BAND.LIVE, 0x3ff, 0xffffffffff, 0);
    const tapeMin = packEpoch(EPOCH_BAND.TAPE, 0, 0, 0);
    assert.equal(tapeMin > liveMax, true);
    assert.equal(Number.isSafeInteger(liveMax), true);
    assert.equal(Number.isSafeInteger(tapeMin), true);
  });

  it("does not use reducerEpoch and is monotonic in seq/exactBit", () => {
    const a = packEpoch(EPOCH_BAND.LIVE, 0, 100, 0);
    const b = packEpoch(EPOCH_BAND.LIVE, 0, 101, 0);
    const c = packEpoch(EPOCH_BAND.LIVE, 0, 101, 1);
    assert.equal(b > a, true);
    assert.equal(c > b, true);
    const unpacked = unpackEpoch(b);
    assert.equal(unpacked.band, EPOCH_BAND.LIVE);
    assert.equal(unpacked.seq, 101);
    assert.equal(unpacked.exactBit, 0);
  });

  it("streamGen beats a smaller generation with a larger seq", () => {
    const oldGen = packEpoch(EPOCH_BAND.LIVE, 0, 101, 0);
    const newGen = packEpoch(EPOCH_BAND.LIVE, 1, 1, 0);
    assert.equal(newGen > oldGen, true);
  });

  it("Range exactBit 0→1 is a strict +1 at the same band/seq", () => {
    const stub = packEpoch(EPOCH_BAND.TAPE, 0, packTapeSeq(2, 7), 0);
    const exact = packEpoch(EPOCH_BAND.TAPE, 0, packTapeSeq(2, 7), 1);
    assert.equal(exact, stub + 1);
  });
});

describe("mintLiveProcessKey", () => {
  it("splits two thinking units even when messageId matches", () => {
    const a = mintLiveProcessKey({
      kind: "thinking",
      seqFirst: 10,
      recordIdFirst: "recA",
      messageId: "mid-1",
      segmentIndex: 0,
      messageIdIndex: 0,
    });
    const b = mintLiveProcessKey({
      kind: "thinking",
      seqFirst: 40,
      recordIdFirst: "recB",
      messageId: "mid-1",
      segmentIndex: 1,
      messageIdIndex: 1,
    });
    assert.equal(a, "msg:mid-1");
    assert.equal(b, "msg:mid-1:seg:1");
    assert.notEqual(a, b);
  });

  it("mints seg:seq:record when thinking has no messageId", () => {
    assert.equal(
      mintLiveProcessKey({
        kind: "thinking",
        seqFirst: 10,
        recordIdFirst: "recA",
        segmentIndex: 0,
      }),
      "seg:10:recA",
    );
  });

  it("keeps the first text unit as the narrative empty key", () => {
    assert.equal(
      mintLiveProcessKey({ kind: "text", seqFirst: 1, segmentIndex: 0 }),
      "",
    );
    assert.equal(
      mintLiveProcessKey({
        kind: "text",
        seqFirst: 9,
        messageId: "mid",
        segmentIndex: 1,
      }),
      "msg:mid:seg:1",
    );
  });
});

describe("deriveProcessKeyFromRecord", () => {
  it("fail-closed to legacy when engine keys are missing", () => {
    assert.equal(
      deriveProcessKeyFromRecord({ role: "thinking" }, "tape-1", 3),
      "legacy:tape-1:3",
    );
  });

  it("copies an existing stamp and prefers runId for agent-group", () => {
    assert.equal(
      deriveProcessKeyFromRecord({ role: "thinking", _timelineProcessKey: "seg:1:r" }),
      "seg:1:r",
    );
    assert.equal(
      deriveProcessKeyFromRecord({ role: "agent-group", _delegateRunId: "run-9" }),
      "run-9",
    );
  });
});

describe("streamGenerationFromLineage", () => {
  it("is 0 for the first stream_key and increments when stream_key changes", () => {
    const lineage = ["dispatch:a:1", "dispatch:b:1"];
    assert.equal(streamGenerationFromLineage(lineage, ["dispatch:a:1"]), 0);
    assert.equal(streamGenerationFromLineage(lineage, ["dispatch:b:1"]), 1);
  });

  it("lets a later stream_key beat seq=101 of an older generation", () => {
    const oldGen = packEpoch(EPOCH_BAND.LIVE, streamGenerationFromLineage(["s1"], ["s1"]), 101, 0);
    const newGen = packEpoch(EPOCH_BAND.LIVE, streamGenerationFromLineage(["s1", "s2"], ["s2"]), 1, 0);
    assert.equal(newGen > oldGen, true);
  });

  it("caps at 10 bits", () => {
    const keys = Array.from({ length: 2000 }, (_v, i) => `s${i}`);
    assert.equal(streamGenerationFromLineage(keys, [`s${1999}`]), 0x3ff);
  });
});

describe("streamGenerationFromStreamKey", () => {
  it("maps dispatch attempt_no onto 0-based generation", () => {
    assert.equal(streamGenerationFromStreamKey("dispatch:00000000-0000-4000-8000-000000000001:1"), 0);
    assert.equal(streamGenerationFromStreamKey("dispatch:00000000-0000-4000-8000-000000000001:3"), 2);
    assert.equal(streamGenerationFromStreamKey("legacy:1:agent:main"), 0);
  });
});

describe("timelineIdentity", () => {
  it("includes role so tool and agent-group never collide", () => {
    const owner = "cm-1";
    assert.notEqual(
      timelineIdentity(owner, "tool", "b1"),
      timelineIdentity(owner, "agent-group", "b1"),
    );
  });
});
