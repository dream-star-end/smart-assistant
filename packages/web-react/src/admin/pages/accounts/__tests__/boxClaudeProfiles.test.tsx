import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ToastProvider, TooltipProvider } from "../../../../components/ui";

const adminGet = vi.fn();
const adminSend = vi.fn();
vi.mock("../../../lib/adminApi", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/adminApi")>("../../../lib/adminApi");
  return { ...actual, adminGet: (...a: unknown[]) => adminGet(...a), adminSend: (...a: unknown[]) => adminSend(...a) };
});

import { BoxClaudeProfilesModal, type BoxClaudeProfile } from "../BoxClaudeProfilesModal";

const base: BoxClaudeProfile = {
  profile: "default", config_dir: "/home/box/.claude", enabled: true, is_default: true,
  login_state: "logged_in", projects_mode: "root", selectable: true, email_hint: "a***@m***.com",
  org_type: "claude_pro", duplicate_of: null, utilization: 0.4, cooldown_until: null,
  cooldown_reason: null, last_seen_at: null,
};
const second: BoxClaudeProfile = { ...base, profile: "b", config_dir: "/home/box/.claude-b", enabled: false,
  is_default: false, projects_mode: "shared", email_hint: "b***@x***.io", utilization: null };
const dev: BoxClaudeProfile = { ...base, profile: "account2", config_dir: "/home/box/.claude-account2",
  enabled: false, is_default: false, projects_mode: "own", selectable: false };
const view = (profiles: BoxClaudeProfile[], implicit = false) =>
  ({ profiles, implicit_default: implicit, policy: { utilization_ceiling: 0.92 } });

function open() {
  return render(
    <ToastProvider><TooltipProvider>
      <BoxClaudeProfilesModal open onOpenChange={() => {}} accountId="25" accountLabel="box-25" />
    </TooltipProvider></ToastProvider>,
  );
}

beforeEach(() => { adminGet.mockReset(); adminSend.mockReset(); });
afterEach(cleanup);

describe("BoxClaudeProfilesModal", () => {
  test("lists the Box's logins; a dir with its own sessions cannot be ticked", async () => {
    adminGet.mockResolvedValue(view([base, second, dev]));
    open();
    expect(await screen.findByText("/home/box/.claude-b")).toBeTruthy();
    expect(adminGet).toHaveBeenCalledWith("/box-claude-profiles", { account_id: "25" });
    expect((screen.getByLabelText("启用 default") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("启用 b") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText("启用 account2") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/不是产品专用目录/)).toBeTruthy();
  });

  test("ticking a second login and choosing the default saves exactly that selection", async () => {
    adminGet.mockResolvedValue(view([base, second]));
    adminSend.mockResolvedValue(view([{ ...base, is_default: false }, { ...second, enabled: true, is_default: true }]));
    open();
    await screen.findByText("/home/box/.claude-b");
    const save = screen.getByRole("button", { name: "保存" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("启用 b"));
    fireEvent.click(screen.getByLabelText("默认 b"));
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(adminSend).toHaveBeenCalledWith("PUT", "/box-claude-profiles",
      { account_id: "25", enabled: ["default", "b"], default: "b" }));
    expect(await screen.findByText("已保存")).toBeTruthy();
  });

  test("scan posts discover and shows an out-of-quota login as benched with its reset time", async () => {
    adminGet.mockResolvedValue(view([], true));
    const until = new Date(Date.now() + 3_600_000).toISOString();
    adminSend.mockResolvedValue(view([{ ...base, cooldown_until: until, cooldown_reason: "quota_exhausted", utilization: 1.04 }, second]));
    open();
    expect(await screen.findByText(/目前只使用默认登录/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "扫描 Box" }));
    await waitFor(() => expect(adminSend).toHaveBeenCalledWith("POST", "/box-claude-profiles/discover", { account_id: "25" }));
    expect(await screen.findByText(/额度用尽,.*前不参与/)).toBeTruthy();
  });

  test("the same Claude account logged in twice is flagged", async () => {
    adminGet.mockResolvedValue(view([base, { ...second, duplicate_of: "default" }]));
    open();
    expect(await screen.findByText(/是同一个 Claude 账号/)).toBeTruthy();
  });

  test("a save the server refuses shows its message", async () => {
    adminGet.mockResolvedValue(view([base, second]));
    adminSend.mockRejectedValue(new Error("BOX_PROFILE_NOT_LOGGED_IN"));
    open();
    await screen.findByText("/home/box/.claude-b");
    fireEvent.click(screen.getByLabelText("启用 b"));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText(/BOX_PROFILE_NOT_LOGGED_IN|保存失败/)).toBeTruthy();
  });

  test("an edition without the table says so and cannot scan", async () => {
    adminGet.mockResolvedValue({ ...view([], true), available: false });
    open();
    expect(await screen.findByText(/没有 Box 多账号功能/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "扫描 Box" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("a slow answer for a previously opened account never lands in the current one", async () => {
    let releaseA: (v: unknown) => void = () => {};
    adminGet.mockImplementation((_path: string, params: { account_id: string }) =>
      params.account_id === "25" ? new Promise((resolve) => { releaseA = resolve; })
        : Promise.resolve(view([{ ...base, config_dir: "/home/box/.claude", email_hint: "b-only@x" }, second])));
    const { rerender } = open();
    rerender(
      <ToastProvider><TooltipProvider>
        <BoxClaudeProfilesModal open onOpenChange={() => {}} accountId="26" accountLabel="box-26" />
      </TooltipProvider></ToastProvider>,
    );
    expect(await screen.findByText("/home/box/.claude-b")).toBeTruthy();
    releaseA(view([{ ...base, profile: "zzz", config_dir: "/home/box/.claude-zzz" }]));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText("/home/box/.claude-zzz")).toBeNull();
    expect(screen.getByText("/home/box/.claude-b")).toBeTruthy();
  });

  test("a login the Box-side guard refused is not reported as out of quota", async () => {
    const until = new Date(Date.now() + 3_600_000).toISOString();
    adminGet.mockResolvedValue(view([{ ...base, cooldown_until: until, cooldown_reason: "profile_unsafe" }]));
    open();
    expect(await screen.findByText(/目录校验失败.*前不参与/)).toBeTruthy();
    expect(screen.queryByText(/额度用尽,.*前不参与/)).toBeNull();
  });
});
