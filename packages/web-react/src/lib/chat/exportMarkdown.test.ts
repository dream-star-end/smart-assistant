import { describe, expect, test } from "vitest";
import {
  exportSessionMarkdown,
  formatExportTime,
  sessionExportFilename,
} from "./exportMarkdown";
import type { ChatMessage } from "./model";

function msg(partial: Partial<ChatMessage> & Pick<ChatMessage, "id" | "role">): ChatMessage {
  return {
    text: "",
    ts: Date.UTC(2026, 0, 2, 3, 4, 5),
    ...partial,
  };
}

describe("exportSessionMarkdown", () => {
  test("只收 user/assistant/tool，按 ## 用户/助手 + 本地时间 + 正文", () => {
    const md = exportSessionMarkdown([
      msg({ id: "u1", role: "user", text: "你好" }),
      msg({ id: "t1", role: "thinking", text: "内部思考" }),
      msg({ id: "a1", role: "assistant", text: "世界" }),
      msg({
        id: "tool1",
        role: "tool",
        toolName: "Bash",
        inputPreview: "ls -la",
        text: "ignored-body",
      }),
      msg({ id: "sys", role: "system", text: "系统提示" }),
    ]);
    expect(md).toContain("## 用户");
    expect(md).toContain("你好");
    expect(md).toContain("## 助手");
    expect(md).toContain("世界");
    expect(md).toContain("## 工具");
    expect(md).toContain("Bash ls -la");
    expect(md).not.toContain("内部思考");
    expect(md).not.toContain("系统提示");
    expect(md).not.toContain("ignored-body");
    const when = formatExportTime(Date.UTC(2026, 0, 2, 3, 4, 5));
    expect(when).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(md).toContain(when);
  });

  test("tool 缺 toolName/preview 时回落 tool", () => {
    const md = exportSessionMarkdown([msg({ id: "t", role: "tool" })]);
    expect(md).toContain("tool");
  });

  test("空列表得到空串", () => {
    expect(exportSessionMarkdown([])).toBe("");
  });
});

describe("sessionExportFilename", () => {
  test("默认新对话.md，去掉路径分隔", () => {
    expect(sessionExportFilename(null)).toBe("新对话.md");
    expect(sessionExportFilename("  ")).toBe("新对话.md");
    expect(sessionExportFilename("周报")).toBe("周报.md");
    expect(sessionExportFilename("a/b\\c")).toBe("a_b_c.md");
  });
});
