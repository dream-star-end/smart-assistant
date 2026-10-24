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
    vi.spyOn(taskboardApi, "getProjectContext").mockResolvedValue({
      version: 1,
      workspaceSpec: { kind: "isolated" },
      replay: "audit_only_not_bit_identical",
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
    // 审计 T-14:安全约束改成用户能读懂的说法,不再泄漏 cwd / 环境变量名。
    expect(screen.getByText(/须位于 workspace\/ 或 repos\/ 之下/)).toBeTruthy();
    expect(screen.queryByText(/OPENCLAUDE_DEFAULT_WORKSPACE|cwd/)).toBeNull();
    fireEvent.click(screen.getByTestId("project-workspace-container_path"));
    expect(screen.getByTestId("project-workspace-path")).toBeTruthy();
  });
});


test('new builtin stages require an explicit helper; empty projects need none', async () => {
  const auth = createMemoryAuthSession(() => {}, 'tok')
  const create = vi.fn(async (_input: unknown) => null)
  render(<ToastProvider><ProjectSettings auth={auth} agents={[{ id: 'installed', name: '已装助手' }]}
    current={null} mode="create" onCreate={create} onPatch={async () => null}
    onArchive={async () => false} onUnarchive={async () => false} /></ToastProvider>)
  fireEvent.change(screen.getByTestId('project-key'), { target: { value: 'BIND' } })
  fireEvent.change(screen.getByTestId('project-name'), { target: { value: '明确助手' } })
  expect(screen.getByTestId('project-create-submit')).toBeDisabled()
  expect(screen.getByTestId('builtin-execution-agent')).toHaveValue('')
  fireEvent.change(screen.getByTestId('builtin-execution-agent'), { target: { value: 'installed' } })
  fireEvent.click(screen.getByTestId('project-create-submit'))
  await vi.waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ key: 'BIND', executionAgentId: 'installed', templateIds: undefined })))
  create.mockClear()
  for (const id of ['bug', 'feature', 'spike', 'chore']) fireEvent.click(screen.getByTestId(`project-template-builtin:${id}`))
  expect(screen.queryByTestId('builtin-execution-agent')).toBeNull()
  fireEvent.click(screen.getByTestId('project-create-submit'))
  await vi.waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ templateIds: [] })))
  expect(create.mock.calls[0]?.[0]).not.toHaveProperty('executionAgentId')
})
