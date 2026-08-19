import { describe, expect, test } from "vitest";
import {
  isInternalSubtaskInput,
  isOpaqueArgToolName,
  looksLikeInternalToolPrompt,
  safeSubtaskDescription,
} from "./format";

describe("safeSubtaskDescription", () => {
  test("短中文标题保留并截断", () => {
    expect(safeSubtaskDescription({ description: "实现会话显示层根治修复" })).toBe(
      "实现会话显示层根治修复",
    );
    expect(safeSubtaskDescription({ description: "调研登录流程" })).toBe("调研登录流程");
  });

  test("绝不回退到 prompt", () => {
    expect(
      safeSubtaskDescription({
        prompt: "You are running inside OpenClaude",
        subagentType: { unspecified: {} },
      }),
    ).toBe("");
  });

  test("内部指令 / 路径 / JSON 标题丢弃", () => {
    expect(safeSubtaskDescription({ description: "You are 编程助手" })).toBe("");
    expect(safeSubtaskDescription({ description: "HOME=/home/agent host cmd" })).toBe("");
    expect(safeSubtaskDescription({ description: '{"unspecified":{}}' })).toBe("");
    expect(
      safeSubtaskDescription({
        description: "实现修复\nuid=3 /opt/openclaude/openclaude-v5-selfhost",
      }),
    ).toBe("");
  });
});

describe("isInternalSubtaskInput / opaque names", () => {
  test("识别 Cursor Task 载荷", () => {
    expect(
      isInternalSubtaskInput({
        description: "修 UI",
        prompt: "long prompt",
        subagentType: { unspecified: {} },
      }),
    ).toBe(true);
    expect(isInternalSubtaskInput({ query: "hello" })).toBe(false);
  });

  test("CallMcpTool 类工具名视为不回显 args", () => {
    expect(isOpaqueArgToolName("CallMcpTool")).toBe(true);
    expect(isOpaqueArgToolName("GetMcpTools")).toBe(true);
    expect(isOpaqueArgToolName("Bash")).toBe(false);
  });

  test("looksLikeInternalToolPrompt 空串为内部", () => {
    expect(looksLikeInternalToolPrompt("")).toBe(true);
    expect(looksLikeInternalToolPrompt("修卡片")).toBe(false);
  });
});
