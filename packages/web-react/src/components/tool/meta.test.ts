import { describe, expect, test } from "vitest";
import { detectShellFileWrites, normalizeToolForDisplay } from "./format";
import { detectOcCli, isMemoryFilePath, parseMcpName, resolveToolMeta, toolSummary } from "./meta";
// 跨包取 openclaude-memory 工具名单一权威表(与 index.ts TOOLS 声明同源),做锁步断言。
import { MEMORY_MCP_TOOL_NAMES, MEMORY_MCP_TRAIN_ONLY_TOOL_NAMES } from "../../../../mcp-memory/src/toolNames";

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

describe("MCP_OP_META 锁步 openclaude-memory 工具名单(漏登记 → 「记忆: <英文>」兜底)", () => {
  // 每个注册工具都必须有 `openclaude-memory:<name>` 专属条目;否则 resolveToolMeta 回落
  // server 兜底 `记忆: <humanizeOp>`(boss 现网看到的「记忆: request review」)。新增工具漏改
  // 这里会直接红,逼两侧同步。
  const names = [...MEMORY_MCP_TOOL_NAMES, ...MEMORY_MCP_TRAIN_ONLY_TOOL_NAMES];
  test.each(names)("%s → 专属中文标签(非「记忆:」兜底)", (name) => {
    const label = resolveToolMeta(`mcp__openclaude-memory__${name}`).label;
    expect(label.length).toBeGreaterThan(0);
    expect(label.startsWith("记忆:")).toBe(false);
  });
  test("request_review / skill_propose 补齐后有明确标签", () => {
    expect(resolveToolMeta("mcp__openclaude-memory__request_review").label).toBe("申请质量审查");
    expect(resolveToolMeta("mcp__openclaude-memory__skill_propose").label).toBe("提议技能");
  });
});

describe("codex 系统 server meta(资源清单不再裸 JSON 名)", () => {
  test("codex server 兜底标签 = 系统: <op>", () => {
    expect(resolveToolMeta("mcp__codex__something_new").label).toBe("系统: something new");
  });
  test("list_mcp_resources / templates 专属标签", () => {
    expect(resolveToolMeta("mcp__codex__list_mcp_resources").label).toBe("MCP 资源列表");
    expect(resolveToolMeta("mcp__codex__list_mcp_resource_templates").label).toBe("MCP 资源模板");
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
  test("detectOcCli 认前导环境变量赋值与绝对/相对路径前缀(统一 matchOcTool 的覆盖)", () => {
    expect(detectOcCli("FOO=1 oc-lit snowball 10.x")).toBe("oc-lit");
    expect(detectOcCli("/usr/local/bin/oc-lit search x")).toBe("oc-lit");
    expect(detectOcCli("FOO=1 /usr/bin/oc-cite verify doi:10.1/x")).toBe("oc-cite");
    // env 前缀不误伤:cat 的路径参数不是命令位置。
    expect(detectOcCli("cat /some/oc-web")).toBeNull();
  });
  test("detectOcCli 认 mmx 软链与 oc-web-context", () => {
    expect(detectOcCli("mmx image generate 'a cat'")).toBe("mmx");
    expect(detectOcCli("oc-web-context extract url")).toBe("oc-web-context");
    // oc-web 不吞 oc-web-context(lookahead 保护)。
    expect(detectOcCli("oc-web extract url")).toBe("oc-web");
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
  test("resolveToolMeta(Bash, oc-web) → 动作化网页提取标签", () => {
    const m = resolveToolMeta("Bash", { command: 'oc-web extract "https://x.com"' });
    expect(m.label).toBe("提取网页内容");
    expect(m.tone).toBe("info");
  });
  test("resolveToolMeta(Bash, 普通命令) → 终端(回退)", () => {
    expect(resolveToolMeta("Bash", { command: "ls -la" }).label).toBe("终端");
    expect(resolveToolMeta("Bash").label).toBe("终端");
  });
  test("toolSummary(Bash, oc-*) 只展示安全语义摘要，不外露原始命令", () => {
    expect(
      toolSummary("Bash", {
        command: 'oc-web extract "https://www.woshipm.com/x" --max-chars 8000 2>&1 | head -150',
      }),
    ).toBe("woshipm.com");
    expect(toolSummary("Bash", { command: "which oc-web 2>/dev/null && oc-web --help" })).toBe("");
    expect(toolSummary("Bash", { command: "oc-vision understand /home/agent/img.png --prompt 'x'" })).toBe("");
    expect(toolSummary("Bash", { command: "mmx image generate 'a cat' -o /out.png" })).toBe("");
  });
  test("oc-browser / oc-market 根据动作提供友好标签和摘要", () => {
    expect(resolveToolMeta("Bash", { command: "oc-browser navigate --url https://example.com/a" }).label).toBe(
      "打开网页",
    );
    expect(toolSummary("Bash", { command: "oc-browser navigate --url https://example.com/a" })).toBe(
      "example.com",
    );
    expect(resolveToolMeta("Bash", { command: "oc-browser click --element '登录按钮'" }).label).toBe("点击页面");
    expect(toolSummary("Bash", { command: "oc-browser click --element '登录按钮'" })).toBe("登录按钮");
    expect(resolveToolMeta("Bash", { command: "oc-market search image" }).label).toBe("搜索 AI 市场");
    expect(toolSummary("Bash", { command: "oc-market search image" })).toBe("image");
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

describe("记忆更新重标(Write/Edit 命中记忆文件)", () => {
  const memFile = "/home/agent/.openclaude/agents/main/memory/user-preferences.md";
  const memIndex = "/home/agent/.openclaude/agents/main/MEMORY.md";
  const userProfile = "/home/agent/.openclaude/user.md";

  test("isMemoryFilePath 命中 memdir 记忆文件 / MEMORY.md 索引 / user.md 画像", () => {
    expect(isMemoryFilePath(memFile)).toBe(true);
    expect(isMemoryFilePath(memIndex)).toBe(true);
    expect(isMemoryFilePath(userProfile)).toBe(true);
    expect(isMemoryFilePath("/home/agent/.openclaude/USER.md")).toBe(true); // 大小写容错
  });

  test("isMemoryFilePath 放过普通文件与近似路径", () => {
    expect(isMemoryFilePath("/home/agent/project/MEMORY.md")).toBe(false); // 不在 .openclaude/agents 下
    expect(isMemoryFilePath("/home/agent/.openclaude/agents/main/skills/x.md")).toBe(false);
    expect(isMemoryFilePath("/home/agent/notes/user.md")).toBe(false);
    expect(isMemoryFilePath("")).toBe(false);
    expect(isMemoryFilePath(undefined)).toBe(false);
  });

  test("原生 Write/Edit 写入记忆文件 → 记忆更新(标题+Brain 图标)", () => {
    const w = resolveToolMeta("Write", { file_path: memFile });
    expect(w.label).toBe("记忆更新");
    expect(w.tone).toBe("accent");
    expect(resolveToolMeta("Edit", { file_path: memIndex }).label).toBe("记忆更新");
    expect(resolveToolMeta("Write", { file_path: userProfile }).label).toBe("记忆更新");
  });

  test("Write/Edit 写普通文件 → 仍是写入/编辑文件(不误标)", () => {
    expect(resolveToolMeta("Write", { file_path: "/home/agent/app.ts" }).label).toBe("写入文件");
    expect(resolveToolMeta("Edit", { file_path: "/home/agent/app.ts" }).label).toBe("编辑文件");
  });

  test("Bash heredoc 写入记忆文件也重标记忆更新", () => {
    const command = `cat > ${memIndex} <<'EOF'\n<!-- oc-memdir-index v1 -->\nEOF`;
    expect(resolveToolMeta("Bash", { command }).label).toBe("记忆更新");
    // 非记忆路径的 heredoc 写文件不受影响。
    const other = "cat > /home/agent/a.ts <<'EOF'\nx\nEOF";
    expect(resolveToolMeta("Bash", { command: other }).label).toBe("写入文件");
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

describe("subAgentActivity meta + 存量孤儿归一化", () => {
  test("codex:subAgentActivity → 子代理活动标签 + agentPath 尾段摘要", () => {
    expect(resolveToolMeta("codex:subAgentActivity").label).toBe("子代理活动");
    expect(toolSummary("codex:subAgentActivity", { agentPath: "/root/tool_card_probe" })).toBe(
      "/root/tool_card_probe",
    );
  });

  test("toolName unknown + output 是 codex item JSON → 归一化为 codex:<type>", () => {
    // 真实孤儿载荷(生产 sessions.db):toolName='unknown'、inputJson={}、item 整段在 output。
    const d = normalizeToolForDisplay({
      toolName: "unknown",
      inputJson: {},
      output: JSON.stringify({
        type: "subAgentActivity",
        id: "call_8xd930hU3Lw7Hrhn0Go32z1M",
        kind: "started",
        agentThreadId: "019f4bd8-c3b8-7112-a7fb-af393bb6fadb",
        agentPath: "/root/tool_card_probe",
      }),
      _completed: true,
    });
    expect(d.name).toBe("codex:subAgentActivity");
    expect(d.input?.kind).toBe("started");
    expect(d.input?.agentPath).toBe("/root/tool_card_probe");
    // codex item JSON 不再被当输出文本裸 dump。
    expect(d.tool.output).toBeNull();
  });

  test("toolName 缺失也走孤儿兜底", () => {
    const d = normalizeToolForDisplay({
      output: JSON.stringify({ type: "subAgentActivity", kind: "completed" }),
    });
    expect(d.name).toBe("codex:subAgentActivity");
  });

  test("unknown + 非 codex item 输出 → 保持 unknown 不误归一", () => {
    expect(normalizeToolForDisplay({ toolName: "unknown", inputJson: {}, output: "plain text" }).name).toBe(
      "unknown",
    );
    expect(normalizeToolForDisplay({ toolName: "unknown", inputJson: {}, output: '{"ok":true}' }).name).toBe(
      "unknown",
    );
    // 畸形 type(非标识符)不归一。
    expect(
      normalizeToolForDisplay({ toolName: "unknown", inputJson: {}, output: '{"type":"<script>"}' }).name,
    ).toBe("unknown");
  });

  test("已具名工具不受孤儿兜底影响(output 恰为 JSON 也不改名)", () => {
    const d = normalizeToolForDisplay({
      toolName: "Bash",
      inputJson: { command: "ls" },
      output: '{"type":"subAgentActivity"}',
      _completed: true,
    });
    expect(d.name).toBe("Bash");
  });
});
