import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
test("CCB spawn stamps both session aliases from its own session, after provider overrides", () => {
  const src = readFileSync(new URL("../subprocessRunner.ts", import.meta.url), "utf8");
  const spawn = src.slice(src.indexOf("proc = backend.spawn({"), src.indexOf("IS_SANDBOX: '1'"));
  assert.match(spawn, /\.\.\.finalizedProviderEnv,[\s\S]*OC_SESSION_KEY: this\.opts\.sessionKey/);
  assert.match(spawn, /OPENCLAUDE_SESSION_KEY: this\.opts\.sessionKey/);
  assert.equal((spawn.match(/\n\s+OC_SESSION_KEY:/g) ?? []).length, 1);
});
