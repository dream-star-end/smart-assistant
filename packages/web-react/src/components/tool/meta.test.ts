import { describe, expect, test } from "vitest";
import { detectOcCli, parseMcpName, resolveToolMeta, toolSummary } from "./meta";

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

describe("oc-* CLI 语义卡 (Bash 特判)", () => {
  test("detectOcCli 识别行首命令", () => {
    expect(detectOcCli('oc-web extract "https://x.com"')).toBe("oc-web");
  });
  test("detectOcCli 识别管道/连接符后的命令", () => {
    expect(detectOcCli("cd /tmp && oc-cite mint doi:10.1/x")).toBe("oc-cite");
    expect(detectOcCli("which oc-web 2>/dev/null && oc-web --help")).toBe("oc-web");
  });
  test("detectOcCli 不把 oc-lit 误吞成 oc-litrag 的前缀", () => {
    expect(detectOcCli("oc-litrag ask 'q'")).toBe("oc-litrag");
    expect(detectOcCli("oc-lit search 'q'")).toBe("oc-lit");
  });
  test("detectOcCli 只认命令位置,参数/文本里的 oc-web 不误报", () => {
    // 非命令位置(echo/printf 的参数)→ 不识别为 CLI 调用。
    expect(detectOcCli("echo oc-web")).toBeNull();
    expect(detectOcCli("printf 'run oc-web'")).toBeNull();
    expect(detectOcCli("echo oc-web-ish")).toBeNull();
    // 命令位置(行首/分隔符后)→ 识别。
    expect(detectOcCli("  oc-web extract url")).toBe("oc-web");
  });
  test("detectOcCli 对普通命令返回 null", () => {
    expect(detectOcCli("ls -la")).toBeNull();
    expect(detectOcCli(undefined)).toBeNull();
  });
  test("resolveToolMeta(Bash, oc-web) → 网页/文档提取 + Globe", () => {
    const m = resolveToolMeta("Bash", { command: 'oc-web extract "https://x.com"' });
    expect(m.label).toBe("网页/文档提取");
    expect(m.tone).toBe("info");
  });
  test("resolveToolMeta(Bash, 普通命令) → 终端(回退)", () => {
    expect(resolveToolMeta("Bash", { command: "ls -la" }).label).toBe("终端");
    expect(resolveToolMeta("Bash").label).toBe("终端");
  });
  test("toolSummary(Bash, oc-web) 取子命令+首参,去掉重定向/管道", () => {
    expect(
      toolSummary("Bash", {
        command: 'oc-web extract "https://www.woshipm.com/x" --max-chars 8000 2>&1 | head -150',
      }),
    ).toBe('extract "https://www.woshipm.com/x" --max-chars 8000');
  });
  test("toolSummary 从命令位置的 oc-web 切摘要,跳过 which 预检那处", () => {
    expect(
      toolSummary("Bash", { command: "which oc-web 2>/dev/null && oc-web --help" }),
    ).toBe("--help");
  });
});
