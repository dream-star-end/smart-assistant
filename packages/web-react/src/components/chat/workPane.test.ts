import { describe, expect, test } from "vitest";
import type { ChatMessage } from "../../lib/chat/model";
import { collectFileChanges, collectPaneSteps, toolChangedFileCount } from "./workPane";

const TS = 1_700_000_000_000;
const user = (id: string, text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, role: "user", text, ts: TS, ...extra });
const tool = (id: string, toolName: string, inputJson: Record<string, unknown>, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role: "tool",
  text: toolName,
  ts: TS,
  toolName,
  inputJson,
  _completed: true,
  output: "ok",
  ...extra,
});

describe("collectPaneSteps", () => {
  test("按 user 消息分轮;开头没有 user 的段叫「会话开始」;排队中的消息不开新轮;没有工具的轮不出现", () => {
    const { turns, steps } = collectPaneSteps([
      tool("cron", "Bash", { command: "date" }),
      user("u1", "  只聊天\n不动手 "),
      { id: "a1", role: "assistant", text: "好", ts: TS },
      user("u2", "跑一下"),
      tool("t1", "Bash", { command: "ls" }),
      user("q", "排队里", { status: "queued" }),
      tool("t2", "Read", { file_path: "/a" }),
    ]);
    expect(turns.map((t) => [t.title, t.steps.map((s) => s.message.id)])).toEqual([
      ["会话开始", ["cron"]],
      ["跑一下", ["t1", "t2"]],
    ]);
    expect(steps.map((s) => s.message.id)).toEqual(["cron", "t1", "t2"]);
  });

  test("长标题截到 60 字", () => {
    const { turns } = collectPaneSteps([user("u", "长".repeat(80)), tool("t", "Bash", { command: "x" })]);
    expect(turns[0]?.title).toBe(`${"长".repeat(60)}…`);
  });
});

describe("collectFileChanges", () => {
  test("Edit 按行 diff 计数(未变行不算);codex apply_patch 按 unified diff 计数;heredoc 写文件记路径不计行", () => {
    const files = collectFileChanges([
      tool("e", "Edit", { file_path: "/w/a.ts", old_string: "keep\nold", new_string: "keep\nnew\nmore" }),
      tool("p", "Edit", {
        file_path: "/w/b.ts",
        changes: [{ path: "/w/b.ts", kind: { type: "update" }, diff: "--- a\n+++ b\n@@\n-x\n+y\n+z\n ctx" }],
      }),
      tool("n", "Write", {
        file_path: "/w/new.md",
        kind: "add",
        changes: [{ path: "/w/new.md", kind: { type: "add" }, diff: "第一行\n第二行\n第三行\n" }],
      }),
      tool("s", "Bash", { command: "mkdir -p /w && cat > /w/c.txt <<'EOF'\nhello\nEOF" }),
    ]);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    expect([byPath["/w/a.ts"]?.added, byPath["/w/a.ts"]?.removed]).toEqual([2, 1]);
    expect(byPath["/w/c.txt"]?.entries[0]?.kind).toBe("shell");
    expect(byPath["/w/c.txt"]?.entries[0]?.added).toBeNull();
    expect([byPath["/w/b.ts"]?.entries[0]?.kind, byPath["/w/b.ts"]?.added, byPath["/w/b.ts"]?.removed]).toEqual(["patch", 2, 1]);
    // add 的 diff 是新文件全文
    expect([byPath["/w/new.md"]?.added, byPath["/w/new.md"]?.removed]).toEqual([3, 0]);
  });

  test("再次 Write 与上次写入全文做 diff;中间被 Edit 过就不再拿旧全文;失败的写入不计行、标 hasError", () => {
    const files = collectFileChanges([
      tool("w1", "Write", { file_path: "/f", content: "a\nb" }),
      tool("w2", "Write", { file_path: "/f", content: "a\nc" }),
      tool("e", "Edit", { file_path: "/f", old_string: "a", new_string: "A" }),
      tool("w3", "Write", { file_path: "/f", content: "z" }),
      tool("w4", "Write", { file_path: "/g", content: "1\n2" }, { error: true, output: "denied" }),
    ]);
    const f = files.find((x) => x.path === "/f");
    expect(f?.entries.map((e) => [e.kind, e.added, e.removed, e.previousContent !== undefined])).toEqual([
      ["write", 2, 0, false],
      ["write", 1, 1, true],
      ["edit", 1, 1, false],
      ["write", 1, 0, false],
    ]);
    const g = files.find((x) => x.path === "/g");
    expect(g?.hasError).toBe(true);
    expect(g?.added).toBe(0);
  });

  test("运行中的写入标 running", () => {
    const files = collectFileChanges([tool("w", "Write", { file_path: "/f", content: "x" }, { _completed: false, output: "" })]);
    expect(files[0]?.running).toBe(true);
  });
});

describe("toolChangedFileCount", () => {
  test("数不同文件;失败的写入与非写文件工具不算", () => {
    expect(
      toolChangedFileCount([
        tool("a", "Edit", { file_path: "/a", old_string: "1", new_string: "2" }),
        tool("b", "Write", { file_path: "/a", content: "3" }),
        tool("c", "Write", { file_path: "/b", content: "3" }, { error: true }),
        tool("d", "Bash", { command: "ls" }),
        tool("e", "Read", { file_path: "/c" }),
      ]),
    ).toBe(1);
  });
});
