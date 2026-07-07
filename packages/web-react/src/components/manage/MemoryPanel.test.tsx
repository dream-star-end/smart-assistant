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

/** 取当前可用（未禁用）的「保存」按钮（记忆面板同时渲染画像+核心记忆两块）。 */
const enabledSave = () =>
  screen
    .getAllByRole("button", { name: "保存" })
    .find((btn) => !(btn as HTMLButtonElement).disabled) as HTMLButtonElement | undefined;

describe("MemoryPanel", () => {
  test("把记忆条目展示为卡片，并按原 delimiter 保存（带 version）", async () => {
    vi.spyOn(api, "getMemory").mockImplementation(async (_a, _agentId, target) => ({
      target,
      text: target === "user" ? "用户称呼：dengxuan\n§\n项目访问：\n- URL: https://example.com" : "",
      version: target === "user" ? "v1" : "v0",
      charCount: 0,
      limit: 2000,
    }));
    const put = vi
      .spyOn(api, "putMemory")
      .mockResolvedValue({ ok: true, version: "v2", charCount: 0, limit: 2000 });

    render(<MemoryPanel auth={auth} agentId="main" agents={[{ id: "main", name: "全能助手" }]} />);

    expect(await screen.findByText("用户称呼")).toBeInTheDocument();
    expect(screen.getByText("项目访问")).toBeInTheDocument();
    expect(screen.getAllByText("#1").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("#2")).toBeInTheDocument();

    const first = screen.getByDisplayValue("用户称呼：dengxuan") as HTMLTextAreaElement;
    fireEvent.change(first, { target: { value: "用户称呼：dx" } });
    expect(screen.getByText("未保存")).toBeInTheDocument();

    fireEvent.click(enabledSave() as HTMLButtonElement);

    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls[0][2]).toBe("user");
    expect(put.mock.calls[0][3]).toBe("用户称呼：dx\n§\n项目访问：\n- URL: https://example.com");
    // 载入版本 v1 作为乐观锁令牌回传。
    expect(put.mock.calls[0][4]).toBe("v1");
  });

  test("版本冲突时条目级并入服务端新增内容，刷新 version 后再保存", async () => {
    vi.spyOn(api, "getMemory").mockImplementation(async (_a, _agentId, target) => ({
      target,
      text: target === "user" ? "A条\n§\nB条" : "",
      version: target === "user" ? "v1" : "v0",
      charCount: 0,
      limit: 2000,
    }));
    const put = vi
      .spyOn(api, "putMemory")
      // 第一次 PUT：智能体在编辑期间新增了 C条 → 409 冲突。
      .mockResolvedValueOnce({
        ok: false,
        conflict: { text: "A条\n§\nB条\n§\nC条", version: "v2", charCount: 9, limit: 2000 },
      })
      // 第二次 PUT：带新 version 成功。
      .mockResolvedValueOnce({ ok: true, version: "v3", charCount: 12, limit: 2000 });

    render(<MemoryPanel auth={auth} agentId="main" agents={[{ id: "main", name: "全能助手" }]} />);

    const a = (await screen.findByDisplayValue("A条")) as HTMLTextAreaElement;
    fireEvent.change(a, { target: { value: "A改" } });
    fireEvent.click(enabledSave() as HTMLButtonElement);

    // 并入：C条 被追加进列表 + info 提示条出现（不自动保存）。
    expect(await screen.findByDisplayValue("C条")).toBeInTheDocument();
    expect(screen.getByText(/已并入 1 条新增内容/)).toBeInTheDocument();
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0][4]).toBe("v1");

    // 用户确认后再保存：带冲突刷新出的新 version v2。
    fireEvent.click(enabledSave() as HTMLButtonElement);
    await waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    expect(put.mock.calls[1][4]).toBe("v2");
    expect(put.mock.calls[1][3]).toBe("A改\n§\nB条\n§\nC条");
  });

  test("超出字符预算时禁用保存并把计数标红", async () => {
    vi.spyOn(api, "getMemory").mockImplementation(async (_a, _agentId, target) => ({
      target,
      text: target === "user" ? "AB" : "",
      version: "v1",
      charCount: 2,
      limit: 5,
    }));
    vi.spyOn(api, "putMemory").mockResolvedValue({ ok: true, version: "v2" });

    render(<MemoryPanel auth={auth} agentId="main" agents={[{ id: "main", name: "全能助手" }]} />);

    const box = (await screen.findByDisplayValue("AB")) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "ABCDEFGH" } }); // 8 > 5

    // 计数以 当前/limit 呈现，且标红。
    const counter = screen.getByText("8/5 字符");
    expect(counter).toHaveClass("text-danger");
    // 有改动但超限 → 没有任何可用的保存按钮。
    expect(enabledSave()).toBeUndefined();
  });

  test("新增条目后不再误报既有条目为「未保存」（index 错位 bug）", async () => {
    vi.spyOn(api, "getMemory").mockImplementation(async (_a, _agentId, target) => ({
      target,
      text: target === "user" ? "第一条\n§\n第二条" : "",
      version: "v1",
      charCount: 6,
      limit: 2000,
    }));
    vi.spyOn(api, "putMemory").mockResolvedValue({ ok: true, version: "v2" });

    render(<MemoryPanel auth={auth} agentId="main" agents={[{ id: "main", name: "全能助手" }]} />);
    await screen.findByDisplayValue("第一条");

    // 载入态：两条既有条目都不 dirty。
    expect(screen.queryByText("未保存")).not.toBeInTheDocument();

    // 用户画像块的「新增条目」（DOCS 顺序中 user 在前）→ unshift 一条空条目。
    fireEvent.click(screen.getAllByRole("button", { name: "新增条目" })[0]);

    // 只有新增的空条目 dirty，既有两条不受 unshift 错位影响。
    expect(screen.getAllByText("未保存")).toHaveLength(1);
  });
});
