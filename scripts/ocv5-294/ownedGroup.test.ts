import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { groupAlive, reapOwnedGroup } from "./ownedGroup.ts";

test("a child that ignores TERM and holds the pipe is killed after the leader exits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocv5-group-"));
  const script = join(dir, "leader.mjs");
  writeFileSync(script, `
    import { spawn } from "node:child_process";
    const child = spawn(process.execPath, ["-e", ${JSON.stringify(`
      process.on("SIGHUP", () => {});
      process.on("SIGTERM", () => {});
      setInterval(() => process.stdout.write("x"), 200);
    `)}], { stdio: "inherit" });
    child.once("spawn", () => setTimeout(() => process.exit(0), 150));
  `);
  const leader = spawn(process.execPath, [script], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  leader.stdout?.resume();
  leader.stderr?.resume();
  const pgid = leader.pid ?? 0;
  await new Promise<void>((done, reject) => {
    leader.once("error", reject);
    leader.once("exit", () => done());
  });
  const deadline = Date.now() + 1000;
  while (!groupAlive(pgid) && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 20));
  }
  assert.equal(groupAlive(pgid), true);
  const result = await reapOwnedGroup(pgid, 300);
  assert.equal(result, "killed");
  assert.equal(groupAlive(pgid), false);
});
