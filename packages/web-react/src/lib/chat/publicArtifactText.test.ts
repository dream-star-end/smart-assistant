import { describe, expect, test } from "vitest";
import { publicArtifactText } from "./publicArtifactText";
import { exportSessionMarkdown } from "./exportMarkdown";
import { prepareShareMessages } from "./shareCard";
import type { ChatMessage } from "./model";

describe("publicArtifactText", () => {
  test("OCV5-507 exports readable artifact references without private platform roots", async () => {
    const text = "[下载报告](/home/agent/.openclaude/generated/2026/sales.csv)\n\n![图表](</root/.openclaude/generated/图表 (1).png>)\n\n`/home/agent/.openclaude/uploads/报表 2026.csv`\n\n文件在 /home/agent/.openclaude/generated/sales.csv。";
    const out = await publicArtifactText(text);
    expect(out).toContain("下载报告（2026/sales.csv）");
    expect(out).toContain("图表（图表 (1).png）");
    expect(out).toContain("`报表 2026.csv`");
    expect(out).toContain("文件在 sales.csv。");
    expect(out).not.toContain(".openclaude");
    expect(out).not.toContain("![");
    expect(await publicArtifactText("[下载][report]\n\n[report]: /home/agent/.openclaude/generated/sales.csv")).toContain("下载（sales.csv）");
    expect(await publicArtifactText("[下载][report]\n\n[report]: /home/agent/.openclaude/generated/sales.csv")).not.toContain(".openclaude");
  });
  test("keeps useful source code, command inline code, ordinary URLs and non-platform paths verbatim", async () => {
    const code = "```python\nopen('/home/agent/.openclaude/uploads/sales.csv')\n```\n\n`python /home/agent/.openclaude/generated/recalc.py --input /home/agent/.openclaude/uploads/sales.csv`\n\n[外站](https://example.test/home/agent/.openclaude/generated/sales.csv)\n\n/opt/project/input.csv\n\nhttps://example.test/download?file=/home/agent/.openclaude/generated/sales.csv";
    expect(await publicArtifactText(code)).toBe(code);
  });
  test("keeps direct script invocations with positional arguments executable", async () => {
    for (const command of ["/home/agent/.openclaude/generated/run.sh data.csv", "/root/.openclaude/generated/recalc.py 'file name.csv'"]) {
      const text = `运行：\`${command}\``;
      expect(await publicArtifactText(text)).toBe(text);
    }
  });
  test("shares and exports the same final content without changing original messages or user input", async () => {
    const user = "/home/agent/.openclaude/uploads/user-provided.csv";
    const messages: ChatMessage[] = [{ id: "u", role: "user", ts: 1, text: user }, { id: "a", role: "assistant", ts: 2, text: "完成：`/home/agent/.openclaude/generated/sales.csv`" }];
    const original = JSON.stringify(messages);
    const md = await exportSessionMarkdown(messages);
    const share = await prepareShareMessages(messages);
    expect(md).toContain(user);
    expect(md).toContain("完成：`sales.csv`");
    expect(share[0]?.text).toBe(user);
    expect(share[1]?.text).toBe("完成：`sales.csv`");
    expect(JSON.stringify(messages)).toBe(original);
  });
});
