import { createRoot } from "react-dom/client";
import { ShareDialog } from "../src/components/ShareDialog";
import { ToastProvider } from "../src/components/ui/Toast";
import { exportSessionMarkdown } from "../src/lib/chat/exportMarkdown";
import { saveBlob } from "../src/lib/chat/download";
import type { ChatMessage } from "../src/lib/chat/model";
const messages: ChatMessage[] = [
  { id: "u", role: "user", ts: 1, text: "生成销售报表，保留代码示例。" },
  { id: "process", role: "assistant", ts: 2, text: "正在读取私有工作目录…" },
  { id: "thinking", role: "thinking", ts: 3, text: "内部思考fixture" },
  { id: "tool", role: "tool", ts: 4, text: "fixture", toolName: "Bash", inputPreview: "python hidden_tool_fixture.py --private-input" },
  { id: "answer", role: "assistant", ts: 5, text: "已生成：[下载销售表](/home/agent/.openclaude/generated/sales.csv)\n\n文件：`/home/agent/.openclaude/generated/sales.csv`\n\n```python\nprint(42)\n```" },
];
createRoot(document.getElementById("root")!).render(<ToastProvider><ShareDialog open onOpenChange={() => {}} messages={messages} sending={false} title="销售分析" agentName="全能助手" onExportMarkdown={async () => saveBlob(new Blob([await exportSessionMarkdown(messages)], { type: "text/markdown" }), "销售分析.md")} /></ToastProvider>);
