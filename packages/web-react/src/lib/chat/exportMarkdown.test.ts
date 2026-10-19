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
  test("只收真实提问和最终回答，按 ## 用户/助手 + 本地时间 + 正文", async () => {
    const md = await exportSessionMarkdown([
      msg({ id: "u1", role: "user", text: "你好" }),
      msg({ id: "t1", role: "thinking", text: "内部思考" }),
      msg({ id: "process", role: "assistant", text: "正在处理" }),
      msg({
        id: "tool1",
        role: "tool",
        toolName: "Bash",
        inputPreview: "ls -la",
        text: "ignored-body",
      }),
      msg({ id: "a1", role: "assistant", text: "世界" }),
      msg({ id: "sys", role: "system", text: "系统提示" }),
    ]);
    expect(md).toContain("## 用户");
    expect(md).toContain("你好");
    expect(md).toContain("## 助手");
    expect(md).toContain("世界");
    expect(md).not.toContain("## 工具");
    expect(md).not.toContain("Bash ls -la");
    expect(md).not.toContain("正在处理");
    expect(md).not.toContain("内部思考");
    expect(md).not.toContain("系统提示");
    expect(md).not.toContain("ignored-body");
    const when = formatExportTime(Date.UTC(2026, 0, 2, 3, 4, 5));
    expect(when).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(md).toContain(when);
  });

  test("只有工具过程时不产生可分享正文", async () => {
    const md = await exportSessionMarkdown([msg({ id: "t", role: "tool" })]);
    expect(md).toBe("");
  });

  test("正在生成时不导出尚未完成的回答", async () => {
    const md = await exportSessionMarkdown([msg({ id: "u", role: "user", text: "问题" }), msg({ id: "a", role: "assistant", text: "尚未完成" })], true);
    expect(md).toContain("问题");
    expect(md).not.toContain("尚未完成");
  });

  test("preserves visible output before a terminal failure as incomplete, without error or process data", async () => {
    const rows = [
      msg({ id: "u", role: "user", text: "生成报告", _clientMessageId: "u", ts: 1 }),
      msg({ id: "tool", role: "tool", text: "PRIVATE_TOOL_OUTPUT", _clientMessageId: "u", ts: 2 }),
      msg({ id: "partial", role: "assistant", text: "已完成第一节：可用结论。", _clientMessageId: "u", ts: 3 }),
      msg({ id: "error", role: "assistant", text: "", _errorCode: "MODEL_CONFIG_CHANGED_RETRY_TURN", _clientMessageId: "u", ts: 4 }),
    ];
    const snapshot = JSON.stringify(rows);
    const md = await exportSessionMarkdown(rows);
    expect(md).toContain("## 助手（未完成）");
    expect(md).toContain("已完成第一节：可用结论。");
    expect(md).not.toContain("PRIVATE_");
    expect(JSON.stringify(rows)).toBe(snapshot);
    const { selectShareMessages } = await import("./shareSelection");
    expect(selectShareMessages(rows, "all")).toEqual([rows[0]]);
    expect(await exportSessionMarkdown([rows[0]!, rows[2]!, rows[1]!, rows[3]!])).not.toContain("可用结论");
    expect(await exportSessionMarkdown(rows, true)).not.toContain("可用结论");
  });

  test("keeps delivered file links across later tools and preserves same-row stopped output", async () => {
    const user = msg({ id: "u", role: "user", text: "生成文件", ts: 1 });
    const file = msg({ id: "file", role: "assistant", text: "[下载](/home/agent/.openclaude/generated/sales.csv)", ts: 2 });
    const tool = msg({ id: "tool", role: "tool", text: "PRIVATE_TOOL", ts: 3 });
    const error = msg({ id: "error", role: "assistant", text: "", _errorCode: "MODEL_CONFIG_CHANGED_RETRY_TURN", ts: 4 });
    const failed = await exportSessionMarkdown([user, file, tool, error]);
    expect(failed).toContain("下载（sales.csv）");
    expect(failed).toContain("助手（未完成）");
    expect(failed).not.toContain("PRIVATE_TOOL");
    const finished = await exportSessionMarkdown([user, file, tool, msg({ id: "final", role: "assistant", text: "验证完成。", ts: 4 })]);
    expect(finished).toContain("下载（sales.csv）");
    expect(finished).toContain("验证完成。");
    const stopped = await exportSessionMarkdown([user, msg({ id: "stopped", role: "assistant", text: "这是停止前已呈现的结果。\n\n[turn failed: user_cancelled]", _errorCode: "user_cancelled", ts: 4 })]);
    expect(stopped).toContain("这是停止前已呈现的结果。");
    expect(stopped).toContain("助手（未完成）");
    expect(stopped).not.toContain("turn failed");
    const internal = await exportSessionMarkdown([user, msg({ id: "internal", role: "assistant", text: '{"error":"PRIVATE_ERROR","stack":"secret"}', _errorCode: "ENGINE_ERROR", ts: 4 })]);
    expect(internal).not.toContain("PRIVATE_ERROR");
    expect(internal).not.toContain("secret");
    const partial = await exportSessionMarkdown([user, msg({ id: "partial", role: "assistant", text: "已完成的合法正文。\n\n[turn failed: engine_error]", _errorCode: "ENGINE_ERROR", ts: 4 })]);
    expect(partial).toContain("已完成的合法正文。");
    expect(partial).not.toContain("turn failed");
  });

  test("keeps a delivered file on a stopped assistant row before later tools", async () => {
    const rows = [
      msg({ id: "u", role: "user", text: "生成文件", _clientMessageId: "u", _orderSeq: 1, ts: 1 }),
      msg({ id: "file", role: "assistant", text: "已生成：[下载](/home/agent/.openclaude/generated/sales.csv)\n\n[turn failed: user_cancelled]", _errorCode: "USER_CANCELLED", _clientMessageId: "u", _orderSeq: 2, ts: 2 }),
      msg({ id: "tool", role: "tool", text: "PRIVATE_TOOL_OUTPUT", _clientMessageId: "u", _orderSeq: 3, ts: 3 }),
    ];
    const snapshot = JSON.stringify(rows);
    const md = await exportSessionMarkdown(rows);
    expect(md).toContain("下载（sales.csv）");
    expect(md).toContain("## 助手（未完成）");
    expect(md).not.toContain("PRIVATE_TOOL_OUTPUT");
    expect(md).not.toContain("turn failed");
    expect(JSON.stringify(rows)).toBe(snapshot);
    const { selectShareMessages } = await import("./shareSelection");
    expect(selectShareMessages(rows, "all")).toEqual([rows[0]]);
    const internal = await exportSessionMarkdown([rows[0]!, msg({
      id: "internal", role: "assistant", text: '{"error":"PRIVATE_ERROR","path":"/home/agent/.openclaude/generated/secret.csv"}',
      _errorCode: "ENGINE_ERROR", _clientMessageId: "u", _orderSeq: 2, ts: 2,
    }), rows[2]!]);
    expect(internal).not.toContain("PRIVATE_ERROR");
    expect(internal).not.toContain("secret.csv");
  });

  test("空列表得到空串", async () => {
    expect(await exportSessionMarkdown([])).toBe("");
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
