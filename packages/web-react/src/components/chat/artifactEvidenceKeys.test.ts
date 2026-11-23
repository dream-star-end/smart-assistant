import { describe, expect, test } from "vitest";
import { artifactEvidenceKeys } from "./ProcessDisclosure";

// OCV5-422: 时间线每次流式通知都要问每条助手正文的产物键;结果只取决于正文,按正文缓存。
describe("artifactEvidenceKeys", () => {
  test("同一正文返回同一份(冻结的)结果;正文变了重新计算", () => {
    const text = `看图：![图](/home/agent/.openclaude/generated/chart-${Math.random().toString(36).slice(2)}.png)`;
    const first = artifactEvidenceKeys(text);
    expect(first.length).toBeGreaterThan(0);
    expect(artifactEvidenceKeys(text)).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    const longer = artifactEvidenceKeys(`${text}\n\n另见 /home/agent/.openclaude/generated/report.pdf`);
    expect(longer).not.toBe(first);
    expect(longer.length).toBe(first.length + 1);
    expect(artifactEvidenceKeys("没有产物的普通回答")).toEqual([]);
  });

  test("OCV5-865: 兼容行内反引号 .docx/.pdf/.zip 与中文/含空格文件名，排除围栏命令与目录路径", () => {
    const md = [
      "已生成：",
      "- `/home/agent/.openclaude/generated/report.docx`",
      "- `/home/agent/.openclaude/generated/科研综述 2026.pdf`",
      "- `/home/agent/.openclaude/generated/数据归档（终版）.zip`",
      "- 目录 `/home/agent/.openclaude/generated/` 与 `/home/agent/.openclaude/generated/run.2026`",
      "",
      "```bash",
      "ls -la /home/agent/.openclaude/generated/ignored-in-fence.docx",
      "```",
      "",
      "```",
      "/home/agent/.openclaude/generated/fenced-only-path.docx",
      "```",
    ].join("\n");

    const keys = artifactEvidenceKeys(md);
    expect(keys).toEqual([
      "file:/home/agent/.openclaude/generated/report.docx",
      "file:/home/agent/.openclaude/generated/科研综述 2026.pdf",
      "file:/home/agent/.openclaude/generated/数据归档（终版）.zip",
    ]);
    expect(
      artifactEvidenceKeys(["```", "/home/agent/.openclaude/generated/report.docx", "```"].join("\n")),
    ).toEqual([]);
  });
});
