import { createRoot } from "react-dom/client";
import MarkdownImpl from "../src/components/MarkdownImpl";
import { MediaSignProvider } from "../src/components/chat/media";
const path = "/home/agent/.openclaude/generated/报表 2026.csv";
createRoot(document.getElementById("root")!).render(
  <MediaSignProvider authKey="fixture" sign={async (paths) => {
    const res = await fetch("/api/media-sign", { method: "POST", body: JSON.stringify({ paths }) });
    return res.json();
  }}>
    <main className="p-6 prose max-w-2xl" data-testid="artifact-link-harness">
      <h1>销售报表已生成</h1>
      <MarkdownImpl signMedia>{`[下载季度报表](${encodeURI(path)})`}</MarkdownImpl>
      <MarkdownImpl signMedia>{"[帮助文档](/help/report.csv)"}</MarkdownImpl>
      <MarkdownImpl signMedia>{"[![报告缩略图](https://example.test/preview.png)](/home/agent/.openclaude/generated/report.pdf)"}</MarkdownImpl>
      <div data-testid="readonly"><MarkdownImpl signMedia readOnly>{`[只读文件](${encodeURI(path)})`}</MarkdownImpl></div>
    </main>
  </MediaSignProvider>,
);
