import { describe, expect, test } from "vitest";
import { stripAnsi } from "./stripAnsi";
import { normalizeToolForDisplay } from "./format";

describe("stripAnsi", () => {
  test("剥 vitest 彩色行，保留勾和耗时", () => {
    const raw =
      "     \u001b[33m\u001b[2m✓\u001b[22m\u001b[39m sets objective and both optional budgets \u001b[33m 1349\u001b[2mms\u001b[22m\u001b[39m";
    expect(stripAnsi(raw)).toBe("     ✓ sets objective and both optional budgets  1349ms");
  });

  test("剥文件级 vitest 摘要", () => {
    const raw =
      " \u001b[32m✓\u001b[39m src/components/GoalDialog.test.tsx \u001b[2m(\u001b[22m\u001b[2m3 tests\u001b[22m\u001b[2m)\u001b[22m\u001b[33m 1970\u001b[2mms\u001b[22m\u001b[39m";
    expect(stripAnsi(raw)).toBe(" ✓ src/components/GoalDialog.test.tsx (3 tests) 1970ms");
  });

  test("256 色与真彩", () => {
    expect(stripAnsi("\u001b[38;5;82mgreen\u001b[0m")).toBe("green");
    expect(stripAnsi("\u001b[38;2;255;128;0morange\u001b[39m")).toBe("orange");
  });

  test("无 ESC 的字面 [33m 原样保留", () => {
    expect(stripAnsi("code uses [33m as a token")).toBe("code uses [33m as a token");
  });

  test("空串短路", () => {
    expect(stripAnsi("")).toBe("");
  });
});

describe("normalizeToolForDisplay 剥工具输出 ANSI", () => {
  test("Read output 去色", () => {
    const d = normalizeToolForDisplay({
      toolName: "Read",
      inputJson: { file_path: "/tmp/a.tsx" },
      output:
        "     \u001b[33m\u001b[2m✓\u001b[22m\u001b[39m 保留未就绪 Agent \u001b[33m 581\u001b[2mms\u001b[22m\u001b[39m",
      _completed: true,
    });
    expect(d.tool.output).toBe("     ✓ 保留未就绪 Agent  581ms");
    expect(d.tool.output).not.toMatch(/\[33m/);
  });

  test("Bash bashTail 去色", () => {
    const d = normalizeToolForDisplay({
      toolName: "Bash",
      inputJson: { command: "npx vitest run" },
      bashTail: {
        tail: "\u001b[32m✓\u001b[39m 3 passed",
        totalBytes: 20,
        truncatedHead: false,
      },
      _completed: true,
    });
    expect(d.tool.bashTail?.tail).toBe("✓ 3 passed");
  });
});
