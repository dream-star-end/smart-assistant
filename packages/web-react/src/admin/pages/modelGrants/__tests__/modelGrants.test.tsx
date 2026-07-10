import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../../lib/adminApi", () => ({
  adminGet: vi.fn(),
  adminSend: vi.fn(),
  ApiError: class ApiError extends Error {
    status?: number;
  },
}));

import { adminGet, adminSend } from "../../../lib/adminApi";
import ModelGrantsPage from "../index";

function mockGet(granted: string[] = []) {
  vi.mocked(adminGet).mockImplementation(async (path: string) => {
    if (path === "/users") return { rows: [{ id: "1001", email: "a@b.com" }] };
    if (path === "/pricing") {
      return {
        rows: [
          { model_id: "gpt-x", display_name: "GPT X", visibility: "admin", enabled: true },
          { model_id: "pub-model", display_name: "Public", visibility: "public", enabled: true },
        ],
      };
    }
    if (path === "/users/1001/model-grants") {
      return { rows: granted.map((m) => ({ model_id: m })) };
    }
    throw new Error(`unexpected ${path}`);
  });
}

beforeEach(() => {
  mockGet();
  vi.mocked(adminSend).mockResolvedValue({});
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ModelGrantsPage", () => {
  test("查询用户 → 只列受限模型(public 不列),授权 → POST", async () => {
    render(<ModelGrantsPage />);
    fireEvent.change(screen.getByPlaceholderText("用户邮箱 或 UID"), {
      target: { value: "a@b.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "查询" }));

    // 受限模型出现,public 模型不出现
    expect(await screen.findByText("gpt-x")).toBeTruthy();
    expect(screen.queryByText("pub-model")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "授权" }));
    await waitFor(() => {
      expect(vi.mocked(adminSend)).toHaveBeenCalledWith("POST", "/users/1001/model-grants", {
        model_id: "gpt-x",
      });
    });
  });

  test("已授权模型显示撤销 → DELETE", async () => {
    mockGet(["gpt-x"]);
    render(<ModelGrantsPage />);
    fireEvent.change(screen.getByPlaceholderText("用户邮箱 或 UID"), {
      target: { value: "a@b.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "查询" }));
    fireEvent.click(await screen.findByRole("button", { name: "撤销" }));
    await waitFor(() => {
      expect(vi.mocked(adminSend)).toHaveBeenCalledWith(
        "DELETE",
        "/users/1001/model-grants/gpt-x",
      );
    });
  });
});
