import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { MediaSignProvider } from "./chat/media";
import { ToolCard } from "./ToolCard";

afterEach(cleanup);

describe("ToolCard 二级分派 + 状态 (P5)", () => {
  test("Bash 运行中：spinner + 默认展开终端命令", () => {
    const { container } = render(
      <ToolCard message={{ toolName: "Bash", inputJson: { command: "ls -la" }, _completed: false }} />,
    );
    expect(screen.getByText("终端")).toBeInTheDocument();
    // 运行中 → spinner（animate-spin）
    expect(container.querySelector(".animate-spin")).toBeInTheDocument();
    // 运行中默认展开 → 命令出现两处：header 摘要 + 展开体终端行
    expect(screen.getAllByText("ls -la")).toHaveLength(2);
  });

  test("Bash heredoc 纯写文件：显示写入文件语义卡，展开仍保留原始命令", () => {
    const command = "mkdir -p packages/web-react/src && cat > packages/web-react/src/demo.ts <<'EOF'\nexport const x = 1;\nEOF";
    render(<ToolCard message={{ toolName: "Bash", inputJson: { command }, _completed: true, output: "ok" }} />);
    expect(screen.getByText("写入文件")).toBeInTheDocument();
    expect(screen.getByText("…/web-react/src/demo.ts")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("已写入 1 个文件")).toBeInTheDocument();
    expect(screen.getByText("原始终端命令")).toBeInTheDocument();
    const pre = document.querySelector("pre");
    expect(pre?.textContent).toContain("$ mkdir -p packages/web-react/src");
    expect(pre?.textContent).toContain("export const x = 1;");
    expect(pre?.textContent).toContain("ok");
  });

  test("Bash heredoc 原始命令不截断，长文件内容也可审计", () => {
    const marker = "TAIL_MARKER_SHOULD_STAY_VISIBLE";
    const command = `cat > big.txt <<'EOF'\n${"x".repeat(2200)}\n${marker}\nEOF`;
    render(<ToolCard message={{ toolName: "Bash", inputJson: { command }, _completed: true }} />);
    fireEvent.click(screen.getByRole("button"));
    expect(document.querySelector("pre")?.textContent).toContain(marker);
  });

  test("Bash heredoc 失败：错误输出仍可见，非纯写命令不误标", () => {
    const command = "cat > a.ts <<'EOF'\ncontent\nEOF";
    render(
      <ToolCard
        message={{
          toolName: "Bash",
          inputJson: { command },
          _completed: true,
          error: true,
          output: "Permission denied",
        }}
      />,
    );
    expect(screen.getByText("写入文件")).toBeInTheDocument();
    expect(screen.getByText("失败")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("写入文件命令失败")).toBeInTheDocument();
    expect(document.querySelector("pre")?.textContent).toContain("Permission denied");
    cleanup();

    render(
      <ToolCard
        message={{
          toolName: "Bash",
          inputJson: { command: `${command}\nnpm test` },
          _completed: true,
        }}
      />,
    );
    expect(screen.getByText("终端")).toBeInTheDocument();
  });

  test("完成态：✓ 无 spinner，默认折叠，点击展开 Edit diff", () => {
    const { container } = render(
      <ToolCard
        message={{
          toolName: "Edit",
          inputJson: { file_path: "/x/y.ts", old_string: "foo", new_string: "bar" },
          _completed: true,
        }}
      />,
    );
    expect(screen.getByText("编辑文件")).toBeInTheDocument();
    expect(container.querySelector(".animate-spin")).not.toBeInTheDocument();
    // 默认折叠 → diff 不可见
    expect(screen.queryByText("- foo")).not.toBeInTheDocument();
    // 展开
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("- foo")).toBeInTheDocument();
    expect(screen.getByText("+ bar")).toBeInTheDocument();
  });

  test("流式 partialJson 驱动 Edit diff 边流边渲（new_string 半截）", () => {
    // 运行中 + 仅 partialJson：file_path/old_string 完整，new_string 正在键入
    render(
      <ToolCard
        message={{
          toolName: "Edit",
          partialJson: '{"file_path":"/a.ts","old_string":"foo","new_string":"ba',
          _partial: true,
          _completed: false,
        }}
      />,
    );
    // 运行中默认展开
    expect(screen.getByText("- foo")).toBeInTheDocument();
    expect(screen.getByText("+ ba")).toBeInTheDocument();
  });

  test("错误态：失败 Badge", () => {
    render(
      <ToolCard
        message={{ toolName: "Write", inputJson: { file_path: "/a" }, error: true, _completed: true, output: "denied" }}
      />,
    );
    expect(screen.getByText("失败")).toBeInTheDocument();
  });

  test("TodoWrite 勾选列表 + done/total 摘要", () => {
    render(
      <ToolCard
        message={{
          toolName: "TodoWrite",
          inputJson: {
            todos: [
              { content: "任务A", status: "completed" },
              { content: "任务B", status: "pending" },
            ],
          },
          _completed: true,
        }}
      />,
    );
    expect(screen.getByText("1/2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("任务A")).toBeInTheDocument();
    expect(screen.getByText("任务B")).toBeInTheDocument();
  });

  test("MCP browser_navigate：标签 + URL 链接", () => {
    render(
      <ToolCard
        message={{
          toolName: "mcp__browser__browser_navigate",
          inputJson: { url: "https://example.com" },
          _completed: true,
        }}
      />,
    );
    expect(screen.getByText("打开网页")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    const link = screen.getByRole("link", { name: "https://example.com" });
    expect(link).toHaveAttribute("href", "https://example.com");
  });

  test("未知 MCP server → generic kv-list 兜底", () => {
    render(
      <ToolCard
        message={{ toolName: "mcp__unknown__do_thing", inputJson: { foo: "bar" }, _completed: true }}
      />,
    );
    // humanize(op) 标签
    expect(screen.getByText("do thing")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("foo")).toBeInTheDocument();
    expect(screen.getByText("bar")).toBeInTheDocument();
  });

  test("无 body（无 input/output）→ 不可展开（无 aria-expanded）", () => {
    render(<ToolCard message={{ toolName: "Read", _completed: true }} />);
    const btn = screen.getByRole("button");
    expect(btn).not.toHaveAttribute("aria-expanded");
  });

  test("agent-group 子块（ChildBlock 形态）复用本组件渲染", () => {
    // ChildBlock 结构兼容 ToolLike：toolName/inputJson/_completed/output
    render(
      <ToolCard
        message={{ toolName: "Bash", inputJson: { command: "pwd" }, _completed: true, output: "/home" }}
      />,
    );
    expect(screen.getByText("终端")).toBeInTheDocument();
    // 命令在表头摘要（唯一精确匹配的元素）
    expect(screen.getByText("pwd")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    // 展开体为**单一终端块**（$ 命令 + 输出合一，不再命令一框/输出一框的嵌套方框）
    const pre = document.querySelector("pre");
    expect(pre?.textContent).toContain("$ pwd");
    expect(pre?.textContent).toContain("/home");
  });

  test("Codex MCP skill_search 解包为记忆工具卡，不展示 wrapper JSON", () => {
    const started = {
      type: "mcpToolCall",
      id: "call_skill",
      server: "openclaude_memory",
      tool: "skill_search",
      status: "inProgress",
      arguments: { query: "literature-search", limit: 5 },
      pluginId: null,
      result: null,
      error: null,
      durationMs: null,
    };
    const completed = {
      ...started,
      status: "completed",
      result: {
        content: [{ type: "text", text: "Found 1 matching skill(s):\n\n### literature-search" }],
        structuredContent: null,
        _meta: null,
      },
      durationMs: 87,
    };
    render(
      <ToolCard
        message={{
          toolName: "codex:mcpToolCall",
          inputJson: started,
          inputPreview: JSON.stringify(started),
          output: JSON.stringify(completed),
          _completed: true,
        }}
      />,
    );
    expect(screen.getByText("技能检索")).toBeInTheDocument();
    expect(screen.getByText("literature-search")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    // skill_search 命中富卡:汇总行 + 技能卡(不再裸 query KV / 原始 Found 文本)。
    expect(screen.getByText("找到 1 个相关技能")).toBeInTheDocument();
    expect(screen.getAllByText("literature-search").length).toBeGreaterThanOrEqual(1);
    const text = document.body.textContent || "";
    expect(text).not.toContain("codex:mcpToolCall");
    expect(text).not.toContain("mcpToolCall");
    expect(text).not.toContain("pluginId");
    expect(text).not.toContain("structuredContent");
  });

  test("Codex MCP failed web-context 显示友好标签、参数与错误文本", () => {
    const started = {
      type: "mcpToolCall",
      id: "call_web",
      server: "web-context",
      tool: "web_context_extract_url",
      status: "inProgress",
      arguments: { url: "https://example.com", max_chars: 2000 },
    };
    const failed = {
      ...started,
      status: "failed",
      result: { content: [{ type: "text", text: '{ "ok": false, "error": "Invalid IP address: undefined" }' }] },
      durationMs: 352,
    };
    render(
      <ToolCard
        message={{
          toolName: "codex:mcpToolCall",
          inputJson: started,
          output: JSON.stringify(failed),
          _completed: true,
        }}
      />,
    );
    expect(screen.getByText("网页提取")).toBeInTheDocument();
    expect(screen.getByText("失败")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("url")).toBeInTheDocument();
    expect(screen.getAllByText("https://example.com").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Invalid IP address/)).toBeInTheDocument();
  });

  test("Codex MCP 运行中只展示 args，不展示空 result wrapper", () => {
    const started = {
      type: "mcpToolCall",
      id: "call_running",
      server: "openclaude_memory",
      tool: "skill_search",
      status: "inProgress",
      arguments: { query: "browser" },
      pluginId: null,
      result: null,
    };
    const { container } = render(
      <ToolCard message={{ toolName: "codex:mcpToolCall", inputJson: started, _completed: false }} />,
    );
    expect(container.querySelector(".animate-spin")).toBeInTheDocument();
    expect(screen.getByText("技能检索")).toBeInTheDocument();
    expect(screen.getAllByText("browser").length).toBeGreaterThanOrEqual(1);
    const text = document.body.textContent || "";
    expect(text).not.toContain("pluginId");
    expect(text).not.toContain("result");
  });

  test("Codex webSearch（含旧 Codex 前缀）复用 WebSearch 卡", () => {
    const completed = { type: "webSearch", id: "ws", action: "search", query: "OpenClaude v5", results: 3 };
    render(
      <ToolCard
        message={{
          toolName: "Codex:webSearch",
          inputJson: { type: "webSearch", id: "ws", action: "search", query: "OpenClaude v5" },
          output: JSON.stringify(completed),
          _completed: true,
        }}
      />,
    );
    expect(screen.getByText("网页搜索")).toBeInTheDocument();
    expect(screen.getByText("OpenClaude v5")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("results")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  test("Codex plan/todo_list 复用 TodoWrite 列表", () => {
    render(
      <ToolCard
        message={{
          toolName: "codex:plan",
          inputJson: {
            type: "plan",
            steps: [
              { text: "调研工具形态", status: "pending" },
              { text: "实现适配", status: "pending" },
            ],
          },
          output: JSON.stringify({
            type: "todo_list",
            items: [
              { text: "调研工具形态", completed: true },
              { text: "实现适配", completed: true },
            ],
          }),
          _completed: true,
        }}
      />,
    );
    expect(screen.getByText("任务列表")).toBeInTheDocument();
    expect(screen.getByText("2/2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("调研工具形态")).toBeInTheDocument();
    expect(screen.getByText("实现适配")).toBeInTheDocument();
  });

  test("Codex 取消态 → 中性「已取消」徽标,不显示红色失败、不转圈", () => {
    const item = {
      type: "mcpToolCall",
      id: "call_cancel",
      server: "openclaude_memory",
      tool: "skill_search",
      status: "cancelled",
      arguments: { query: "x" },
    };
    const { container } = render(
      <ToolCard
        message={{
          toolName: "codex:mcpToolCall",
          inputJson: item,
          output: JSON.stringify(item),
          _completed: true,
        }}
      />,
    );
    expect(screen.getByText("已取消")).toBeInTheDocument();
    expect(screen.queryByText("失败")).toBeNull();
    expect(container.querySelector(".animate-spin")).toBeNull();
  });

  test("Codex 取消态在未标 _completed 时也不当运行中(不转圈)", () => {
    const item = {
      type: "mcpToolCall",
      id: "call_cancel2",
      server: "openclaude_memory",
      tool: "skill_search",
      status: "cancelled",
      arguments: { query: "y" },
    };
    const { container } = render(
      <ToolCard
        message={{ toolName: "codex:mcpToolCall", inputJson: item, output: JSON.stringify(item), _completed: false }}
      />,
    );
    expect(screen.getByText("已取消")).toBeInTheDocument();
    expect(container.querySelector(".animate-spin")).toBeNull();
  });

  test("Codex image/context 简单 item 不 raw dump id/type wrapper", () => {
    render(
      <ToolCard
        message={{
          toolName: "codex:imageView",
          inputJson: { type: "imageView", id: "img1", path: "/home/agent/.openclaude/uploads/a.png" },
          _completed: true,
        }}
      />,
    );
    expect(screen.getByText("查看图片")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getAllByText("…/.openclaude/uploads/a.png").length).toBeGreaterThanOrEqual(1);
    const text = document.body.textContent || "";
    expect(text).not.toContain("imageView");
    expect(text).not.toContain("img1");
  });

  test("Codex imageGeneration 运行中显示友好等待态，不展示 raw status wrapper", () => {
    render(
      <ToolCard
        message={{
          toolName: "codex:imageGeneration",
          inputJson: {
            type: "imageGeneration",
            id: "ig_running",
            status: "in_progress",
            revisedPrompt: null,
            result: "",
          },
          _completed: false,
        }}
      />,
    );
    expect(screen.getByText("生成图片")).toBeInTheDocument();
    expect(screen.getByText("图片生成中，通常需要几十秒，请稍候…")).toBeInTheDocument();
    const text = document.body.textContent || "";
    expect(text).not.toContain("in_progress");
    expect(text).not.toContain("ig_running");
    expect(text).not.toContain("imageGeneration");
  });

  test("Codex imageGeneration 完成后显示生成结果，不保留 status in_progress", () => {
    render(
      <ToolCard
        message={{
          toolName: "codex:imageGeneration",
          inputJson: {
            type: "imageGeneration",
            id: "ig_done",
            status: "in_progress",
            revisedPrompt: null,
            result: "",
          },
          output:
            "imageGeneration → /home/agent/.codex/generated_images/thread/ig_done.png",
          _completed: true,
        }}
      />,
    );
    expect(screen.getByText("生成图片")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("图片已生成")).toBeInTheDocument();
    expect(screen.getByText("…/generated_images/thread/ig_done.png")).toBeInTheDocument();
    const text = document.body.textContent || "";
    expect(text).not.toContain("in_progress");
    expect(text).not.toContain("imageGeneration →");
  });

  test("Codex imageGeneration 失败仍展示错误输出", () => {
    render(
      <ToolCard
        message={{
          toolName: "codex:imageGeneration",
          inputJson: { type: "imageGeneration", id: "ig_error", status: "failed" },
          output: "imageGeneration failed: quota exceeded",
          error: true,
          _completed: true,
        }}
      />,
    );
    expect(screen.getByText("生成图片")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText(/imageGeneration failed: quota exceeded/)).toBeInTheDocument();
    const text = document.body.textContent || "";
    expect(text).not.toContain("ig_error");
  });

  test("Codex contextCompaction 合并 completed-only 字段", () => {
    render(
      <ToolCard
        message={{
          toolName: "codex:contextCompaction",
          inputJson: { type: "contextCompaction", id: "ctx1" },
          output: JSON.stringify({
            type: "contextCompaction",
            id: "ctx1",
            tokensBefore: 12000,
            tokensAfter: 7000,
            note: "已压缩",
          }),
          _completed: true,
        }}
      />,
    );
    expect(screen.getByText("压缩上下文")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("tokens before")).toBeInTheDocument();
    expect(screen.getByText("12000")).toBeInTheDocument();
    expect(screen.getByText("tokens after")).toBeInTheDocument();
    expect(screen.getByText("7000")).toBeInTheDocument();
    expect(screen.getByText("已压缩")).toBeInTheDocument();
  });

  test("Codex dynamicToolCall builtin 复用原生 Bash body", () => {
    const started = {
      type: "dynamicToolCall",
      id: "dyn1",
      name: "Bash",
      status: "inProgress",
      arguments: { command: "pwd" },
    };
    const completed = {
      ...started,
      status: "completed",
      result: { content: [{ type: "text", text: "/home/agent" }] },
    };
    render(
      <ToolCard
        message={{
          toolName: "codex:dynamicToolCall",
          inputJson: started,
          output: JSON.stringify(completed),
          _completed: true,
        }}
      />,
    );
    expect(screen.getByText("终端")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    const pre = document.querySelector("pre");
    expect(pre?.textContent).toContain("$ pwd");
    expect(pre?.textContent).toContain("/home/agent");
  });

  test("openclaude-memory list_reminders 渲染为友好的定时任务列表", () => {
    const started = {
      type: "mcpToolCall",
      id: "call_cron",
      server: "openclaude_memory",
      tool: "list_reminders",
      status: "inProgress",
      arguments: {},
    };
    const text = [
      "共 3 个定时提醒/任务:",
      "- **daily-reflection** (ID: `daily-reflection`) — `17 3 * * *` · 重复 · 启用中 · 仅记录 · 下次 2026-07-04T19:17:00.000Z",
      "- **weekly-curation** (ID: `weekly-curation`) — `31 4 * * 0` · 重复 · 启用中 · 仅记录 · 下次 2026-07-04T20:31:00.000Z",
      "- **Quick skill extraction pass** (ID: `skill-check`) — `47 */6 * * *` · 重复 · 已停用 · 推送对话",
    ].join("\n");
    render(
      <ToolCard
        message={{
          toolName: "codex:mcpToolCall",
          inputJson: started,
          output: JSON.stringify({ ...started, status: "completed", result: { content: [{ type: "text", text }] } }),
          _completed: true,
        }}
      />,
    );
    expect(screen.getByText("定时任务列表")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("当前共有 3 个定时任务")).toBeInTheDocument();
    expect(screen.getAllByText("daily-reflection").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("weekly-curation").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("skill-check").length).toBeGreaterThanOrEqual(1);
    expect(document.body.textContent || "").not.toContain("- **daily-reflection**");
  });

  test("openclaude-memory list_reminders 空列表显示空状态", () => {
    render(
      <ToolCard
        message={{
          toolName: "mcp__openclaude-memory__list_reminders",
          inputJson: {},
          output: "当前没有任何定时提醒/任务。可用 create_reminder 创建。",
          _completed: true,
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("还没有定时任务")).toBeInTheDocument();
    expect(screen.getByText(/每天 9 点提醒我/)).toBeInTheDocument();
  });

  test("openclaude-memory list_reminders 解析失败时保留 raw fallback", () => {
    render(
      <ToolCard
        message={{
          toolName: "mcp__openclaude-memory__list_reminders",
          inputJson: {},
          output: "共 2 个定时提醒/任务:\n* bad legacy line",
          _completed: true,
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByText(/当前共有/)).not.toBeInTheDocument();
    expect(document.querySelector("pre")?.textContent).toContain("bad legacy line");
  });

  test("openclaude-memory list_reminders 一坏行不作废整卡:有效任务出卡 + 坏行附底(不漏任务)", () => {
    render(
      <ToolCard
        message={{
          toolName: "mcp__openclaude-memory__list_reminders",
          inputJson: {},
          output: [
            "共 2 个定时提醒/任务:",
            "- **ok-job** (ID: `ok`) — `0 9 * * *` · 重复 · 启用中 · 推送对话",
            "- malformed reminder line",
          ].join("\n"),
          _completed: true,
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    // 韧性解析:有效任务照常出卡,坏行作 leftover 纯文本附底(不整段回退、不漏任务)。
    expect(screen.getByText("当前共有 2 个定时任务")).toBeInTheDocument();
    expect(screen.getByText("ok-job")).toBeInTheDocument();
    expect(screen.getByText("- malformed reminder line")).toBeInTheDocument();
  });

  test.each([
    [
      "create_reminder",
      { schedule: "bad cron", message: "喝水" },
      "error: 创建提醒失败: bad cron",
      "创建提醒失败",
      "",
    ],
    [
      "update_reminder",
      { id: "missing", schedule: "0 9 * * *" },
      "error: 任务不存在: missing(用 list_reminders 查 ID)",
      "修改任务失败",
      "任务信息已更新",
    ],
    [
      "delete_reminder",
      { id: "missing" },
      "error: 任务不存在: missing(用 list_reminders 查 ID)",
      "删除任务失败",
      "这个任务不会再触发。",
    ],
  ])("openclaude-memory %s 失败时展示 raw error 而不是成功文案", (op, inputJson, output, title, misleading) => {
    render(
      <ToolCard
        message={{
          toolName: `mcp__openclaude-memory__${op}`,
          inputJson,
          output,
          error: true,
          _completed: true,
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText(title)).toBeInTheDocument();
    expect(document.body.textContent || "").toContain(output);
    if (misleading) expect(document.body.textContent || "").not.toContain(misleading);
  });

  // 注:openclaude-memory `memory` 读/写状态卡已随核心记忆 memdir 化退役(后端 handleMemory
  // 退役 + 前端 §-blob 记忆卡删除),记忆读写现由记忆中心文件列表 + Write/Edit「记忆更新」卡承载;
  // 历史会话里的 memory op 退化为通用 KvList 展示,故此处不再有专属卡断言。

});

describe("codex fileChange(apply_patch)的 Write/Edit 卡", () => {
  const demoPath = "/home/agent/.openclaude/generated/tool-card-demo.txt";

  test("Write(add)→ 显示新文件内容,不再空壳/裸 changes JSON", () => {
    render(
      <ToolCard
        message={{
          toolName: "Write",
          inputJson: {
            file_path: demoPath,
            kind: "add",
            changes: [
              {
                path: demoPath,
                kind: { type: "add" },
                diff: "OpenClaude 工具卡片演示文件\n状态：由受控 apply_patch 调用创建，可安全删除。\n",
              },
            ],
          },
          output: `add: ${demoPath}`,
          _completed: true,
        }}
      />,
    );
    expect(screen.getByText("写入文件")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    const pre = document.querySelector("pre");
    expect(pre?.textContent).toContain("OpenClaude 工具卡片演示文件");
    expect(pre?.textContent).toContain("可安全删除");
    // header 摘要 + 展开体 FileMeta 都显示短路径。
    expect(screen.getAllByText("…/.openclaude/generated/tool-card-demo.txt").length).toBeGreaterThanOrEqual(1);
    const text = document.body.textContent || "";
    expect(text).not.toContain('"changes"');
    expect(text).not.toContain('{"type":"add"}');
  });

  test("Edit(update)→ unified diff 按行着色(+绿/-红)", () => {
    render(
      <ToolCard
        message={{
          toolName: "Edit",
          inputJson: {
            file_path: "/home/agent/demo.txt",
            kind: "update",
            changes: [
              {
                path: "/home/agent/demo.txt",
                kind: { type: "update" },
                diff: "@@ -1,2 +1,2 @@\n-旧的一行\n+新的一行\n 上下文行",
              },
            ],
          },
          output: "update: /home/agent/demo.txt",
          _completed: true,
        }}
      />,
    );
    expect(screen.getByText("编辑文件")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("-旧的一行").className).toContain("text-danger");
    expect(screen.getByText("+新的一行").className).toContain("text-success");
    expect(screen.getByText("上下文行")).toBeInTheDocument();
  });

  test("Edit(delete)→ 明确「删除文件」状态行(danger,非绿色成功)", () => {
    render(
      <ToolCard
        message={{
          toolName: "Edit",
          inputJson: {
            file_path: demoPath,
            kind: "delete",
            changes: [{ path: demoPath, kind: { type: "delete" }, diff: "" }],
          },
          output: `delete: ${demoPath}`,
          _completed: true,
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    const del = screen.getByText("删除文件");
    expect(del.className).toContain("text-danger");
    expect(del.className).not.toContain("text-success");
    // 原始 "delete: /path" output 不再当绿色成功状态行渲染。
    expect(document.body.textContent || "").not.toContain(`delete: ${demoPath}`);
  });

  test("多 changes 逐个显示 path", () => {
    render(
      <ToolCard
        message={{
          toolName: "Edit",
          inputJson: {
            file_path: "/a/1.txt",
            kind: "update",
            changes: [
              { path: "/a/1.txt", kind: { type: "update" }, diff: "-x\n+y" },
              { path: "/a/2.txt", kind: { type: "delete" }, diff: "" },
            ],
          },
          _completed: true,
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getAllByText("/a/1.txt").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("/a/2.txt")).toBeInTheDocument();
    expect(screen.getByText("删除文件")).toBeInTheDocument();
    expect(screen.getByText("+y")).toBeInTheDocument();
  });

  test("claude 原生 Write(content)行为不变,不误入 codex 分支", () => {
    render(
      <ToolCard
        message={{
          toolName: "Write",
          inputJson: { file_path: "/a/b.ts", content: "export const x = 1;" },
          output: "File created successfully",
          _completed: true,
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(document.querySelector("pre")?.textContent).toContain("export const x = 1;");
    expect(screen.getByText("File created successfully")).toBeInTheDocument();
  });
});

describe("codex imageView 缩略图", () => {
  const sign = async (paths: string[]) =>
    Object.fromEntries(paths.map((p) => [p, `/api/media?sig=x&path=${encodeURIComponent(p)}`]));

  test("path 型 imageView → 签名缩略图 + 路径 FileMeta,不裸 JSON", async () => {
    const { container } = render(
      <MediaSignProvider sign={sign}>
        <ToolCard
          message={{
            toolName: "codex:imageView",
            inputJson: { type: "imageView", id: "exec-8f2a", path: "/opt/openclaude/tool-card-example.png" },
            _completed: true,
          }}
        />
      </MediaSignProvider>,
    );
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    expect(container.querySelector("img")?.getAttribute("src")).toContain("/api/media?sig=x");
    expect(screen.getAllByText("…/opt/openclaude/tool-card-example.png").length).toBeGreaterThanOrEqual(1);
    const text = document.body.textContent || "";
    expect(text).not.toContain("exec-8f2a");
    expect(text).not.toContain('"path"');
  });

  test("非法/相对路径不产 img,仍保留路径文本", () => {
    const { container } = render(
      <ToolCard
        message={{
          toolName: "codex:imageView",
          inputJson: { type: "imageView", id: "exec-1", path: "javascript:alert(1)//x.png" },
          _completed: true,
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("subAgentActivity 卡(含存量孤儿形状)", () => {
  test("存量孤儿(toolName unknown + item 在 output)→ 子代理活动语义卡,不裸 JSON", () => {
    const payload = {
      type: "subAgentActivity",
      id: "call_8xd930hU3Lw7Hrhn0Go32z1M",
      kind: "started",
      agentThreadId: "019f4bd8-c3b8-7112-a7fb-af393bb6fadb",
      agentPath: "/root/tool_card_probe",
    };
    render(
      <ToolCard message={{ toolName: "unknown", inputJson: {}, output: JSON.stringify(payload), _completed: true }} />,
    );
    expect(screen.getByText("子代理活动")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("已启动")).toBeInTheDocument();
    expect(screen.getAllByText("/root/tool_card_probe").length).toBeGreaterThanOrEqual(1);
    const text = document.body.textContent || "";
    expect(text).not.toContain('"agentThreadId"');
    expect(text).not.toContain("019f4bd8");
    expect(text).not.toContain('{"type":"subAgentActivity"');
    expect(text).not.toContain("call_8xd930hU3Lw7Hrhn0Go32z1M");
  });

  test("kind=completed(直接 codex: 名)→ 已完成", () => {
    render(
      <ToolCard
        message={{
          toolName: "codex:subAgentActivity",
          inputJson: {
            type: "subAgentActivity",
            id: "call_x",
            kind: "completed",
            agentThreadId: "th",
            agentPath: "/root/tool_card_probe",
          },
          _completed: true,
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("已完成")).toBeInTheDocument();
  });

  test("未知 kind → 「子代理活动」兜底,不外露英文原词", () => {
    render(
      <ToolCard
        message={{
          toolName: "codex:subAgentActivity",
          inputJson: { type: "subAgentActivity", kind: "paused", agentPath: "/root/x" },
          _completed: true,
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    // kind=paused 未映射 → 中文兜底「子代理活动」,不再直显英文 paused。
    expect(screen.getAllByText("子代理活动").length).toBeGreaterThanOrEqual(1);
    expect(document.body.textContent).not.toContain("paused");
  });
});

describe("codex 通用卡 KvList 噪音字段", () => {
  test("appContext/error/null durationMs 不进 KvList,业务字段保留", () => {
    render(
      <ToolCard
        message={{
          toolName: "codex:customEvent",
          inputJson: {
            type: "customEvent",
            id: "evt1",
            status: "completed",
            appContext: { foo: "bar" },
            error: null,
            durationMs: null,
            note: "自定义说明",
          },
          _completed: true,
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("自定义说明")).toBeInTheDocument();
    const text = document.body.textContent || "";
    expect(text).not.toContain("appContext");
    expect(text).not.toContain("evt1");
    expect(text).not.toContain("durationMs");
  });
});
