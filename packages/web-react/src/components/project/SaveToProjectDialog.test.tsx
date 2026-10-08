import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../../lib/api";
import { createMemoryAuthSession } from "../../lib/authSession";
import { taskboardApi } from "../../lib/taskboard";
import type { AuthSession } from "../../lib/types";
import { ToastProvider } from "../ui";
import { SaveToProjectDialog, type SaveToProjectRequest } from "./SaveToProjectDialog";

const BOARD = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const scopeBoards = { current: [{ id: BOARD }] as Array<{ id: string }> };
const setToken = vi.fn();
vi.mock("../../hooks/useProjectScope", () => ({
  useProjectScope: () => ({ refreshWorkProjects: async () => scopeBoards.current, setToken }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setToken.mockClear();
});

function setup(kind: "memory" | "skill", text = "## Release rules\n每周五发版，发版前跑冒烟。") {
  const auth = createMemoryAuthSession(() => {}, "tok");
  const current = { auth: auth as AuthSession };
  const request: SaveToProjectRequest = {
    kind,
    text,
    sessionId: "sess-1",
    boardProjectId: BOARD,
    projectName: "自用版",
    auth,
    epoch: auth.snapshot().epoch,
    nonce: 1,
  };
  const onClose = vi.fn();
  const onShowSurface = vi.fn();
  const prepareBoard = vi.fn(async () => true);
  // Like App: closing clears the request, so the modal goes away and the toast is reachable.
  function Harness() {
    const [req, setReq] = useState<SaveToProjectRequest | null>(request);
    return (
      <SaveToProjectDialog
        request={req}
        onClose={() => {
          onClose();
          setReq(null);
        }}
        currentAuth={() => current.auth}
        prepareBoard={prepareBoard}
        onShowSurface={onShowSurface}
      />
    );
  }
  render(
    <ToastProvider>
      <Harness />
    </ToastProvider>,
  );
  return { auth, current, onClose, onShowSurface, prepareBoard };
}

describe("SaveToProjectDialog 记住这条", () => {
  it("prefills, prepares the board, saves with sourceSession, toasts with a link to 记忆", async () => {
    const create = vi.spyOn(taskboardApi, "createProjectMemory").mockResolvedValue({ ok: true, candidate: {} as never });
    const h = setup("memory");
    const dialog = screen.getByRole("dialog");
    const name = within(dialog).getByRole("textbox", { name: /名称/ }) as HTMLInputElement;
    expect(name.value).toMatch(/^release-rules-\d{8}-[0-9a-z]{4}$/);
    const content = within(dialog).getByRole("textbox", { name: "记忆内容" }) as HTMLTextAreaElement;
    expect(content.value).toBe("## Release rules\n每周五发版，发版前跑冒烟。");
    fireEvent.change(name, { target: { value: "release-rules" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "记住" }));
    await waitFor(() => expect(h.onClose).toHaveBeenCalled());
    expect(h.prepareBoard).toHaveBeenCalledWith(BOARD);
    expect(create).toHaveBeenCalledWith(h.auth, BOARD, {
      slug: "release-rules.md",
      content: "## Release rules\n每周五发版，发版前跑冒烟。",
      sourceSession: "sess-1",
    });
    expect(await screen.findByText("已记到项目记忆")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开记忆" }));
    await waitFor(() => expect(h.onShowSurface).toHaveBeenCalledWith("memory"));
    expect(setToken).toHaveBeenCalledWith(BOARD);
  });

  it("an invalid name blocks saving", () => {
    const create = vi.spyOn(taskboardApi, "createProjectMemory");
    setup("memory");
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox", { name: /名称/ }), { target: { value: "中文名" } });
    expect(within(dialog).getByRole("button", { name: "记住" })).toBeDisabled();
    expect(create).not.toHaveBeenCalled();
  });

  it("account switch mid-way: stops, closes, no toast", async () => {
    let release!: () => void;
    const create = vi.spyOn(taskboardApi, "createProjectMemory");
    const h = setup("memory");
    h.prepareBoard.mockImplementation(
      () =>
        new Promise<boolean>((r) => {
          release = () => r(true);
        }),
    );
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "记住" }));
    await waitFor(() => expect(h.prepareBoard).toHaveBeenCalled());
    h.current.auth = createMemoryAuthSession(() => {}, "other");
    release();
    await waitFor(() => expect(h.onClose).toHaveBeenCalled());
    expect(create).not.toHaveBeenCalled();
    expect(screen.queryByText("已记到项目记忆")).toBeNull();
  });
});

describe("SaveToProjectDialog 存为项目技能", () => {
  it("creates the skill and adds it to the project, retrying once on 409", async () => {
    vi.spyOn(api, "getSkill").mockRejectedValue(new ApiError({ status: 404, message: "skill not found" }));
    const update = vi.spyOn(api, "updateSkill").mockResolvedValue({ ok: true });
    vi.spyOn(taskboardApi, "getProjectContext")
      .mockResolvedValueOnce({ version: 1, skillOverlay: [] })
      .mockResolvedValueOnce({ version: 2, skillOverlay: [] });
    const put = vi
      .spyOn(taskboardApi, "putProjectContext")
      .mockRejectedValueOnce(new ApiError({ status: 409, message: "version_conflict" }))
      .mockResolvedValueOnce({ ok: true, context: { version: 3, instructions: null } });
    const h = setup("skill");
    const dialog = screen.getByRole("dialog");
    expect((within(dialog).getByRole("textbox", { name: /技能名/ }) as HTMLInputElement).value).toBe("release-rules");
    expect((within(dialog).getByRole("textbox", { name: /什么时候用/ }) as HTMLInputElement).value).toBe("Release rules");
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(await screen.findByText("已存为项目技能")).toBeInTheDocument();
    expect(h.onClose).toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(h.auth, "release-rules", {
      description: "Release rules",
      body: "## Release rules\n每周五发版，发版前跑冒烟。",
    });
    expect(put).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenLastCalledWith(h.auth, BOARD, { expectedVersion: 2, skillNames: ["release-rules"] });
  });

  it("a taken name stays in the dialog with a field error", async () => {
    vi.spyOn(api, "getSkill").mockResolvedValue({ name: "release-rules" } as never);
    const update = vi.spyOn(api, "updateSkill");
    const h = setup("skill");
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(await within(dialog).findByText("已有同名技能，换一个名字")).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
    expect(h.onClose).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByRole("textbox", { name: /技能名/ }), { target: { value: "Release-Rules-2" } });
    expect((within(dialog).getByRole("textbox", { name: /技能名/ }) as HTMLInputElement).value).toBe("release-rules-2");
    expect(within(dialog).queryByText("已有同名技能，换一个名字")).toBeNull();
  });
});
