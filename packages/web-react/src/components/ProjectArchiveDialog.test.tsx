import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { ChatProject } from "../lib/types";
import { ProjectArchiveDialog } from "./ProjectArchiveDialog";

afterEach(cleanup);

const archived: ChatProject = { id: "p-arch", name: "旧项目", sortOrder: 0, createdAt: 1, updatedAt: 1, sessionCount: 2, archivedAt: 9 };

describe("ProjectArchiveDialog", () => {
  it("lists archived projects to unarchive and deleted ones to restore with days left", async () => {
    const onUnarchive = vi.fn(async () => {});
    const onRestore = vi.fn(async () => true);
    render(
      <ProjectArchiveDialog
        open
        onOpenChange={() => {}}
        archived={[archived]}
        loadDeleted={async () => [{ id: "p-del", name: "删掉的", deletedAt: Date.now() - 2 * 86400000, sessionCount: 3 }]}
        onUnarchive={onUnarchive}
        onRestore={onRestore}
      />,
    );
    expect(screen.getByText("旧项目")).toBeInTheDocument();
    expect(await screen.findByText("删掉的")).toBeInTheDocument();
    expect(screen.getByText(/3 个会话 · 还剩 28 天/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消归档" }));
    await waitFor(() => expect(onUnarchive).toHaveBeenCalledWith(archived));
    fireEvent.click(screen.getByRole("button", { name: /恢复/ }));
    await waitFor(() => expect(onRestore).toHaveBeenCalledWith("p-del"));
    await waitFor(() => expect(screen.queryByText("删掉的")).toBeNull());
  });
});
