import { describe, expect, test } from "vitest";
import type { ChatMessage } from "../../lib/chat/model";
import { collectFileChanges, collectPaneSteps, toolChangedFileCount } from "./workPane";
import { collectWorkTurns, formatStepSummary, formatWorkTurnTitle } from "./workTurns";

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

  test("裁剪正文的旧 Edit/Write：优先从输出解析 (+N/-M lines)，无行数时 hasCounts=false 不报假 +0 -0", () => {
    const files = collectFileChanges([
      tool("e-out", "Edit", { file_path: "/w/parsed.ts" }, { output: "Made 1 replacement in /w/parsed.ts starting at line 18 (+5/-2 lines)." }),
      tool("e-empty", "Edit", { file_path: "/w/no-body.ts" }, { output: "ok" }),
      tool("w-empty", "Write", { file_path: "/w/no-content.ts" }, { output: "Created file." }),
    ]);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(byPath["/w/parsed.ts"]?.hasCounts).toBe(true);
    expect([byPath["/w/parsed.ts"]?.added, byPath["/w/parsed.ts"]?.removed]).toEqual([5, 2]);
    expect(byPath["/w/no-body.ts"]?.hasCounts).toBe(false);
    expect(byPath["/w/no-body.ts"]?.entries[0]?.added).toBeNull();
    expect(byPath["/w/no-content.ts"]?.hasCounts).toBe(false);
    expect(byPath["/w/no-content.ts"]?.entries[0]?.added).toBeNull();
  });

  test("同一文件依次 Write(A) -> 无正文 Write -> Write(A) 时清除过期基线，不误渲染 +0 -0 覆盖 diff", () => {
    const files = collectFileChanges([
      tool("w1", "Write", { file_path: "/w/re.ts", content: "a\nb\n" }),
      tool("w2", "Write", { file_path: "/w/re.ts" }, { output: "Created file." }),
      tool("w3", "Write", { file_path: "/w/re.ts", content: "a\nb\n" }),
    ]);
    const f = files[0]!;
    expect(f.entries[0]?.added).toBe(2);
    expect(f.entries[1]?.added).toBeNull();
    expect(f.entries[2]?.previousContent).toBeUndefined();
    expect(f.entries[2]?.added).toBe(2);
    expect(f.entries[2]?.removed).toBe(0);
  });
});

describe("解析缓存", () => {
  test("同一消息对象复用结果;输入就地变化(partialJson 增长 / inputJson 替换)后重算", () => {
    const m = tool("w", "Write", { file_path: "/a", content: "1" }, { _completed: false, inputJson: undefined, partialJson: '{"file_path":"/a","content":"1' });
    expect(collectFileChanges([m])[0]?.added).toBe(1);
    m.partialJson = '{"file_path":"/a","content":"1\\n2\\n3';
    expect(collectFileChanges([m])[0]?.added).toBe(3);
    m.partialJson = undefined;
    m.inputJson = { file_path: "/b", content: "x" };
    m._inputRevision = 1;
    m._completed = true;
    expect(collectFileChanges([m]).map((f) => f.path)).toEqual(["/b"]);
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

describe("轮次标题人话化与步骤命令噪音清洗(OCV5-834)", () => {
  test("清洗系统发版回调与 lease / emoji / 长 hex 噪音", () => {
    expect(formatWorkTurnTitle("🎫 lease ls-20261121T072712Z-c88785cc5d71 已满足，流量已切至新版本")).toBe("发布上线完成");
    expect(formatWorkTurnTitle("🎫 lease ls-20261121T052412Z-886bdfc6cf36 失败：就绪探测超时")).toBe("发布列车未切流");
    expect(formatWorkTurnTitle("🚨 发版主工作树无法快进到 origin tip 7734e3a01b2c3d4e")).toBe("发版同步提示");
    expect(formatWorkTurnTitle("🚀 重构右栏 Workbench 7734e3a01b2c3d4e5f6a")).toBe("重构右栏 Workbench");

    const turns = collectWorkTurns([
      user("u1", "🎫 lease ls-20261121T072712Z-c88785cc5d71 已满足"),
      tool("t1", "Bash", { command: "echo ok" }),
    ]);
    expect(turns[0]?.title).toBe("发布上线完成");
  });

  test("步骤副摘要优先取人话 toolSummary，并剥离 env HOME=/home/agent host 桥接与 set/export 样板", () => {
    expect(
      formatStepSummary(
        "Bash",
        {
          toolSummary: "运行设计系统防回潮门禁",
          command: "env HOME=/home/agent /home/agent/.local/bin/host 'vitest run'",
        },
        "env HOME=/home/agent /home/agent/.local/bin/host 'vitest run'",
      ),
    ).toBe("运行设计系统防回潮门禁");

    const hostCmd = [
      "env HOME=/home/agent /home/agent/.local/bin/host '",
      '  export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="*"',
      "  set -euo pipefail",
      "  cd /var/lib/docker/volumes/oc-v5-data-u3/_data/workspace/ocv5-832-codex-redesign",
      "  ../../node_modules/.bin/vitest run src/test/designTokens.test.ts",
      "'",
    ].join("\n");
    const cleaned = formatStepSummary("Bash", { command: hostCmd }, "env HOME=/home/agent /home/agent/.loca…");
    expect(cleaned).toBe("vitest run src/test/designTokens.test.ts");
    expect(cleaned).not.toContain("env HOME=");
    expect(cleaned).not.toContain("GIT_CONFIG_COUNT");
    expect(cleaned).not.toContain("set -euo");
  });
});
