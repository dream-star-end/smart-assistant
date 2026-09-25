import test from "node:test";
import assert from "node:assert/strict";
import { BoxToolCatalogError, compileBoxToolCatalog, mapBoxCliEffort } from "./boxToolCatalog.js";

// Names observed from an isolated real Claude Code 2.1.280 Messages request;
// descriptions and schemas here are synthetic, not a captured user request.
const ccNames = ["Agent", "Bash", "CronCreate", "CronDelete", "CronList", "Edit",
  "EnterWorktree", "ExitWorktree", "ListAgents", "NotebookEdit", "Read",
  "ReportFindings", "ScheduleWakeup", "SendMessage", "Skill", "TaskStop",
  "WebFetch", "WebSearch", "Workflow", "Write"];
const tool = (name: string) => ({ name, description: `Synthetic ${name} tool`,
  input_schema: { type: "object", properties: { value: { type: "string" } },
    required: ["value"] } });
function rejects(input: unknown, code: string): void {
  assert.throws(() => compileBoxToolCatalog(input),
    (error: unknown) => error instanceof BoxToolCatalogError && error.code === code);
}

test("real CC built-in tool names get unique Box MCP aliases and exact reverse names", () => {
  const source = ccNames.map(tool);
  const compiled = compileBoxToolCatalog(source);
  const staged = JSON.parse(compiled.json) as { tools: Array<{ name: string;
    description: string; inputSchema: unknown }> };
  assert.equal(staged.tools.length, 20);
  assert.equal(compiled.clientNameByBoxName.size, 20);
  assert.equal(compiled.boxNameByClientName.size, 20);
  for (let i = 0; i < source.length; i++) {
    const boxName = `mcp__ocbridge__t${i}`;
    assert.equal(compiled.clientNameByBoxName.get(boxName), source[i]!.name);
    assert.equal(compiled.boxNameByClientName.get(source[i]!.name), boxName);
    assert.equal(staged.tools[i]!.name, `t${i}`);
    assert.equal(staged.tools[i]!.description,
      `OpenClaude tool name: ${source[i]!.name}. ${source[i]!.description}`);
    assert.deepEqual(staged.tools[i]!.inputSchema, source[i]!.input_schema);
  }
  assert.match(compiled.sha256, /^[a-f0-9]{64}$/);
  assert.equal(compileBoxToolCatalog(source).sha256, compiled.sha256);
  const renamed = source.map((item, i) => i === 0 ? { ...item, name: "RenamedAgent" } : item);
  assert.notEqual(compileBoxToolCatalog(renamed).sha256, compiled.sha256,
    "the model-visible alias description must identify the real client tool");
  assert.notEqual(compileBoxToolCatalog(renamed).bindingSha256, compiled.bindingSha256);
});

test("duplicate, malformed, oversized and dangerous tool declarations fail closed", () => {
  rejects([], "BOX_TOOL_COUNT_INVALID");
  rejects(Array.from({ length: 129 }, (_, i) => tool(`Tool${i}`)), "BOX_TOOL_COUNT_INVALID");
  rejects([tool("Bash"), tool("Bash")], "BOX_TOOL_DECLARATION_INVALID");
  rejects([{ ...tool("a bad name") }], "BOX_TOOL_DECLARATION_INVALID");
  rejects([{ ...tool("Bash"), input_schema: { type: "string" } }],
    "BOX_TOOL_DECLARATION_INVALID");
  rejects([{ ...tool("Bash"), description: "x".repeat(16_385) }],
    "BOX_TOOL_DECLARATION_INVALID");
  for (const unsupported of [
    { strict: true },
    { allowed_callers: ["code_execution_20260120"] },
    { type: "custom" },
    { cache_control: { type: "persistent" } },
  ]) {
    rejects([{ ...tool("Bash"), ...unsupported }], "BOX_TOOL_DECLARATION_INVALID");
  }
  const dataKeys = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"},"constructor":{"type":"string"},"prototype":{"type":"string"}},"default":{"__proto__":"data"}}');
  assert.deepEqual(JSON.parse(compileBoxToolCatalog([{ ...tool("Bash"),
    input_schema: dataKeys }]).json).tools[0].inputSchema, dataKeys);
  const deep: Record<string, unknown> = { type: "object" };
  let cursor = deep;
  for (let i = 0; i < 34; i++) {
    const next: Record<string, unknown> = {};
    cursor.child = next; cursor = next;
  }
  rejects([{ ...tool("Bash"), input_schema: deep }], "BOX_TOOL_SCHEMA_TOO_DEEP");
});

test("default real CCB adaptive-medium effort maps exactly, unsupported settings reject", () => {
  assert.equal(mapBoxCliEffort({ type: "adaptive", display: "omitted" },
    { effort: "medium" }), "medium");
  for (const effort of ["low", "high", "max"] as const) {
    assert.equal(mapBoxCliEffort({ type: "adaptive", display: "omitted" },
      { effort }), effort);
  }
  for (const args of [
    [{ type: "enabled", budget_tokens: 1024 }, { effort: "medium" }],
    [{ type: "adaptive", display: "omitted" }, { effort: "xhigh" }],
    [{ type: "adaptive", display: "omitted" }, { effort: "medium", format: "json" }],
    [undefined, { effort: "medium" }],
  ]) {
    assert.throws(() => mapBoxCliEffort(args[0], args[1]),
      (error: unknown) => error instanceof BoxToolCatalogError
        && error.code === "BOX_EFFORT_UNMAPPED");
  }
});
