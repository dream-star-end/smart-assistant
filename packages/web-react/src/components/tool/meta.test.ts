import { describe, expect, test } from "vitest";
import { parseMcpName, resolveToolMeta, toolSummary } from "./meta";

describe("parseMcpName (P5)", () => {
  test("mcp__server__op → { server, op }", () => {
    expect(parseMcpName("mcp__browser__browser_navigate")).toEqual({
      server: "browser",
      op: "browser_navigate",
    });
  });
  test("含连字符 server 名正确切分", () => {
    expect(parseMcpName("mcp__minimax-media__text_to_image")).toEqual({
      server: "minimax-media",
      op: "text_to_image",
    });
  });
  test("非 MCP 名 → null", () => {
    expect(parseMcpName("Bash")).toBeNull();
  });
});

describe("resolveToolMeta 图标/标签解析 (P5)", () => {
  test("builtin Bash → 终端", () => {
    expect(resolveToolMeta("Bash").label).toBe("终端");
  });
  test("MCP per-op 覆盖优先：browser_navigate → 打开网页", () => {
    expect(resolveToolMeta("mcp__browser__browser_navigate").label).toBe("打开网页");
  });
  test("MCP server 兜底：未知 op → `server 标签: op`", () => {
    expect(resolveToolMeta("mcp__browser__browser_weird").label).toBe("浏览器: browser weird");
  });
  test("未知 MCP server → humanize(op)，扳手图标", () => {
    const m = resolveToolMeta("mcp__unknown_srv__do_thing");
    expect(m.label).toBe("do thing");
  });
  test("完全未知名 → 原样标签", () => {
    expect(resolveToolMeta("Frobnicate").label).toBe("Frobnicate");
  });
  test("v5 无 codex：codex:webSearch 不命中任何 codex 映射，落通用扳手", () => {
    expect(resolveToolMeta("codex:webSearch").label).toBe("codex:webSearch");
  });
});

describe("toolSummary 摘要 (P5)", () => {
  test("Bash 取 description 或首行命令", () => {
    expect(toolSummary("Bash", { command: "ls -la\necho hi" })).toBe("ls -la");
    expect(toolSummary("Bash", { description: "列目录", command: "ls" })).toBe("列目录");
  });
  test("Edit/Read/Write 取短路径", () => {
    expect(toolSummary("Edit", { file_path: "/a/b/c/d/e.ts" })).toBe("…/c/d/e.ts");
  });
  test("TodoWrite 取 done/total", () => {
    expect(
      toolSummary("TodoWrite", {
        todos: [{ status: "completed" }, { status: "pending" }, { status: "in_progress" }],
      }),
    ).toBe("1/3");
  });
  test("MCP browser_navigate 摘要为 URL", () => {
    expect(toolSummary("mcp__browser__browser_navigate", { url: "https://x.com" })).toBe("https://x.com");
  });
  test("MCP memory delegate_task 摘要带目标 agent", () => {
    expect(
      toolSummary("mcp__openclaude-memory__delegate_task", { agentId: "coder", goal: "修复 bug" }),
    ).toBe("→ coder 修复 bug");
  });
  test("input 为 null → 空摘要", () => {
    expect(toolSummary("Bash", null)).toBe("");
  });
});
