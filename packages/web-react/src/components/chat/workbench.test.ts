/** OCV5-372 产出页数据源:按轮切分、本轮产出、主产物选择、文件全文回放、摘要。 */
import { describe, expect, test } from "vitest";
import type { ChatMessage } from "../../lib/chat/model";
import {
  collectTurnOutputs,
  collectWorkTurns,
  displayDir,
  fileSnapshot,
  formatDuration,
  outputKindOf,
  pickHero,
  turnIndexOf,
  turnSummary,
} from "./workbench";

const TS = 1_700_000_000_000;

function user(id: string, text: string, ts = TS): ChatMessage {
  return { id, role: "user", text, ts, status: "replied" };
}
function assistant(id: string, text: string, ts = TS): ChatMessage {
  return { id, role: "assistant", text, ts };
}
function tool(id: string, toolName: string, inputJson: Record<string, unknown>, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: "tool", text: toolName, ts: TS, toolName, inputJson, _completed: true, output: "ok", ...extra };
}

describe("collectWorkTurns", () => {
  test("每条 user 消息开一轮;只有回答没有工具的轮也保留;排队中的消息不算", () => {
    const turns = collectWorkTurns([
      user("u1", "你好"),
      assistant("a1", "你好！"),
      user("u2", "写个脚本"),
      tool("t1", "Write", { file_path: "/w/a.py", content: "print(1)\n" }),
      { ...user("u3", "排队中"), status: "queued" },
    ]);
    expect(turns.map((t) => t.key)).toEqual(["u1", "u2"]);
    expect(turns[0].steps).toHaveLength(0);
    expect(turns[1].steps.map((m) => m.id)).toEqual(["t1"]);
    expect(turnIndexOf(turns, { id: "t1" })).toBe(1);
    expect(turnIndexOf(turns, { id: "u1" })).toBe(0);
    expect(turnIndexOf(turns, { id: "nope" })).toBe(-1);
  });
});

describe("collectTurnOutputs", () => {
  test("改过的文件、回答里的图片与容器文件、本机预览链接、搜索与抓取来源;失败的搜索不收", () => {
    const [turn] = collectWorkTurns([
      user("u1", "做个页面并配图"),
      tool("s1", "WebSearch", { query: "x" }, { output: "Results:\n  - [MDN Grid](https://developer.mozilla.org/grid): 文档\n  - [CSS Tricks](https://www.css-tricks.com/g): 指南" }),
      tool("s2", "WebFetch", { url: "https://example.com/a", prompt: "读" }),
      tool("s3", "WebSearch", { query: "y" }, { output: "  - [Bad](https://bad.example)", error: true, _completed: true }),
      tool("w1", "Write", { file_path: "/home/agent/.openclaude/workspace/site/index.html", content: "<h1>hi</h1>\n" }),
      assistant(
        "a1",
        "完成。截图 `/home/agent/.openclaude/workspace/site/shot.png`，报告 `/home/agent/.openclaude/workspace/site/report.docx`，已在 http://localhost:5173/ 启动预览。",
      ),
    ]);
    const o = collectTurnOutputs(turn);
    expect(o.files.map((f) => [f.name, f.kind, !!f.change])).toEqual([
      ["index.html", "html", true],
      ["report.docx", "file", false],
    ]);
    expect(o.media.map((m) => m.name)).toEqual(["shot.png"]);
    expect(o.links.map((l) => l.url)).toEqual(["http://localhost:5173/"]);
    expect(o.sources.map((s) => [s.title, s.domain])).toEqual([
      ["MDN Grid", "developer.mozilla.org"],
      ["CSS Tricks", "css-tricks.com"],
      ["example.com", "example.com"],
    ]);
  });

  test("写出的图片文件进图片区,不在文件区重复", () => {
    const [turn] = collectWorkTurns([user("u1", "画图"), tool("w1", "Write", { file_path: "/w/logo.svg", content: "<svg/>" })]);
    const o = collectTurnOutputs(turn);
    expect(o.files).toHaveLength(0);
    expect(o.media.map((m) => m.src)).toEqual(["/w/logo.svg"]);
  });
});

describe("pickHero", () => {
  test("网页 > 文档 > 图片 > 改动最多的代码", () => {
    const turns = collectWorkTurns([
      user("u1", "a"),
      tool("w1", "Write", { file_path: "/w/a.py", content: "1\n2\n3\n" }),
      tool("w2", "Write", { file_path: "/w/b.py", content: "1\n2\n3\n4\n5\n" }),
      tool("w3", "Write", { file_path: "/w/README.md", content: "# x\n" }),
      user("u2", "b"),
      tool("w4", "Write", { file_path: "/w/a.py", content: "1\n" }),
      tool("w5", "Write", { file_path: "/w/b.py", content: "1\n2\n" }),
      assistant("a2", "见 `/w/pic.png`"),
      user("u3", "c"),
      tool("w6", "Write", { file_path: "/w/a.py", content: "x\n" }),
      tool("w7", "Write", { file_path: "/w/b.py", content: "1\n2\n3\n4\n5\n6\n7\n" }),
    ]);
    expect(pickHero(collectTurnOutputs(turns[0]))).toEqual({ type: "file", path: "/w/README.md" });
    expect(pickHero(collectTurnOutputs(turns[1]))).toEqual({ type: "media", src: "/w/pic.png" });
    expect(pickHero(collectTurnOutputs(turns[2]))).toEqual({ type: "file", path: "/w/b.py" });
    expect(pickHero({ files: [], media: [], links: [], sources: [] })).toBeNull();
  });
});

describe("fileSnapshot", () => {
  test("Write 后的 Edit / MultiEdit 回放成当前全文;按轮截止", () => {
    const messages = [
      user("u1", "a"),
      tool("w1", "Write", { file_path: "/w/a.py", content: "a = 1\nb = 2\n" }),
      tool("e1", "Edit", { file_path: "/w/a.py", old_string: "a = 1", new_string: "a = 10" }),
      user("u2", "b"),
      tool("e2", "MultiEdit", { file_path: "/w/a.py", edits: [{ old_string: "b = 2", new_string: "b = 20" }, { old_string: "\n", new_string: "\n# x\n", replace_all: true }] }),
    ];
    expect(fileSnapshot(messages, "/w/a.py", messages[2])).toBe("a = 10\nb = 2\n");
    expect(fileSnapshot(messages, "/w/a.py")).toBe("a = 10\n# x\nb = 20\n# x\n");
  });

  test("回放不出来 → null:没有全文、Edit 对不上、shell 改写过、失败的写入不算", () => {
    expect(fileSnapshot([tool("e1", "Edit", { file_path: "/w/a.py", old_string: "x", new_string: "y" })], "/w/a.py")).toBeNull();
    expect(
      fileSnapshot(
        [tool("w1", "Write", { file_path: "/w/a.py", content: "a\n" }), tool("e1", "Edit", { file_path: "/w/a.py", old_string: "zzz", new_string: "y" })],
        "/w/a.py",
      ),
    ).toBeNull();
    expect(
      fileSnapshot(
        [tool("w1", "Write", { file_path: "/w/a.py", content: "a\n" }), tool("b1", "Bash", { command: "sed -i s/a/b/ /w/a.py" })],
        "/w/a.py",
      ),
    ).toBeNull();
    expect(
      fileSnapshot(
        [tool("w1", "Write", { file_path: "/w/a.py", content: "a\n" }), tool("w2", "Write", { file_path: "/w/a.py", content: "b\n" }, { error: true, output: "denied" })],
        "/w/a.py",
      ),
    ).toBe("a\n");
  });

  test("只读文件的命令不影响回放", () => {
    expect(
      fileSnapshot([tool("w1", "Write", { file_path: "/w/a.py", content: "a\n" }), tool("b1", "Bash", { command: "python3 /w/a.py" })], "/w/a.py"),
    ).toBe("a\n");
  });
});

describe("turnSummary / formatDuration / outputKindOf", () => {
  test("用时从 user 消息到本轮最后一行;失败步骤计数", () => {
    const [turn] = collectWorkTurns([
      user("u1", "a", TS),
      tool("t1", "Bash", { command: "ls" }, { ts: TS + 1000, completedAt: TS + 5000 }),
      tool("t2", "Bash", { command: "false" }, { ts: TS + 6000, error: true, output: "exit 1" }),
      assistant("a1", "好", TS + 72_000),
    ]);
    const s = turnSummary(turn, false);
    expect(s).toMatchObject({ status: "done", durationMs: 72_000, steps: 2, failedSteps: 1 });
    expect(turnSummary(turn, true).status).toBe("running");
    expect(formatDuration(s.durationMs ?? 0)).toBe("1 分 12 秒");
    expect(formatDuration(8_400)).toBe("8 秒");
  });

  test("扩展名归类", () => {
    expect(["a.html", "b.MD", "c.png", "d.ts", "e.csv", "f.docx", "Dockerfile"].map(outputKindOf)).toEqual([
      "html",
      "markdown",
      "image",
      "code",
      "text",
      "file",
      "code",
    ]);
  });
});

describe("来源与目录显示", () => {
  test("内置 WebSearch 的原生结果(Links: [...])也收进参考来源,去重、只收 http(s)", () => {
    const output =
      'Web search results for query: "x"\n\nLinks: [{"title":"Landing page","url":"https://designsystem.digital.gov/templates/landing/"},{"title":"Heroes","url":"https://cfpb.github.io/heroes"},{"title":"dup","url":"https://cfpb.github.io/heroes"},{"title":"js","url":"javascript:alert(1)"}]\n\n正文…';
    const [turn] = collectWorkTurns([user("u1", "搜"), tool("s1", "WebSearch", { query: "x" }, { output })]);
    expect(collectTurnOutputs(turn).sources.map((s) => [s.title, s.domain])).toEqual([
      ["Landing page", "designsystem.digital.gov"],
      ["Heroes", "cfpb.github.io"],
    ]);
  });

  test("会话工作区里的文件显示相对工作区的目录", () => {
    expect(displayDir("/home/agent/.openclaude/workspace/sessions/webabc/cc3wb/index.html")).toBe("工作区/cc3wb");
    expect(displayDir("/home/agent/.openclaude/workspace/a.md")).toBe("工作区");
    expect(displayDir("/etc/nginx/nginx.conf")).toBe("/etc/nginx");
  });
});
