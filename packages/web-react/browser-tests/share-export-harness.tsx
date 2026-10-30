import { createRoot } from "react-dom/client";
import { useState } from "react";
import { ShareDialog } from "../src/components/ShareDialog";
import { ToastProvider } from "../src/components/ui/Toast";
import type { ChatMessage } from "../src/lib/chat/model";
const messages: ChatMessage[] = [
  { id: "u", role: "user", ts: 1, text: "生成销售报表，保留代码示例。" },
  { id: "process", role: "assistant", ts: 2, text: "正在读取私有工作目录…" },
  { id: "thinking", role: "thinking", ts: 3, text: "内部思考fixture" },
  { id: "tool", role: "tool", ts: 4, text: "fixture", toolName: "Bash", inputPreview: "python hidden_tool_fixture.py --private-input" },
  { id: "answer", role: "assistant", ts: 5, text: "已生成：[下载销售表](/home/agent/.openclaude/generated/sales.csv)\n\n文件：`/home/agent/.openclaude/generated/sales.csv`\n\n```python\nprint(42)\n```" },
  { id: "u2", role: "user", ts: 6, text: "继续完成下一节。" },
  { id: "partial", role: "assistant", ts: 7, text: "已交付的部分报告仍可导出。", _clientMessageId: "u2" },
  { id: "failure", role: "assistant", ts: 8, text: "", _errorCode: "MODEL_CONFIG_CHANGED_RETRY_TURN", _clientMessageId: "u2" },
  { id: "u3", role: "user", ts: 9, text: "请保留中断前的交付。" },
  { id: "stopped-file", role: "assistant", ts: 10, text: "已交付：[停止前文件](/home/agent/.openclaude/generated/stopped.csv)\n\n[turn failed: user_cancelled]", _errorCode: "USER_CANCELLED", _clientMessageId: "u3" },
  { id: "post-stop-tool", role: "tool", ts: 11, text: "PRIVATE_POST_STOP_TOOL", _clientMessageId: "u3" },
];
function ShareExportHarness() {
  const [open, setOpen] = useState(true);
  return <ToastProvider><ShareDialog open={open} onOpenChange={setOpen} messages={messages} sending={false} title="销售分析" agentName="全能助手" /></ToastProvider>;
}
createRoot(document.getElementById("root")!).render(<ShareExportHarness />);
