/** OCV5-372 产出页数据源:按轮切分、本轮产出、主产物选择、文件全文回放、摘要。 */
import { describe, expect, test } from "vitest";
import type { ChatMessage } from "../../lib/chat/model";
import {
  collectTurnOutputs,
  collectWorkTurns,
  displayDir,
  fileSnapshot,
  fileTouchFingerprint,
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

  test("其它工具提到这个文件(不论成败、不论像不像写)→ 回放不可知;没提到的不影响", () => {
    const write = tool("w1", "Write", { file_path: "/w/a.md", content: "old\n" });
    expect(fileSnapshot([write, tool("b1", "Bash", { command: "python3 -c \"open('/w/a.md','w').write('new')\"" })], "/w/a.md")).toBeNull();
    expect(
      fileSnapshot([write, tool("b2", "Bash", { command: "printf new > /w/a.md; exit 1" }, { error: true, output: "exit 1" })], "/w/a.md"),
    ).toBeNull();
    expect(fileSnapshot([write, tool("b3", "Bash", { command: "python3 a.md" })], "/w/a.md")).toBeNull();
    expect(fileSnapshot([write, tool("b4", "Bash", { command: "ls /w/other" })], "/w/a.md")).toBe("old\n");
  });

  test("取消(历史里回合中断的未完成写入)/ 受阻的写入没有落盘;运行中的写入结果未定;大记录定位桩看不到输入", () => {
    const write = tool("w1", "Write", { file_path: "/w/a.md", content: "old\n" });
    expect(
      fileSnapshot([write, tool("w2", "Write", { file_path: "/w/a.md", content: "new\n" }, { _completed: false, _timelineRecord: true, _dispatchOutcome: "interrupted", output: "" })], "/w/a.md"),
    ).toBe("old\n");
    expect(
      fileSnapshot([write, tool("w3", "Write", { file_path: "/w/a.md", content: "ne" }, { _completed: false, output: "" })], "/w/a.md"),
    ).toBeNull();
    const locator: ChatMessage = { id: "big", role: "tool", text: "", ts: TS, toolName: "Write", _payloadDeferred: true, _completed: true };
    expect(fileSnapshot([write, locator], "/w/a.md")).toBeNull();
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
    expect(s).toMatchObject({ status: "done", durationMs: 72_000, steps: 2, failedSteps: 1, statusLabel: null });
    expect(turnSummary(turn, true).status).toBe("running");
    expect(formatDuration(s.durationMs ?? 0)).toBe("1 分 12 秒");
    expect(formatDuration(8_400)).toBe("8 秒");
  });

  test("not_accepted 终态不把等到收尾的时间当成用时，本地 running 也不再盖过服务端快照", () => {
    const start = TS;
    // 体验官 /s/webmvvubze351obvb 第 2 轮：admitted 11:41:14 → terminal 14:32:43 = 10289 秒 = 2 小时 51 分。
    const terminalAt = start + 10_289_000;
    const [turn] = collectWorkTurns([
      user("u2", "预算降到 4800", start),
      {
        id: "turn-status:c4bc52a0",
        role: "system",
        text: "",
        ts: terminalAt,
        _dispatchTerminal: true,
        _errorCode: "DISPATCH_NOT_ACCEPTED",
        _clientMessageId: "u2",
      },
    ]);
    const summary = turnSummary(turn, true);
    expect(summary.status).toBe("not_started");
    expect(summary.durationMs).toBeNull();
    expect(summary.statusLabel).toBe("消息未开始处理");
    expect(summary.statusDetail).toContain("已确认未计费");
    expect(summary.steps).toBe(0);
    expect(formatDuration(10_289_000)).toBe("2 小时 51 分");
  });

  test("service_restart 停在服务端终态时刻，并使用与正文相同的标题", () => {
    const start = TS;
    const [turn] = collectWorkTurns([
      user("u", "跑", start),
      tool("t1", "Bash", { command: "a" }, { ts: start + 1000, completedAt: start + 5_000 }),
      { id: "err", role: "assistant", text: "", ts: start + 90_000, _errorCode: "service_restart" },
    ]);
    const summary = turnSummary(turn, true);
    expect(summary.status).toBe("interrupted");
    expect(summary.durationMs).toBe(90_000);
    expect(summary.statusLabel).toBe("任务已中断");
    expect(formatDuration(summary.durationMs ?? 0)).toBe("1 分 30 秒");
  });

  test("executed_error 的右栏标题与正文错误卡相同，用时停在终态行", () => {
    const start = TS;
    const [turn] = collectWorkTurns([
      user("u", "跑", start),
      tool("t1", "Bash", { command: "a" }, { ts: start + 1000, completedAt: start + 8_000 }),
      {
        id: "st",
        role: "system",
        text: "",
        ts: start + 12_000,
        _dispatchTerminal: true,
        _errorCode: "ENGINE_ERROR",
      },
    ]);
    const summary = turnSummary(turn, true);
    expect(summary.status).toBe("error");
    expect(summary.durationMs).toBe(12_000);
    expect(summary.statusLabel && summary.statusLabel.length > 0).toBe(true);
    expect(summary.statusLabel).not.toBe("消息未开始处理");
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

describe("fileTouchFingerprint", () => {
  test("提到这个文件的命令跑完、出现新写入或定位桩时变化;无关命令不变", () => {
    const write = tool("w1", "Write", { file_path: "/tmp/a.md", content: "old\n" });
    const cmd = { command: "sleep 2; python3 -c \"open('/tmp/a.md','w').write('new')\"" };
    const base = fileTouchFingerprint([write, tool("b1", "Bash", cmd, { _completed: false, output: "" })], "/tmp/a.md");
    expect(fileTouchFingerprint([write, tool("b1", "Bash", cmd)], "/tmp/a.md")).not.toBe(base);
    expect(fileTouchFingerprint([write, tool("b1", "Bash", cmd, { _completed: false, output: "" }), tool("x", "Bash", { command: "ls /etc" })], "/tmp/a.md")).toBe(base);
    const locator: ChatMessage = { id: "big", role: "tool", text: "", ts: TS, toolName: "Bash", _payloadDeferred: true, _completed: true };
    expect(fileTouchFingerprint([write, locator], "/tmp/a.md")).toContain("big:");
  });
});

describe("浏览器截图(OCV5-374)", () => {
  test("存进交付目录的截图进「图片与媒体」;默认 .playwright-cli 截图和失败的一步不进", () => {
    const [turn] = collectWorkTurns([
      user("u1", "截个图"),
      tool("b1", "Bash", { command: "oc-browser goto https://example.com && oc-browser screenshot --filename=/home/agent/.openclaude/generated/ex.png" }, {
        output: "- Page URL: https://example.com/\n- [Screenshot of viewport](/home/agent/.openclaude/generated/ex.png)",
      }),
      tool("b2", "Bash", { command: "oc-browser screenshot" }, { output: "- [Screenshot of viewport](.playwright-cli/page-1.png)" }),
      tool("b3", "Bash", { command: "oc-browser screenshot --filename=/home/agent/.openclaude/generated/bad.png" }, {
        output: "### Error\nError: Browser 'browser' is not open.",
        error: true,
      }),
      assistant("a1", "好了"),
    ]);
    const out = collectTurnOutputs(turn);
    expect(out.media).toEqual([{ src: "/home/agent/.openclaude/generated/ex.png", kind: "image", name: "ex.png" }]);
  });
});
