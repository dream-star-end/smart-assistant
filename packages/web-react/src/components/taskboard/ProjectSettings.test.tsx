import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createMemoryAuthSession } from "../../lib/authSession";
import { taskboardApi, type Project } from "../../lib/taskboard";
import { ToastProvider } from "../ui";
import { ProjectSettings } from "./ProjectSettings";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const project: Project = {
  id: "11111111-1111-4111-8111-111111111111",
  key: "TEST",
  name: "V5",
  description: null,
  workspace: null,
  workspaceSpec: { kind: "isolated" },
  labels: [],
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
};

describe("ProjectSettings workspaceSpec", () => {
  test("edit mode shows default/isolated/container_path and safety copy", () => {
    vi.spyOn(taskboardApi, "listProjects").mockResolvedValue([]);
    vi.spyOn(taskboardApi, "listProjectMemories").mockResolvedValue({
      projectId: project.id,
      official: [],
      candidates: [],
    });
    const auth = createMemoryAuthSession(() => {}, "tok");
    render(
      <ToastProvider>
        <ProjectSettings
          auth={auth}
          current={project}
          onCreate={async () => null}
          onPatch={async () => null}
          onArchive={async () => false}
          onUnarchive={async () => false}
        />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByTestId("project-edit-open"));
    expect(screen.getByTestId("project-workspace-spec")).toBeTruthy();
    expect(screen.getByTestId("project-workspace-default")).toBeTruthy();
    expect(screen.getByTestId("project-workspace-isolated")).toBeTruthy();
    expect(screen.getByTestId("project-workspace-container_path")).toBeTruthy();
    expect(screen.getByText(/projects 不能当 cwd/)).toBeTruthy();
    fireEvent.click(screen.getByTestId("project-workspace-container_path"));
    expect(screen.getByTestId("project-workspace-path")).toBeTruthy();
  });
});
