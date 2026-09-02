#!/usr/bin/env tsx
/**
 * Deploy-gate contract for INC-20260902-CCB-DEFERRED-TOOL-ADAPT (OCV5-67).
 *
 * Pins CCB extra-prompt wiring so built-in openclaude-memory tools are in
 * availableMcpTools before buildPromptContext, and pins the frontend
 * ExecuteExtraTool wrapper unwrap. Empty availableMcpTools would let
 * sanitizeUnavailableMcpClaims redact delegate_task / skill_search / etc.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { MEMORY_MCP_TOOL_NAMES } from "../packages/mcp-memory/src/toolNames.js";

const root = resolve(process.cwd());
const testHome = mkdtempSync(join(tmpdir(), "oc-ccb-mcp-avail-"));
process.env.OPENCLAUDE_HOME = testHome;

const promptSlots = await import("../packages/gateway/src/promptSlots.js");
const { buildPromptContext, PLATFORM_MCP_TOOL_NAMES, sanitizeUnavailableMcpClaims } = promptSlots;
const { projectCcbMcpAvailability } = await import("../packages/gateway/src/ccbMcpAvailability.js");
const { inspectCcbPromptContextAvailability } = await import(
  "../packages/gateway/src/ccbMcpAvailabilitySourceContract.js"
);

// promptSlots pulls mcpVisionServer → mcpStdioGuard, which keeps the process
// alive on uncaughtException. This gate must still fail-closed.
process.on("uncaughtException", (err) => {
  console.error(err);
  process.exit(1);
});

const REQUIRED_PLATFORM_TOOLS = [
  "delegate_task",
  "delegate_tasks",
  "send_to_agent",
  "request_review",
  "skill_search",
  "skill_save",
  "task_create",
] as const;

for (const name of REQUIRED_PLATFORM_TOOLS) {
  assert.ok(
    (PLATFORM_MCP_TOOL_NAMES as readonly string[]).includes(name),
    `PLATFORM_MCP_TOOL_NAMES missing ${name}`,
  );
}

const memoryNames = MEMORY_MCP_TOOL_NAMES as readonly string[];
for (const name of PLATFORM_MCP_TOOL_NAMES) {
  assert.ok(
    memoryNames.includes(name),
    `MEMORY_MCP_TOOL_NAMES must be a superset of PLATFORM_MCP_TOOL_NAMES (missing ${name})`,
  );
}

const UNREGISTERED = "（当前未注册）";
const LAUNCH = { command: "node", args: ["mcp"] };
const configured = ["browser", "search"];
assert.deepEqual(
  projectCcbMcpAvailability({ configuredTools: configured, mcpLaunch: null }),
  configured,
);
assert.equal(
  projectCcbMcpAvailability({
    configuredTools: configured,
    mcpLaunch: null,
  }).includes("delegate_task"),
  false,
);

const withLaunch = projectCcbMcpAvailability({
  configuredTools: [],
  mcpLaunch: LAUNCH,
});
for (const name of PLATFORM_MCP_TOOL_NAMES) {
  assert.ok(withLaunch.includes(name), `launch advertised set missing ${name}`);
}

const evalNames = projectCcbMcpAvailability({
  configuredTools: [],
  mcpLaunch: LAUNCH,
  skillEvalMode: true,
});
for (const name of ["delegate_task", "skill_save", "task_create"]) {
  assert.equal(evalNames.includes(name), false, `skill-eval must hide ${name}`);
}
for (const name of ["skill_search", "skill_view", "skill_list", "list_reminders"]) {
  assert.ok(evalNames.includes(name), `skill-eval must keep ${name}`);
}

const trainNames = projectCcbMcpAvailability({
  configuredTools: [],
  mcpLaunch: LAUNCH,
  skillTrainRunId: "run-1",
});
assert.equal(trainNames.includes("skill_save"), false, "skill-train must hide skill_save");
assert.equal(trainNames.includes("skill_delete"), false, "skill-train must hide skill_delete");
assert.ok(trainNames.includes("delegate_task"), "skill-train must keep delegate_task");
assert.equal(trainNames.includes("skill_propose"), false, "skill_propose must not be advertised");

const evalKeepsConfigured = projectCcbMcpAvailability({
  configuredTools: ["skill_save", "browser"],
  mcpLaunch: {},
  skillEvalMode: true,
});
assert.ok(evalKeepsConfigured.includes("skill_save"), "skill-eval must keep configured skill_save");
assert.ok(evalKeepsConfigured.includes("browser"), "skill-eval must keep configured browser");
assert.equal(
  evalKeepsConfigured.includes("delegate_task"),
  false,
  "skill-eval must still hide platform delegate_task",
);

const sample = "走 MCP delegate_task/delegate_tasks";
const redacted = sanitizeUnavailableMcpClaims(
  sample,
  projectCcbMcpAvailability({ configuredTools: [], mcpLaunch: null }),
);
assert.ok(
  redacted.includes(UNREGISTERED),
  "sanitizer must redact delegate_task when launch is null",
);
assert.equal(redacted.includes("delegate_task"), false);
assert.equal(
  sanitizeUnavailableMcpClaims(
    sample,
    projectCcbMcpAvailability({ configuredTools: [], mcpLaunch: LAUNCH }),
  ),
  sample,
  "sanitizer must keep delegate_task when launch is present",
);

const subprocess = readFileSync(join(root, "packages/gateway/src/subprocessRunner.ts"), "utf8");
const promptIdx = subprocess.indexOf("buildPromptContext(");
assert.ok(promptIdx >= 0, "subprocessRunner.ts: buildPromptContext( call site not found");
const before = subprocess.slice(0, promptIdx);
assert.ok(
  before.includes("projectCcbMcpAvailability("),
  "projectCcbMcpAvailability( must appear before buildPromptContext(",
);
assert.equal(
  subprocess.includes("if (mcpLaunch) addAvailableTools("),
  false,
  "if (mcpLaunch) addAvailableTools( must not exist",
);
assert.ok(
  before.includes("resolveMcpMemoryLaunch("),
  "resolveMcpMemoryLaunch( must appear before buildPromptContext(",
);
const launchCalls = subprocess.match(/resolveMcpMemoryLaunch\(/g) ?? [];
assert.equal(
  launchCalls.length,
  1,
  `resolveMcpMemoryLaunch( must be called once and reused (got ${launchCalls.length})`,
);
const launchIdx = before.indexOf("resolveMcpMemoryLaunch(");
assert.ok(launchIdx >= 0, "resolveMcpMemoryLaunch( call site not found");
assert.ok(
  subprocess.slice(Math.max(0, launchIdx - 200), launchIdx).includes("try {"),
  "resolveMcpMemoryLaunch( must be wrapped in try { within 200 chars",
);
const binding = inspectCcbPromptContextAvailability(subprocess);
assert.equal(
  binding.projectionDeclared,
  true,
  "const projectedMcpTools = projectCcbMcpAvailability(...) must be declared",
);
assert.equal(
  binding.consumesProjection,
  true,
  `buildPromptContext must consume projectedMcpTools (availableMcpTools initializer: ${binding.availableMcpToolsInitializer})`,
);

const codexOverrides = readFileSync(
  join(root, "packages/gateway/src/codexLaunchOverrides.ts"),
  "utf8",
);
assert.ok(
  codexOverrides.includes("[...PLATFORM_MCP_TOOL_NAMES]"),
  "codexLaunchOverrides.ts must spread PLATFORM_MCP_TOOL_NAMES",
);
assert.doesNotMatch(
  codexOverrides,
  /'task_approve',/,
  "codexLaunchOverrides.ts must not keep a hardcoded 'task_approve', list",
);

const result = await buildPromptContext({
  agentId: "main",
  provider: "anthropic",
  availableMcpTools: [...PLATFORM_MCP_TOOL_NAMES],
});
assert.equal(
  result.content.includes(UNREGISTERED),
  false,
  "advertising the full platform MCP set must not redact tools as unregistered",
);

// Prove the sanitizer is still armed (empty list redacts) and that the fix is
// purely "supply the right list" (full list leaves the rule text intact).
assert.ok(
  sanitizeUnavailableMcpClaims(sample, []).includes(UNREGISTERED),
  "sanitizer must still redact when the advertised set is empty",
);
assert.equal(
  sanitizeUnavailableMcpClaims(sample, [...PLATFORM_MCP_TOOL_NAMES]),
  sample,
  "sanitizer must leave tool names intact when the full platform set is advertised",
);

const extraTool = readFileSync(join(root, "packages/web-react/src/lib/chat/extraTool.ts"), "utf8");
assert.match(extraTool, /export function unwrapExecuteExtraToolInput/);
assert.match(extraTool, /export function parseExecuteExtraToolResult/);
assert.match(extraTool, /export function parseSearchExtraToolsResult/);

const format = readFileSync(join(root, "packages/web-react/src/components/tool/format.ts"), "utf8");
assert.ok(
  format.includes("unwrapExecuteExtraToolInput"),
  "components/tool/format.ts must unwrap ExecuteExtraTool via unwrapExecuteExtraToolInput",
);

const mcpIndex = readFileSync(join(root, "packages/mcp-memory/src/index.ts"), "utf8");
assert.ok(
  mcpIndex.includes("normalizeSkillSaveArgs"),
  "mcp-memory index.ts must normalize skill_save args",
);

const commercialDeploy = readFileSync(join(root, "scripts/deploy-v5.sh"), "utf8");
const selfhostRelease = readFileSync(
  join(root, "scripts/v5-selfhost-master-release-lib.sh"),
  "utf8",
);
assert.ok(
  commercialDeploy.includes("check-v5-ccb-mcp-availability.ts"),
  "deploy-v5.sh must invoke check-v5-ccb-mcp-availability.ts",
);
assert.ok(
  selfhostRelease.includes("check-v5-ccb-mcp-availability.ts"),
  "v5-selfhost-master-release-lib.sh must invoke check-v5-ccb-mcp-availability.ts",
);

console.log(
  "[ccb-mcp-availability] PASS — CCB prompt advertises built-in openclaude-memory tools; ExecuteExtraTool wrapper unwraps to inner MCP tool",
);
