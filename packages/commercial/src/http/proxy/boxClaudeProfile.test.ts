import test from "node:test";
import assert from "node:assert/strict";
import { boxProfileDir, boxProfileNameFromDirName, isBoxLaunchRequest, withBoxProfile } from "./boxClaudeProfile.js";

const launch = { command: "/usr/bin/python3", args: ["-I", "k"], cwd: "/tmp/x",
  environment: { HOME: "/home/box", CLAUDE_CODE_MAX_RETRIES: "0" } };
const read = { command: "/usr/bin/python3", args: ["-I"], cwd: "/tmp", environment: { PATH: "/usr/bin" } };

test("the default login launches byte-identically (same object, no CLAUDE_CONFIG_DIR)", () => {
  assert.equal(withBoxProfile(launch, "default"), launch);
  assert.equal("CLAUDE_CONFIG_DIR" in launch.environment, false);
});
test("another login gets its own config dir on launch requests only", () => {
  const scoped = withBoxProfile(launch, "b");
  assert.equal(scoped.environment.CLAUDE_CONFIG_DIR, "/home/box/.claude-b");
  assert.equal(scoped.environment.HOME, "/home/box");
  assert.equal(launch.environment.CLAUDE_CODE_MAX_RETRIES, "0");
  assert.equal(withBoxProfile(read, "b"), read);
  assert.equal(isBoxLaunchRequest(read), false);
});
test("names map to directories one way only", () => {
  assert.equal(boxProfileDir("default"), "/home/box/.claude");
  assert.equal(boxProfileNameFromDirName(".claude"), "default");
  assert.equal(boxProfileNameFromDirName(".claude-account2"), "account2");
  for (const bad of [".claude-default", ".claude-", ".claude-A", ".claude-../x", ".claude.json", "claude-x", ".claude-x/y"]) {
    assert.equal(boxProfileNameFromDirName(bad), null, bad);
  }
  assert.throws(() => boxProfileDir("../x"));
  assert.throws(() => boxProfileDir("A"));
});
