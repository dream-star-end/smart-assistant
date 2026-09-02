import { describe, expect, test } from "vitest";
import {
  executeExtraToolResultText,
  isExecuteExtraToolName,
  isSearchExtraToolsName,
  parseExecuteExtraToolResult,
  parseSearchExtraToolsResult,
  searchExtraToolsQuery,
  unwrapExecuteExtraToolInput,
} from "./extraTool";

describe("CCB deferred-tool wrapper helpers", () => {
  test("name predicates tolerate case / separators", () => {
    expect(isExecuteExtraToolName("ExecuteExtraTool")).toBe(true);
    expect(isExecuteExtraToolName("execute_extra_tool")).toBe(true);
    expect(isExecuteExtraToolName("Bash")).toBe(false);
    expect(isSearchExtraToolsName("SearchExtraTools")).toBe(true);
    expect(isSearchExtraToolsName(undefined)).toBe(false);
  });

  test("unwrapExecuteExtraToolInput → inner tool name + params", () => {
    const call = unwrapExecuteExtraToolInput({
      tool_name: "mcp__openclaude-memory__skill_save",
      params: { name: "x", description: "d", body: "b" },
    });
    expect(call).toEqual({
      name: "mcp__openclaude-memory__skill_save",
      params: { name: "x", description: "d", body: "b" },
    });
  });

  test("unwrapExecuteExtraToolInput: params as JSON string, missing params, streaming without tool_name", () => {
    expect(
      unwrapExecuteExtraToolInput({ tool_name: "TeamCreate", params: '{"team_name":"a"}' }),
    ).toEqual({
      name: "TeamCreate",
      params: { team_name: "a" },
    });
    expect(unwrapExecuteExtraToolInput({ tool_name: "TeamCreate" })).toEqual({
      name: "TeamCreate",
      params: {},
    });
    expect(unwrapExecuteExtraToolInput({ params: { a: 1 } })).toBeNull();
    expect(unwrapExecuteExtraToolInput(null)).toBeNull();
  });

  test("parseExecuteExtraToolResult decodes the {result:[{text}],tool_name} envelope", () => {
    const raw = JSON.stringify({
      result: [{ type: "text", text: 'Saved skill "x".' }],
      tool_name: "mcp__openclaude-memory__skill_save",
    });
    expect(parseExecuteExtraToolResult(raw)).toEqual({
      toolName: "mcp__openclaude-memory__skill_save",
      text: 'Saved skill "x".',
    });
    // Multiple text parts join with newline; null result → empty text.
    expect(
      parseExecuteExtraToolResult({
        result: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
        tool_name: "t",
      })?.text,
    ).toBe("a\nb");
    expect(parseExecuteExtraToolResult({ result: null, tool_name: "t" })).toEqual({
      toolName: "t",
      text: "",
    });
  });

  test("parseExecuteExtraToolResult rejects non-envelope shapes", () => {
    expect(
      parseExecuteExtraToolResult("error: Cannot read properties of undefined (reading 'trim')"),
    ).toBeNull();
    expect(parseExecuteExtraToolResult({ status: "running", jobId: "dlgjob-1" })).toBeNull();
    expect(parseExecuteExtraToolResult({ result: { foo: 1 } })).toBeNull();
    expect(parseExecuteExtraToolResult(undefined)).toBeNull();
  });

  test("executeExtraToolResultText keeps plain error text verbatim", () => {
    const err = "error: meta3.tags.join is not a function";
    expect(executeExtraToolResultText(err)).toBe(err);
    expect(
      executeExtraToolResultText('{"result":[{"type":"text","text":"ok"}],"tool_name":"t"}'),
    ).toBe("ok");
  });

  test("searchExtraToolsQuery strips select:/discover:/+ prefixes", () => {
    expect(searchExtraToolsQuery({ query: "select:mcp__openclaude-memory__skill_view" })).toBe(
      "mcp__openclaude-memory__skill_view",
    );
    expect(searchExtraToolsQuery({ query: "discover: cron schedule" })).toBe("cron schedule");
    expect(searchExtraToolsQuery({ query: "+slack send" })).toBe("slack send");
    expect(searchExtraToolsQuery({ query: "codex review" })).toBe("codex review");
    expect(searchExtraToolsQuery(null)).toBe("");
  });

  test("parseSearchExtraToolsResult lists discovered names and detects no-match", () => {
    const text =
      "Found 2 deferred tool(s): mcp__openclaude-memory__request_review, TeamCreate.\n" +
      'Use ExecuteExtraTool with {"tool_name": "<name>", "params": {...}} to invoke any of these deferred tools.';
    expect(parseSearchExtraToolsResult(text)).toEqual({
      found: ["mcp__openclaude-memory__request_review", "TeamCreate"],
      none: false,
    });
    expect(parseSearchExtraToolsResult("No matching deferred tools found")).toEqual({
      found: [],
      none: true,
    });
    expect(parseSearchExtraToolsResult("<tool_use_error>Cancelled</tool_use_error>")).toBeNull();
    expect(parseSearchExtraToolsResult(null)).toBeNull();
  });
});
