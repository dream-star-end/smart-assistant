import { describe, expect, test } from "vitest";
import {
  BROWSER_HOME,
  browserShotPaths,
  browserStepOf,
  collectBrowserSteps,
  displayAddress,
  isDeliverableShot,
  resolveBrowserPath,
} from "./browserSteps";

// playwright-cli 真实输出形状(goto + resize + screenshot,截图是相对路径)。
const GOTO_SHOT = [
  "### Ran Playwright code",
  "```js",
  "await page.goto('http://127.0.0.1:8765/demo.html');",
  "```",
  "### Page",
  "- Page URL: http://127.0.0.1:8765/demo.html",
  "- Page Title: Demo",
  "### Snapshot",
  "- [Snapshot](.playwright-cli/page-2026-10-11T00-50-53-736Z.yml)",
  "### Ran Playwright code",
  "```js",
  "await page.setViewportSize({ width: 1100, height: 900 });",
  "```",
  "### Result",
  "- [Screenshot of viewport](.playwright-cli/page-2026-10-11T00-50-55-101Z.png)",
].join("\n");

const bash = (command: string, output: string, extra: Record<string, unknown> = {}) => ({
  id: `t-${command.length}-${output.length}`,
  role: "tool",
  toolName: "Bash",
  inputJson: { command },
  output,
  _completed: true,
  ...extra,
});

describe("resolveBrowserPath / browserShotPaths", () => {
  test("相对 .playwright-cli 路径按 oc-browser 的工作目录解析,不再截出 /page-….png", () => {
    expect(resolveBrowserPath(".playwright-cli/page-1.png")).toBe(`${BROWSER_HOME}/.playwright-cli/page-1.png`);
    expect(browserShotPaths(GOTO_SHOT)).toEqual([`${BROWSER_HOME}/.playwright-cli/page-2026-10-11T00-50-55-101Z.png`]);
    expect(browserShotPaths(GOTO_SHOT).some((p) => p.startsWith("/page-"))).toBe(false);
  });

  test("绝对路径照收;非图片、穿越、协议、控制字符拒绝", () => {
    expect(resolveBrowserPath("/home/agent/.openclaude/generated/a.png")).toBe("/home/agent/.openclaude/generated/a.png");
    expect(resolveBrowserPath(".playwright-cli/page.yml")).toBeNull();
    expect(resolveBrowserPath("../etc/x.png")).toBeNull();
    expect(resolveBrowserPath("file:///tmp/x.png")).toBeNull();
    expect(resolveBrowserPath("//evil/x.png")).toBeNull();
    expect(resolveBrowserPath("/tmp/x\u0000.png")).toBeNull();
  });

  test("路径中段不算:foo/page.png 不会被当成 /page.png", () => {
    expect(browserShotPaths("saved to foo/page.png")).toEqual([]);
    expect(browserShotPaths("saved /home/agent/.openclaude/generated/from-output.png")).toEqual([
      "/home/agent/.openclaude/generated/from-output.png",
    ]);
  });

  test("交付目录判定", () => {
    expect(isDeliverableShot("/home/agent/.openclaude/generated/a.png")).toBe(true);
    expect(isDeliverableShot(`${BROWSER_HOME}/.playwright-cli/page.png`)).toBe(false);
  });
});

describe("browserStepOf", () => {
  test("goto && resize && screenshot:动作序列、页面、截图", () => {
    const step = browserStepOf(
      bash("oc-browser goto 'http://127.0.0.1:8765/demo.html' && oc-browser resize 1100 900 && sleep 1.2 && oc-browser screenshot", GOTO_SHOT),
    );
    expect(step?.actions.map((a) => [a.label, a.detail])).toEqual([
      ["打开网页", "http://127.0.0.1:8765/demo.html"],
      ["调整窗口", "1100×900"],
      ["截图", ""],
    ]);
    expect(step?.url).toBe("http://127.0.0.1:8765/demo.html");
    expect(step?.title).toBe("Demo");
    expect(step?.shots).toEqual([`${BROWSER_HOME}/.playwright-cli/page-2026-10-11T00-50-55-101Z.png`]);
    expect(step?.error).toBe("");
    expect(step?.running).toBe(false);
  });

  test("失败:首个 Error 行,没有截图和标题", () => {
    const step = browserStepOf(
      bash(
        "oc-browser open 'file:///tmp/demo.html' && oc-browser screenshot",
        '### Browser `browser` opened with pid 2343.\n### Error\nError: Access to "file:" protocol is blocked.\nexit 1',
      ),
    );
    expect(step?.error).toBe('Error: Access to "file:" protocol is blocked.');
    expect(step?.shots).toEqual([]);
    expect(step?.title).toBe("");
  });

  test("--filename 而输出没给路径:卡片可用 requestedShots,shots 为空(折叠规则只认输出)", () => {
    const step = browserStepOf(bash("oc-browser screenshot --filename=/home/agent/.openclaude/generated/x.png", "Saved screenshot"));
    expect(step?.shots).toEqual([]);
    expect(step?.requestedShots).toEqual(["/home/agent/.openclaude/generated/x.png"]);
  });

  test("运行中", () => {
    const step = browserStepOf(bash("oc-browser click e12", "", { _completed: false }));
    expect(step?.running).toBe(true);
    expect(step?.actions).toEqual([{ verb: "click", label: "点击", detail: "e12" }]);
  });

  test("fill 显示目标与输入", () => {
    const step = browserStepOf(bash('oc-browser fill e5 "hello world"', "ok"));
    expect(step?.actions[0]?.detail).toBe("e5 ← hello world");
  });

  test("不是浏览器操作:普通命令、oc-browser 只出现在参数里", () => {
    expect(browserStepOf(bash("ls -la", "x"))).toBeNull();
    expect(browserStepOf(bash("echo oc-browser open https://a.example", "x"))).toBeNull();
    expect(browserStepOf(bash("oc-browser frobnicate", "x"))).toBeNull();
  });

  test("MCP browser_navigate / browser_take_screenshot", () => {
    const nav = browserStepOf({
      toolName: "mcp__browser__browser_navigate",
      inputJson: { url: "https://example.com/a?b=1" },
      output: "- Page URL: https://example.com/a?b=1\n- Page Title: Example",
      _completed: true,
    });
    expect(nav?.actions).toEqual([{ verb: "goto", label: "打开网页", detail: "https://example.com/a?b=1" }]);
    expect(nav?.title).toBe("Example");
    const shot = browserStepOf({
      toolName: "mcp__browser__browser_take_screenshot",
      inputJson: { filename: "/home/agent/.openclaude/generated/s.png" },
      output: "Took the screenshot",
      _completed: true,
    });
    expect(shot?.requestedShots).toEqual(["/home/agent/.openclaude/generated/s.png"]);
    expect(browserStepOf({ toolName: "mcp__minimax-media__x", inputJson: {}, _completed: true })).toBeNull();
  });
});

test("collectBrowserSteps 只收工具行里的浏览器操作,按顺序", () => {
  const rows = [
    { id: "a", role: "assistant", text: "hi" },
    bash("ls", "x"),
    bash("oc-browser open https://a.example", "- Page Title: A"),
    bash("oc-browser click e1", "ok"),
  ];
  expect(collectBrowserSteps(rows).map((s) => s.step.actions[0]?.verb)).toEqual(["open", "click"]);
});

test("displayAddress", () => {
  expect(displayAddress("https://www.example.com/")).toEqual({ host: "example.com", path: "" });
  expect(displayAddress("http://127.0.0.1:8765/demo.html?x=1")).toEqual({ host: "127.0.0.1:8765", path: "/demo.html?x=1" });
  expect(displayAddress("not a url")).toEqual({ host: "not a url", path: "" });
});
