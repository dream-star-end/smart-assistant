import assert from "node:assert/strict";
import { test } from "node:test";
import { decide } from "./fixture/readEditGuard.mjs";

const file = "/tmp/ocv5-parallel-fixed.txt";
const allow = { tuples: [
  { name: "Read", input: { file_path: file, limit: 3 } },
  { name: "Edit", input: { file_path: file, old_string: "ALPHA_OLD_TOKEN",
    new_string: "ALPHA_NEW_TOKEN", replace_all: false } },
  { name: "Edit", input: { file_path: file, old_string: "BETA_OLD_TOKEN",
    new_string: "BETA_NEW_TOKEN", replace_all: false } },
] };

test("guard allows only the three fixed tuples", () => {
  assert.equal(decide({ tool_name: "Read", tool_input: { limit: 3, file_path: file } }, allow), "allow");
  assert.equal(decide({ tool_name: "Edit", tool_input: allow.tuples[1]!.input }, allow), "allow");
  assert.equal(decide({ tool_name: "Edit", tool_input: allow.tuples[2]!.input }, allow), "allow");
  assert.equal(decide({ tool_name: "Edit", tool_input: { ...allow.tuples[1]!.input, replace_all: true } }, allow), "deny");
  assert.equal(decide({ tool_name: "Bash", tool_input: { command: "true" } }, allow), "deny");
  assert.equal(decide({ tool_name: "Read", tool_input: { file_path: file } }, allow), "deny");
  assert.equal(decide({ tool_name: "Read", tool_input: { file_path: "/home/agent/.openclaude/user.md", limit: 3 } }, allow), "deny");
});
