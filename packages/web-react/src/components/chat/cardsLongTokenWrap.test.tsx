import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { ChatMessage } from "../../lib/chat/model";
import { SystemCard, UserCard } from "./cards";

afterEach(cleanup);

// OCV5-318:定时续跑代发的长提示含会话键/路径等无空格长串。`break-words` 不降低 min-content,
// 手机上气泡被最长串撑宽、左右溢出屏幕。jsdom 不排版,这里锁住真正起作用的类;
// 视觉证据见 ui-preview 场景 messages-cron-long-wrap。
const LONG =
  "⏰ 定时续跑「看门狗」\n\n进程命令行含 OPENCLAUDE_SESSION_KEY=agent:main:webchat:dm:webmuqjhduqb0ifd9/home/agent/.openclaude/workspace/ocv5-308";

describe("OCV5-318 长串消息不横向溢出", () => {
  test("用户气泡:anywhere 折行 + 不被内容撑出容器", () => {
    render(<UserCard msg={{ id: "u", role: "user", text: LONG, ts: 1 } as ChatMessage} />);
    const bubble = screen.getByTestId("message-text");
    expect(bubble.className).toContain("[overflow-wrap:anywhere]");
    expect(bubble.className).toContain("min-w-0");
    expect(bubble.className).toContain("max-w-full");
    expect(bubble.parentElement?.className).toContain("min-w-0");
    expect(screen.getByTestId("user-row").className).toContain("min-w-0");
  });

  test("系统提示卡:anywhere 折行 + min-w-0", () => {
    const { container } = render(
      <SystemCard msg={{ id: "s", role: "system", text: LONG, ts: 1 } as ChatMessage} />,
    );
    const pill = container.querySelector(".whitespace-pre-wrap") as HTMLElement;
    expect(pill.className).toContain("[overflow-wrap:anywhere]");
    expect(pill.className).toContain("min-w-0");
  });
});
