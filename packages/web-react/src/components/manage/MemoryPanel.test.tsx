import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../../lib/api";
import type { AuthSession } from "../../lib/types";
import { MemoryPanel } from "./MemoryPanel";

const auth = {
  getToken: () => "tok",
  setToken: () => {},
  onExpired: () => {},
} as AuthSession;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MemoryPanel", () => {
  test("把记忆条目展示为卡片，并按原 delimiter 保存", async () => {
    vi.spyOn(api, "getMemory").mockImplementation(async (_a, _agentId, target) => ({
      target,
      text: target === "user" ? "用户称呼：dengxuan\n§\n项目访问：\n- URL: https://example.com" : "",
      charCount: 0,
      limit: 2000,
    }));
    const put = vi.spyOn(api, "putMemory").mockResolvedValue({ ok: true, charCount: 0, limit: 2000 });

    render(<MemoryPanel auth={auth} agentId="main" agents={[{ id: "main", name: "全能助手" }]} />);

    expect(await screen.findByText("用户称呼")).toBeInTheDocument();
    expect(screen.getByText("项目访问")).toBeInTheDocument();
    expect(screen.getAllByText("#1").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("#2")).toBeInTheDocument();

    const first = screen.getByDisplayValue("用户称呼：dengxuan") as HTMLTextAreaElement;
    fireEvent.change(first, { target: { value: "用户称呼：dx" } });
    expect(screen.getByText("未保存")).toBeInTheDocument();

    const save = screen
      .getAllByRole("button", { name: "保存" })
      .find((btn) => !(btn as HTMLButtonElement).disabled) as HTMLButtonElement;
    fireEvent.click(save);

    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls[0][2]).toBe("user");
    expect(put.mock.calls[0][3]).toBe("用户称呼：dx\n§\n项目访问：\n- URL: https://example.com");
  });
});
