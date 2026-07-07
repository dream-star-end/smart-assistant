import { describe, expect, test } from "vitest";
import { detectShellFileWrites, normalizeToolForDisplay } from "./format";
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
  test("Codex 简单 item 有友好标签", () => {
    expect(resolveToolMeta("codex:imageView").label).toBe("查看图片");
    expect(resolveToolMeta("codex:contextCompaction").label).toBe("压缩上下文");
    expect(resolveToolMeta("Codex:userMessage").label).toBe("Codex 消息");
  });
  test("v3 历史裸工具名有友好标签", () => {
    expect(resolveToolMeta("Skill").label).toBe("启用技能");
    expect(resolveToolMeta("TaskOutput").label).toBe("子任务结果");
    expect(resolveToolMeta("EnterPlanMode").label).toBe("进入计划模式");
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
  test("delegate_task 委派系统 agent(hidden-reviewer)显示映射名而非裸 id", () => {
    expect(
      toolSummary("mcp__openclaude-memory__delegate_task", { agentId: "hidden-reviewer", goal: "审查代码" }),
    ).toBe("→ 质量审查员 审查代码");
    expect(toolSummary("delegate_task", { agentId: "hidden-reviewer", goal: "审查代码" })).toBe(
      "→ 质量审查员 审查代码",
    );
  });
  test("delegate_tasks(并行委派)标签为「并行委派」+ 摘要为 N 个并行子任务(带首个 goal)", () => {
    expect(resolveToolMeta("mcp__openclaude-memory__delegate_tasks").label).toBe("并行委派");
    expect(resolveToolMeta("delegate_tasks").label).toBe("并行委派");
    expect(
      toolSummary("mcp__openclaude-memory__delegate_tasks", {
        tasks: [{ agentId: "coding-assistant", goal: "写代码" }, { goal: "查资料" }],
      }),
    ).toBe("2 个并行子任务: 写代码");
    expect(toolSummary("delegate_tasks", { tasks: [{ goal: "只有一个" }] })).toBe("1 个并行子任务: 只有一个");
    // 防御非数组 tasks。
    expect(toolSummary("mcp__openclaude-memory__delegate_tasks", { tasks: "oops" })).toBe("0 个并行子任务");
  });
  test("MCP memory skill_search / web-context 摘要", () => {
    expect(toolSummary("mcp__openclaude-memory__skill_search", { query: "literature-search" })).toBe(
      "literature-search",
    );
    expect(toolSummary("mcp__web-context__web_context_parse_file", { file_path: "/a/b/c.docx" })).toBe(
      "…/a/b/c.docx",
    );
  });
  test("Codex 简单 item 摘要", () => {
    expect(toolSummary("codex:imageView", { path: "/tmp/a/b.png" })).toBe("…/tmp/a/b.png");
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

describe("Bash heredoc 写文件语义卡", () => {
  const writeOne = "mkdir -p packages/web-react/src && cat > packages/web-react/src/demo.ts <<'EOF'\nexport const x = 1;\nEOF";
  const writeTwo = "cat <<'EOF' > a.ts\none\nEOF\ncat > b.ts <<EOF\ntwo\nEOF";

  test("detectShellFileWrites 识别 mkdir -p + cat heredoc 纯写文件", () => {
    expect(detectShellFileWrites(writeOne)).toMatchObject({
      paths: ["packages/web-react/src/demo.ts"],
      writeCount: 1,
    });
    expect(detectShellFileWrites(writeTwo)?.paths).toEqual(["a.ts", "b.ts"]);
  });

  test("detectShellFileWrites 拒绝 trailing shell side effects", () => {
    expect(detectShellFileWrites(`${writeOne}\nnpm test`)).toBeNull();
    expect(detectShellFileWrites("cat > $TARGET <<'EOF'\nx\nEOF")).toBeNull();
    expect(detectShellFileWrites("cat > a.ts <<'EOF'\nx\nEOF\nchmod +x a.ts")).toBeNull();
  });

  test("resolveToolMeta / toolSummary 将纯 heredoc Bash 显示为写入文件", () => {
    expect(resolveToolMeta("Bash", { command: writeOne }).label).toBe("写入文件");
    expect(toolSummary("Bash", { command: writeOne })).toBe("…/web-react/src/demo.ts");
    expect(toolSummary("Bash", { command: writeTwo })).toBe("a.ts +1");
  });

  test("heredoc 内容里出现 oc-* 命令文本时仍优先按写文件显示", () => {
    const command = "cat > script.sh <<'EOF'\noc-web extract https://example.com\nEOF";
    expect(resolveToolMeta("Bash", { command }).label).toBe("写入文件");
    expect(toolSummary("Bash", { command })).toBe("script.sh");
  });
});

describe("Codex 工具归一化:cancelled 态与 plan 字段对齐 (fix C)", () => {
  const mcpItem = (status: string) => ({
    type: "mcpToolCall",
    id: "call_1",
    server: "web_context",
    tool: "web_context_extract_url",
    status,
    arguments: { url: "https://example.com" },
  });

  test("status cancelled → 中性取消态,不再标成失败红卡", () => {
    const item = mcpItem("cancelled");
    const d = normalizeToolForDisplay({
      toolName: "codex:mcpToolCall",
      inputJson: item,
      output: JSON.stringify(item),
      _completed: true,
    });
    expect(d.tool.error).toBeFalsy();
    expect(d.tool.cancelled).toBe(true);
  });

  test("status failed 仍归失败,cancelled 标志不误置", () => {
    const item = mcpItem("failed");
    const d = normalizeToolForDisplay({
      toolName: "codex:mcpToolCall",
      inputJson: item,
      output: JSON.stringify(item),
      _completed: true,
    });
    expect(d.tool.error).toBe(true);
    expect(d.tool.cancelled).toBeFalsy();
  });

  test("plan steps 元素读后端权威字段 {step,status}(不再渲染成空列表)", () => {
    const d = normalizeToolForDisplay({
      toolName: "codex:plan",
      inputJson: {
        type: "plan",
        steps: [
          { step: "改代码", status: "inProgress" },
          { step: "跑测试", status: "pending" },
        ],
      },
      _completed: true,
    });
    expect(d.name).toBe("TodoWrite");
    expect(d.input?.todos).toEqual([
      { content: "改代码", status: "inProgress" },
      { content: "跑测试", status: "pending" },
    ]);
  });

  test("item 以 {plan:[{step,…}]} 形态下发时兜底可解析", () => {
    const d = normalizeToolForDisplay({
      toolName: "codex:todo_list",
      inputJson: { type: "todo_list", plan: [{ step: "第一步", status: "completed" }] },
      _completed: true,
    });
    expect(d.name).toBe("TodoWrite");
    expect(d.input?.todos).toEqual([{ content: "第一步", status: "completed" }]);
  });

  test("legacy text/description 字段仍兼容", () => {
    const d = normalizeToolForDisplay({
      toolName: "codex:plan",
      inputJson: { type: "plan", steps: [{ text: "旧字段", status: "pending" }] },
      _completed: true,
    });
    expect(d.input?.todos).toEqual([{ content: "旧字段", status: "pending" }]);
  });
});
