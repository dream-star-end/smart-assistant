import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  classifyDockerInspect,
  classifyDockerOrphan,
} from "../v5-model-authority-container-rollback.js";

const labels = {
  "com.openclaude.v3.managed": "1",
  "com.openclaude.runtime_channel": "v5",
  "com.openclaude.v3.uid": "42",
};

describe("v5 model-authority Docker census", () => {
  test("missing Env or Running is unknown rather than unflagged/stopped", () => {
    assert.deepEqual(
      classifyDockerInspect("cid", {
        Config: { Labels: labels },
        State: { Running: true },
      }),
      { kind: "unknown" },
    );
    assert.deepEqual(
      classifyDockerInspect("cid", {
        Config: { Env: ["OC_MODEL_AUTHORITY=1"], Labels: labels },
        State: {},
      }),
      { kind: "unknown" },
    );
  });

  test("Docker-only flagged orphan remains a running drain target after DB row vanished", () => {
    const observation = classifyDockerInspect("cid", {
      Id: "cid",
      Config: {
        Env: ["OC_MODEL_AUTHORITY=1", "OC_CONTAINER_ID=7", "OC_USER_ID=42"],
        Labels: labels,
      },
      State: { Running: true },
      NetworkSettings: { Networks: { "openclaude-v5-net": { IPAddress: "172.31.0.17" } } },
    });
    assert.equal(observation.kind, "known");
    if (observation.kind !== "known") return;
    const target = classifyDockerOrphan(observation);
    assert.equal(target.id, "docker:cid");
    assert.equal(target.state, "flagged_running");
    assert.equal(target.cleanupMode, "docker");
    assert.equal(target.status?.containerId, 7);
    assert.equal(target.status?.boundIp, "172.31.0.17");
  });

  test("running orphan with uncertain authenticated-drain identity is unknown", () => {
    const observation = classifyDockerInspect("cid", {
      Config: { Env: ["OC_MODEL_AUTHORITY=1"], Labels: labels },
      State: { Running: true },
      NetworkSettings: { Networks: { "openclaude-v5-net": { IPAddress: "172.31.0.17" } } },
    });
    assert.equal(observation.kind, "known");
    if (observation.kind !== "known") return;
    assert.equal(classifyDockerOrphan(observation).state, "unknown");
  });
});
