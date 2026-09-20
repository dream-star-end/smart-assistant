/**
 * 「Agent 电脑」面板 / 任务进度 / 产物交付（PRD_MANUS_A F1–F3）共享假数据工厂。
 *
 * vitest 与 browser-tests/ui-preview 场景共用（ACCEPTANCE_PLAN_MANUS_A §2.2）。
 * 字段名以 lib/chat/model.ts 的 ChatMessage 为准；每个预置数组都是**工厂函数**，
 * 多次 render 不共享同一对象引用（ChatSocket 会就地 mutate 消息对象）。
 */
import type { ChatMessage, ChildBlock } from "../model";

let seq = 0;
/** 每次调用递增，保证 id 唯一、ts 单调（同一时间线内按调用顺序排）。 */
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}
function nextTs(): number {
  return 1_700_000_000_000 + seq * 1000;
}

export function userMsg(text: string, opts: { status?: ChatMessage["status"] } = {}): ChatMessage {
  return { id: nextId("u"), role: "user", text, ts: nextTs(), status: opts.status ?? "sent" };
}

export function assistantMsg(text: string, opts: Partial<ChatMessage> = {}): ChatMessage {
  return { id: nextId("a"), role: "assistant", text, ts: nextTs(), _completed: true, ...opts };
}

export type ToolMsgOptions = {
  /** 默认 true；false = 运行中。 */
  completed?: boolean;
  output?: string;
  error?: boolean;
  /** 历史 tape 里被中断的未完成工具（_timelineRecord + _dispatchOutcome=interrupted）。 */
  interrupted?: boolean;
  /** 刷新后的耐久行。 */
  timelineRecord?: boolean;
  id?: string;
};

export function toolMsg(
  name: string,
  input: Record<string, unknown>,
  opts: ToolMsgOptions = {},
): ChatMessage {
  const completed = opts.completed ?? true;
  const m: ChatMessage = {
    id: opts.id ?? nextId("t"),
    role: "tool",
    text: name,
    ts: nextTs(),
    toolName: name,
    inputJson: input,
    _completed: completed,
  };
  if (opts.output !== undefined) m.output = opts.output;
  if (opts.error) m.error = true;
  if (opts.timelineRecord || opts.interrupted) m._timelineRecord = true;
  if (opts.interrupted) {
    m._completed = false;
    m._dispatchOutcome = "interrupted";
  }
  return m;
}

/** 子 agent 工具（agent-group 卡的 childBlocks 项），不是独立的顶层 tool 行。 */
export function childTool(name: string, input: Record<string, unknown>, completed = true): ChildBlock {
  return {
    kind: "tool_use",
    blockId: nextId("cb"),
    toolName: name,
    inputJson: input,
    _completed: completed,
  };
}

export function agentGroupMsg(children: ChildBlock[], opts: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: nextId("g"),
    role: "agent-group",
    text: "子任务",
    ts: nextTs(),
    childBlocks: children,
    ...opts,
  };
}

export type TodoLike = { content: string; status: string; activeForm?: string };

export function todoWriteMsg(todos: TodoLike[], opts: ToolMsgOptions = {}): ChatMessage {
  return toolMsg("TodoWrite", { todos }, { output: "Todos have been modified successfully.", ...opts });
}

export function planMsg(
  steps: Array<{ step: string; status: "completed" | "pending" | "inProgress" }>,
  text = "计划",
): ChatMessage {
  return { id: nextId("p"), role: "plan", text, ts: nextTs(), steps };
}

// ── 预置数据 ────────────────────────────────────────────────────────────────

export const REPO = "/workspace/site";

export function TODOS_3_OF_7(): TodoLike[] {
  return [
    { content: "盘点仓库结构", status: "completed" },
    { content: "迁移 webpack 配置到 vite.config.ts", status: "completed" },
    { content: "修正静态资源引用路径", status: "completed" },
    { content: "构建静态站", status: "in_progress", activeForm: "正在构建静态站" },
    { content: "本地预览并核对首页", status: "pending" },
    { content: "补 README 迁移说明", status: "pending" },
    { content: "输出产物清单", status: "pending" },
  ];
}

/** 7 条顶层工具（按序），最后一条 Bash 运行中；含 TodoWrite（3/7）在工具之前。 */
export function TURN_RUNNING_7(): ChatMessage[] {
  return [
    userMsg("帮我把文档站迁到 Vite"),
    todoWriteMsg(TODOS_3_OF_7()),
    toolMsg("Read", { file_path: `${REPO}/package.json` }, { output: '{ "name": "site" }' }),
    toolMsg("Edit", {
      file_path: `${REPO}/package.json`,
      old_string: '"build": "webpack"',
      new_string: '"build": "vite build"',
    }),
    toolMsg("Write", {
      file_path: `${REPO}/vite.config.ts`,
      content: "import { defineConfig } from 'vite'\nexport default defineConfig({})\n",
    }),
    toolMsg("Grep", { pattern: "require\\(" }, { output: "src/legacy.js:3:const x = require('x')" }),
    toolMsg("Bash", { command: "npm install" }, { output: "added 128 packages in 4s" }),
    toolMsg("Edit", {
      file_path: `${REPO}/src/main.ts`,
      old_string: "require('./app')",
      new_string: "import './app'",
    }),
    toolMsg(
      "Bash",
      { command: "npm run build" },
      { completed: false, output: "vite v5.4 building for production...\n✓ 128 modules transformed." },
    ),
  ];
}

/** 已收口：5/5 completed，user 行 replied。 */
export function TURN_SETTLED_5_OF_5(): ChatMessage[] {
  const todos: TodoLike[] = [
    { content: "盘点仓库结构", status: "completed" },
    { content: "迁移配置", status: "completed" },
    { content: "修正引用路径", status: "completed" },
    { content: "构建静态站", status: "completed" },
    { content: "输出产物清单", status: "completed" },
  ];
  return [
    userMsg("帮我把文档站迁到 Vite", { status: "replied" }),
    todoWriteMsg(todos),
    toolMsg("Read", { file_path: `${REPO}/package.json` }),
    toolMsg("Edit", { file_path: `${REPO}/package.json`, old_string: "a", new_string: "b" }),
    toolMsg("Write", { file_path: `${REPO}/vite.config.ts`, content: "export default {}\n" }),
    toolMsg("Bash", { command: "npm run build" }, { output: "✓ built in 1.2s" }),
    toolMsg("Bash", { command: "ls dist" }, { output: "index.html assets" }),
    assistantMsg("已完成迁移：配置已替换为 vite.config.ts，构建通过。"),
  ];
}

/** 中止：3 completed + 1 in_progress + 1 pending，最后一条工具 interrupted，user 行 error。 */
export function TURN_ABORTED_3_OF_5(): ChatMessage[] {
  const todos: TodoLike[] = [
    { content: "盘点仓库结构", status: "completed" },
    { content: "迁移配置", status: "completed" },
    { content: "修正引用路径", status: "completed" },
    { content: "构建静态站", status: "in_progress", activeForm: "正在构建静态站" },
    { content: "输出产物清单", status: "pending" },
  ];
  return [
    userMsg("帮我把文档站迁到 Vite", { status: "error" }),
    todoWriteMsg(todos),
    toolMsg("Read", { file_path: `${REPO}/package.json` }),
    toolMsg("Edit", { file_path: `${REPO}/package.json`, old_string: "a", new_string: "b" }),
    toolMsg("Bash", { command: "npm run build" }, { interrupted: true }),
  ];
}

/** 产物：Write a.md → Edit b.ts → 再 Write a.md → Bash 输出含本机预览 URL → assistant；已收口。 */
export function TURN_DELIVERABLES(): ChatMessage[] {
  return [
    userMsg("生成报告并起本地预览", { status: "replied" }),
    toolMsg("Write", { file_path: "/home/agent/.openclaude/generated/a.md", content: "# 标题\n正文" }),
    toolMsg("Edit", { file_path: `${REPO}/b.ts`, old_string: "a", new_string: "b" }),
    toolMsg("Write", { file_path: "/home/agent/.openclaude/generated/a.md", content: "# 标题\n正文 v2" }),
    toolMsg("Bash", { command: "npm run dev" }, { output: "  ➜  Local:   http://localhost:5173/" }),
    assistantMsg("已完成迁移，产物见下。"),
  ];
}

/** 3 个 turn 各 2 个文件，其中 index.html 在 turn1 与 turn3 各写一次；全部已收口。 */
export function SESSION_3_TURNS_FILES(): ChatMessage[] {
  return [
    userMsg("建站", { status: "replied" }),
    toolMsg("Write", { file_path: `${REPO}/index.html`, content: "<h1>v1</h1>" }),
    toolMsg("Write", { file_path: `${REPO}/style.css`, content: "body{}" }),
    assistantMsg("第一版完成。"),
    userMsg("加报告", { status: "replied" }),
    toolMsg("Write", { file_path: "/home/agent/.openclaude/generated/report.md", content: "# 报告" }),
    toolMsg("Write", { file_path: `${REPO}/app.js`, content: "console.log(1)" }),
    assistantMsg("报告完成。"),
    userMsg("改首页", { status: "replied" }),
    toolMsg("Edit", { file_path: `${REPO}/index.html`, old_string: "v1", new_string: "v2" }),
    toolMsg("Write", { file_path: "/home/agent/.openclaude/generated/chart.png", content: "" }),
    assistantMsg("首页已更新。"),
  ];
}

/** 纯文本问答：无 tool、无计划。 */
export function TURN_PLAIN_CHAT(): ChatMessage[] {
  return [
    userMsg("stickToBottom 和 wheelFence 的职责边界是什么？", { status: "replied" }),
    assistantMsg("两者是单写者 + 篱笆的关系：stickToBottom 是唯一会写 scrollTop 的地方……"),
  ];
}

/** 有工具无计划：3 条工具，最后一条运行中。 */
export function TURN_TOOLS_NO_PLAN(): ChatMessage[] {
  return [
    userMsg("看看仓库里哪里还在用 require"),
    toolMsg("Grep", { pattern: "require\\(" }, { output: "src/a.js:1\nsrc/b.js:9" }),
    toolMsg("Read", { file_path: `${REPO}/src/a.js` }, { output: "const x = require('x')" }),
    toolMsg("Bash", { command: "npm run lint" }, { completed: false, output: "> biome check ." }),
  ];
}

/** 200 条顶层工具的超长 turn（最后一条运行中）。 */
export function TURN_LONG_200(): ChatMessage[] {
  const out: ChatMessage[] = [userMsg("批量重命名 200 个文件")];
  for (let i = 1; i <= 200; i++) {
    out.push(
      toolMsg(
        i % 3 === 0 ? "Bash" : "Edit",
        i % 3 === 0
          ? { command: `mv old-${i}.ts new-${i}.ts` }
          : { file_path: `${REPO}/src/file-${i}.ts`, old_string: `old-${i}`, new_string: `new-${i}` },
        { completed: i < 200 },
      ),
    );
  }
  return out;
}
