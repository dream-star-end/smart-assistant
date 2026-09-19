/** Real Docker bind proof using only synthetic credentials; run as root on a test host.
 * Usage: node --import tsx scripts/diagnostics/cursor-auth-mount-smoke.ts --image <existing-image>
 * Does not inspect, restart or mount any user's container or credential directory.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveV5CursorAuthMount, V5_CURSOR_AUTH_RO_MOUNT } from "../../packages/commercial/src/agent-sandbox/v3supervisor.js";

const image = process.argv[2] === "--image" && process.argv.length === 4 ? process.argv[3] : undefined;
assert.ok(image && !image.startsWith("-"), "provide an existing --image; no image is downloaded");
assert.equal(process.getuid?.(), 0, "root is required to test actual root-only mount metadata");
function docker(args: string[], allowFailure = false): { status: number | null; text: string } {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 20_000, maxBuffer: 64 * 1024 });
  if (result.error) throw result.error;
  if (!allowFailure) assert.equal(result.status, 0, `docker ${args[0]} failed: ${result.stderr.slice(0, 500)}`);
  return { status: result.status, text: result.stdout.trim() };
}
docker(["image", "inspect", "--format", "{{.Id}}", image]);
const fixture = mkdtempSync(join(tmpdir(), "oc-cursor-mount-smoke-"));
const name = `oc-cursor-mount-smoke-${randomUUID()}`;
let containerId: string | undefined;
const observations: Array<{ stage: string; keyPresent: boolean; sameDirectory: boolean; sameContainer: boolean }> = [];
let passed = false;
let cleaned = false;
try {
  chmodSync(fixture, 0o700);
  writeFileSync(join(fixture, ".account-pool-owned"), "1\n", { mode: 0o600 });
  const inode = statSync(fixture).ino;
  const mount = resolveV5CursorAuthMount({ uid: 4, runtimeChannel: "v5", useRemote: false, ownerUid: "4", authDir: fixture });
  assert.equal(mount, fixture, "empty managed pool must have a bind source before preparation completes");
  containerId = docker(["create", "--name", name, "--interactive", "--network", "none", "--read-only",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "32", "--memory", "64m",
    "--user", "0", "--entrypoint", "/bin/sh", "--mount", `type=bind,src=${mount},dst=${V5_CURSOR_AUTH_RO_MOUNT},readonly`,
    image, "-c", "read line"]).text;
  docker(["start", name]);
  for (const [stage, value] of [["empty", null], ["ready", "crsr_synthetic_first\n"], ["disabled", null], ["reactivated", "crsr_synthetic_second\n"]] as const) {
    const key = join(fixture, "api-key");
    if (value === null) rmSync(key, { force: true });
    else {
      writeFileSync(`${key}.tmp`, value, { mode: 0o600 });
      renameSync(`${key}.tmp`, key);
    }
    const actual = docker(["exec", name, "/bin/sh", "-c", `test -f ${V5_CURSOR_AUTH_RO_MOUNT}/api-key`], true);
    assert.equal(actual.status, value === null ? 1 : 0, `${stage}: key visibility must track publication`);
    if (value !== null) assert.equal(docker(["exec", name, "/bin/cat", `${V5_CURSOR_AUTH_RO_MOUNT}/api-key`]).text, value.trim());
    const inspect = JSON.parse(docker(["inspect", name]).text)[0];
    assert.equal(inspect.Id, containerId);
    const bind = inspect.Mounts.find((item: { Destination: string }) => item.Destination === V5_CURSOR_AUTH_RO_MOUNT);
    assert.equal(bind?.Source, fixture);
    assert.equal(bind?.RW, false);
    assert.equal(statSync(fixture).ino, inode);
    assert.equal(docker(["exec", name, "/bin/sh", "-c", `touch ${V5_CURSOR_AUTH_RO_MOUNT}/write-must-fail`], true).status, 1);
    observations.push({ stage, keyPresent: actual.status === 0, sameDirectory: true, sameContainer: true });
  }
  passed = true;
} finally {
  // Also inspect by our unpredictable name when create's response was lost.
  const namedContainer = () => docker(["ps", "--all", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"]);
  try {
    if (containerId || namedContainer().text) docker(["rm", "--force", name]);
    cleaned = namedContainer().text === "";
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
  const source = fileURLToPath(new URL("../../packages/commercial/src/agent-sandbox/v3supervisor.ts", import.meta.url));
  console.log(JSON.stringify({ contract: "cursor-empty-managed-bind-0-1-0-1", sourceHash: createHash("sha256").update(readFileSync(source)).digest("hex"), passed, cleaned, observations }));
  assert.ok(cleaned, "test container must be removed");
}
