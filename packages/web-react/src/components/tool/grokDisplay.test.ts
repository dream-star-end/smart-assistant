import { describe, expect, test } from "vitest";
import { normalizeGrokToolForDisplay } from "./grokDisplay";

describe("normalizeGrokToolForDisplay 不以 message.text 当 output", () => {
  test("output==null 且 text 为工具名时不把 Bash 写入 output", () => {
    const display = normalizeGrokToolForDisplay(
      "Bash",
      { command: "oc-memory delegate --goal x" },
      {
        toolName: "Bash",
        text: "Bash",
        output: null,
        inputJson: { command: "oc-memory delegate --goal x" },
      },
    );
    expect(display.tool.output).not.toBe("Bash");
    expect(display.tool.output == null || display.tool.output === "").toBe(true);
  });

  test("output 缺省且 text 为工具名时同样不填洞", () => {
    const display = normalizeGrokToolForDisplay(
      "Bash",
      { command: "ls -la" },
      {
        toolName: "Bash",
        text: "Bash",
        inputJson: { command: "ls -la" },
      },
    );
    expect(display.tool.output).not.toBe("Bash");
  });

  test("历史 stdout / outputJson 仍解码为正文", () => {
    const display = normalizeGrokToolForDisplay(
      "Bash",
      { command: "ls" },
      {
        toolName: "Bash",
        text: "Bash",
        output: "hello-stdout\n",
        outputJson: { stdout: "hello-stdout\n", exitCode: 0 },
      },
    );
    expect(display.tool.output).toBe("hello-stdout\n");
  });

  test("decode 得到空串时不把 output 改写成 text", () => {
    const display = normalizeGrokToolForDisplay(
      "custom_structured_result",
      { query: "test" },
      {
        toolName: "custom_structured_result",
        text: "custom_structured_result",
        output: "text fallback",
        outputJson: { future_field: { marker: "EXACT_STRUCTURED_MARKER" } },
      },
    );
    expect(display.tool.output).toBe("text fallback");
    expect(display.tool.output).not.toBe("custom_structured_result");
  });
});
