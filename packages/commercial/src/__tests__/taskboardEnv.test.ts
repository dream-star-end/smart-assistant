import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { TASKBOARD_ENABLED_ENV, taskboardContainerEnv } from "../agent-sandbox/taskboardEnv.js";
import { type FlavorIdentity, FlavorIdentityError, type FlavorManifest } from "../flavor/assertFlavor.js";

function identity(flavor: "commercial" | "selfhost"): FlavorIdentity {
  const manifest = {
    schema: 1,
    flavor,
    sourceCommit: "0".repeat(40),
    builder: flavor === "commercial" ? "deploy-v5.sh" : "deploy-v5-selfhost.sh",
    expectedHosts: [],
    expectedRoots: [],
    expectedDbNames: [],
    guardGeneration: 1,
  } as unknown as FlavorManifest;
  return { status: "ok", flavor, manifest, manifestPath: "/tmp/flavor.manifest.json" };
}

describe("taskboardContainerEnv", () => {
  test("commercial flavor injects OC_TASKBOARD_ENABLED=0", () => {
    assert.deepEqual(
      taskboardContainerEnv({ env: {}, identity: () => identity("commercial") }),
      [`${TASKBOARD_ENABLED_ENV}=0`],
    );
  });

  test("selfhost flavor injects nothing (container default = enabled)", () => {
    assert.deepEqual(taskboardContainerEnv({ env: {}, identity: () => identity("selfhost") }), []);
  });

  test("no manifest (dev/tests) injects nothing", () => {
    assert.deepEqual(
      taskboardContainerEnv({ env: {}, identity: () => ({ status: "skipped", reason: "no-manifest" }) }),
      [],
    );
  });

  test("flavor identity error fails closed to =0", () => {
    assert.deepEqual(
      taskboardContainerEnv({
        env: {},
        identity: () => {
          throw new FlavorIdentityError("boom");
        },
      }),
      [`${TASKBOARD_ENABLED_ENV}=0`],
    );
  });

  test("non-flavor errors propagate", () => {
    assert.throws(
      () =>
        taskboardContainerEnv({
          env: {},
          identity: () => {
            throw new TypeError("unrelated");
          },
        }),
      TypeError,
    );
  });

  test("explicit master env passes through verbatim and beats flavor", () => {
    assert.deepEqual(
      taskboardContainerEnv({ env: { [TASKBOARD_ENABLED_ENV]: "1" }, identity: () => identity("commercial") }),
      [`${TASKBOARD_ENABLED_ENV}=1`],
    );
    assert.deepEqual(
      taskboardContainerEnv({ env: { [TASKBOARD_ENABLED_ENV]: "0" }, identity: () => identity("selfhost") }),
      [`${TASKBOARD_ENABLED_ENV}=0`],
    );
    // 非法值不透传,回落到 flavor 判定
    assert.deepEqual(
      taskboardContainerEnv({ env: { [TASKBOARD_ENABLED_ENV]: "yes" }, identity: () => identity("selfhost") }),
      [],
    );
  });
});
