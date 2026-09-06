import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createMemoryAuthSession } from "../lib/authSession";
import type { AuthSession } from "../lib/types";

const getChatGptProxyAccess = vi.fn();
const createChatGptProxyCredential = vi.fn();
const revokeChatGptProxyCredential = vi.fn();
vi.mock("../lib/api", () => ({
  api: {
    getChatGptProxyAccess: (...a: unknown[]) => getChatGptProxyAccess(...a),
    createChatGptProxyCredential: (...a: unknown[]) => createChatGptProxyCredential(...a),
    revokeChatGptProxyCredential: (...a: unknown[]) => revokeChatGptProxyCredential(...a),
  },
}));

import { ChatGptProxyDialog } from "./ChatGptProxyDialog";
import { TooltipProvider } from "./ui";

function renderDialog() {
  return render(
    <TooltipProvider>
      <ChatGptProxyDialog open auth={auth} onOpenChange={() => {}} />
    </TooltipProvider>,
  );
}

const auth: AuthSession = createMemoryAuthSession(() => {}, "tok");

const ENABLED = {
  enabled: true as const,
  proxyHost: "proxy.example.test",
  proxyPort: 8443,
  pacUrl: "https://proxy.example.test:8443/pac",
  homeUrl: "https://chatgpt.com/",
  username: "u3",
  hasCredential: false,
  createdAt: null,
  rotatedAt: null,
  lastUsedAt: null,
};

beforeEach(() => {
  getChatGptProxyAccess.mockReset();
  createChatGptProxyCredential.mockReset();
  revokeChatGptProxyCredential.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("ChatGptProxyDialog", () => {
  test("shows connection details, issues a credential and reveals the password once", async () => {
    getChatGptProxyAccess.mockResolvedValue(ENABLED);
    createChatGptProxyCredential.mockResolvedValue({
      username: "u3",
      password: "plain-secret-once",
      rotatedAt: "2026-09-06T00:00:00.000Z",
    });
    renderDialog();

    await screen.findByText("https://proxy.example.test:8443/pac");
    expect(screen.getByText("HTTPS proxy.example.test:8443")).toBeInTheDocument();
    expect(screen.getByText("u3")).toBeInTheDocument();
    expect(screen.getByText("尚未生成")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /打开 chatgpt.com/ })).toHaveAttribute(
      "href",
      "https://chatgpt.com/",
    );
    expect(screen.getByRole("link", { name: /打开 chatgpt.com/ })).toHaveAttribute(
      "rel",
      "noopener noreferrer",
    );

    fireEvent.click(screen.getByRole("button", { name: "生成密码" }));
    await screen.findByText("plain-secret-once");
    expect(createChatGptProxyCredential).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/密码只显示这一次/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新生成密码" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "吊销" })).toBeInTheDocument();
  });

  test("unentitled account sees an error and no connection details", async () => {
    getChatGptProxyAccess.mockResolvedValue({ enabled: false });
    renderDialog();
    await screen.findByText("当前账号未被授权使用 ChatGPT 直连");
    expect(screen.queryByText(/PAC 地址/)).toBeNull();
    expect(screen.queryByRole("button", { name: "生成密码" })).toBeNull();
  });

  test("revoke asks for confirmation then clears the credential state", async () => {
    getChatGptProxyAccess.mockResolvedValue({
      ...ENABLED,
      hasCredential: true,
      createdAt: "2026-09-01T00:00:00.000Z",
      rotatedAt: "2026-09-01T00:00:00.000Z",
      lastUsedAt: null,
    });
    revokeChatGptProxyCredential.mockResolvedValue(undefined);
    renderDialog();
    await screen.findByText(/已生成于/);

    fireEvent.click(screen.getByRole("button", { name: "吊销" }));
    // 二次确认对话框里的确认按钮同名。
    const confirmButtons = await screen.findAllByRole("button", { name: "吊销" });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]!);
    await waitFor(() => expect(revokeChatGptProxyCredential).toHaveBeenCalledTimes(1));
    await screen.findByText("尚未生成");
  });
});
