import { describe, expect, test } from "vitest";
import { isGrokOutputEnvelope, normalizeGrokToolForDisplay } from "./grokDisplay";

describe("T-01:归一化只对 Grok 原生名 / 明确的 Grok 信封形状生效", () => {
  test("非 Grok 名 + JSON 含 output 键 → 原样透传(oc-report 产物 JSON 不被折成路径)", () => {
    const raw = JSON.stringify({ output: "/home/agent/out/report.pdf", references: 12, warnings: [] });
    const display = normalizeGrokToolForDisplay(
      "Bash",
      { command: "oc-report --schema s" },
      { toolName: "Bash", inputJson: { command: "oc-report --schema s" }, output: raw },
    );
    expect(display.name).toBe("Bash");
    expect(display.tool.output).toBe(raw);
  });

  test("非 Grok 名 + JSON 含 body / markdown / content 键 → 同样原样", () => {
    for (const obj of [{ id: 1, body: "正文" }, { markdown: "# t", final_url: "https://x" }, { content: "c", kind: "x" }]) {
      const raw = JSON.stringify(obj);
      const display = normalizeGrokToolForDisplay("Bash", { command: "x" }, { toolName: "Bash", output: raw });
      expect(display.tool.output).toBe(raw);
    }
  });

  test("Grok 原生名(run_terminal_command)+ 普通 JSON 输出仍按旧口径解包", () => {
    const display = normalizeGrokToolForDisplay(
      "run_terminal_command",
      { command: "ls" },
      { toolName: "run_terminal_command", output: JSON.stringify({ output: "a\nb\n", exit_code: 0 }) },
    );
    expect(display.name).toBe("Bash");
    expect(display.tool.output).toBe("a\nb\n");
  });

  test("已是产品名但输出命中 Grok 信封形状(Vec<u8> / exit_code / type:mcp)→ 仍解包", () => {
    const bytes = Array.from(new TextEncoder().encode("hi\n"));
    expect(
      normalizeGrokToolForDisplay("Bash", { command: "x" }, { toolName: "Bash", outputJson: { output: bytes, exit_code: 0 } })
        .tool.output,
    ).toBe("hi\n");
    expect(
      normalizeGrokToolForDisplay("Bash", { command: "x" }, { toolName: "Bash", output: JSON.stringify({ stdout: "out", stderr: "err", exit_code: 1 }) })
        .tool.output,
    ).toBe("out\nerr\nexit 1");
    expect(
      normalizeGrokToolForDisplay(
        "mcp__web__fetch",
        { url: "x" },
        { toolName: "mcp__web__fetch", output: JSON.stringify({ type: "mcp", output: { OkayOutput: "page text" } }) },
      ).tool.output,
    ).toBe("page text");
  });

  test("isGrokOutputEnvelope 形状判定", () => {
    expect(isGrokOutputEnvelope({ output: "/tmp/report.pdf", references: 3 })).toBe(false);
    expect(isGrokOutputEnvelope({ output: "done" })).toBe(false);
    expect(isGrokOutputEnvelope({ success: { command: "x", exitCode: 1 } })).toBe(false);
    expect(isGrokOutputEnvelope({ output: [104, 105], exit_code: 0 })).toBe(true);
    expect(isGrokOutputEnvelope({ stdout: "x", exit_code: 0 })).toBe(true);
    expect(isGrokOutputEnvelope({ stdout: "x", exitCode: 0 })).toBe(true);
    expect(isGrokOutputEnvelope({ type: "mcp", output: "x" })).toBe(true);
    expect(isGrokOutputEnvelope({ output: { ErrorOutput: "e" } })).toBe(true);
    expect(isGrokOutputEnvelope("not json")).toBe(false);
    expect(isGrokOutputEnvelope(JSON.stringify({ stdout: "x", exit_code: 2 }))).toBe(true);
  });
});

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
