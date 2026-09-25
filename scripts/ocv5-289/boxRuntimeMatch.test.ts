import test from "node:test";
import assert from "node:assert/strict";
import { runtimeMatches } from "./boxRuntimeMatch.js";
import { RUNTIME_IMAGE_ID_LABEL_KEY, RUNTIME_RELEASE_LABEL_KEY,
  RUNTIME_BUNDLE_REV_LABEL_KEY, RUNTIME_BOOT_HASH_LABEL_KEY } from
  "../../packages/commercial/src/agent-sandbox/platformBundle.js";

const desired = { imageId: "sha256:" + "a".repeat(64), bundleRev: "bundle-new",
  bootHash: "boot-new", releaseResolvedPath: "/runtime/new",
  platformRoot: "/platform" };
const status = { state: "running", imageId: desired.imageId };
const inspect = () => ({ Image: desired.imageId,
  Config: { Labels: { [RUNTIME_IMAGE_ID_LABEL_KEY]: desired.imageId,
    [RUNTIME_RELEASE_LABEL_KEY]: "rel-new",
    [RUNTIME_BUNDLE_REV_LABEL_KEY]: desired.bundleRev,
    [RUNTIME_BOOT_HASH_LABEL_KEY]: desired.bootHash } },
  Mounts: [{ Type: "bind", Destination: "/opt/openclaude", Source: "/runtime/new" },
    { Type: "bind", Destination: "/run/oc/platform", Source: "/platform" }] });
const identity = (path: string) => path;
test("runtime convergence requires immutable image, release, bundle, boot and mounts", () => {
  assert.equal(runtimeMatches(status, inspect(), desired, "rel-new", identity), true);
  assert.equal(runtimeMatches({ ...status, imageId: "sha256:old" },
    inspect(), desired, "rel-new", identity), false);
  const oldImage = inspect(); oldImage.Image = "sha256:old";
  assert.equal(runtimeMatches(status, oldImage, desired, "rel-new", identity), false);
  const oldBoot = inspect(); oldBoot.Config.Labels[RUNTIME_BOOT_HASH_LABEL_KEY] = "boot-old";
  assert.equal(runtimeMatches(status, oldBoot, desired, "rel-new", identity), false);
  const oldBundle = inspect(); oldBundle.Config.Labels[RUNTIME_BUNDLE_REV_LABEL_KEY] = "bundle-old";
  assert.equal(runtimeMatches(status, oldBundle, desired, "rel-new", identity), false);
  const oldMount = inspect(); oldMount.Mounts[0]!.Source = "/runtime/old";
  assert.equal(runtimeMatches(status, oldMount, desired, "rel-new", identity), false);
});
