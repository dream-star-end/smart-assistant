import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { buildToolDetailSections, ToolResultDetails } from "./details";
import type { ToolLike } from "./format";

afterEach(cleanup);

describe("ToolResultDetails", () => {
  test("独立保留输入、结构化结果、错误和未来字段，并排除内部壳字段", () => {
    const message = {
      toolName: "future_tool",
      inputJson: { query: "完整输入" },
      outputJson: { result: "完整结果", truncated: true },
      error: { code: "UPSTREAM_ERROR", message: "错误正文" },
      futurePayload: { marker: "FUTURE_FIELD_MARKER" },
      _internalOnly: "不要展示",
    } as unknown as ToolLike;
    const sections = buildToolDetailSections(message);

    expect(sections.map((section) => section.label)).toEqual([
      "输入",
      "结构化结果",
      "错误详情",
      "附加结果",
    ]);
    expect(sections.find((section) => section.key === "outputJson")?.note).toContain("上游返回内容已截断");

    render(<ToolResultDetails sections={sections} />);
    expect(screen.queryByText("FUTURE_FIELD_MARKER")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "结果详情" }));
    expect(document.body.textContent).toContain("完整输入");
    expect(document.body.textContent).toContain("完整结果");
    expect(document.body.textContent).toContain("错误正文");
    expect(document.body.textContent).toContain("FUTURE_FIELD_MARKER");
    expect(document.body.textContent).not.toContain("不要展示");
    expect(screen.queryByText("查看原始完整记录")).not.toBeInTheDocument();
  });

  test("bashTail 明示仅保存尾部，流式输入明示尚未完成", () => {
    const sections = buildToolDetailSections({
      partialJson: '{"query":"正在输入',
      bashTail: { tail: "最后一段输出", totalBytes: 987_654, truncatedHead: true },
    });
    expect(sections.find((section) => section.key === "partialJson")?.note).toContain("尚未完成");
    expect(sections.find((section) => section.key === "bashTail")?.note).toContain("987,654 字节");
  });

  test("oc-* 详情可隐藏嵌套 command，同时保留同一 wrapper 的未来字段", () => {
    const sections = buildToolDetailSections(
      {
        output: JSON.stringify({
          arguments: { command: "oc-market search private" },
          future: { marker: "WRAPPER_FUTURE_MARKER" },
        }),
      },
      { hiddenCommand: "oc-market search private" },
    );
    expect(JSON.stringify(sections)).not.toContain("oc-market search private");
    expect(JSON.stringify(sections)).toContain("WRAPPER_FUTURE_MARKER");
    expect(JSON.stringify(sections)).toContain("已隐藏的工具命令");
  });

  test("超长 Unicode 结果可按需加载到最后一个字符，没有永久硬上限", () => {
    const marker = "最终标记🙂";
    const sections = buildToolDetailSections({ output: `${"内容🙂".repeat(70_000)}${marker}` });
    render(<ToolResultDetails sections={sections} />);
    fireEvent.click(screen.getByRole("button", { name: "结果详情" }));
    expect(document.body.textContent).not.toContain(marker);
    while (screen.queryByRole("button", { name: /继续显示/ })) {
      fireEvent.click(screen.getByRole("button", { name: /继续显示/ }));
    }
    expect(document.body.textContent).toContain(marker);
  });
});
