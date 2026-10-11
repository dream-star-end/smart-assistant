import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { ChatProject } from "../lib/types";
import { ComposerProjectPill } from "./ComposerProjectPill";

afterEach(cleanup);

const projects: ChatProject[] = [
  { id: "p-thesis", name: "论文综述", color: "success", sortOrder: 0, createdAt: 1, updatedAt: 1, sessionCount: 2 },
  { id: "p-v5", name: "V5 自用版改版", sortOrder: 1, createdAt: 1, updatedAt: 1, sessionCount: 5 },
];

function openPill() {
  fireEvent.pointerDown(screen.getByTestId("composer-project-pill"), { button: 0, ctrlKey: false, pointerType: "mouse" });
}

describe("ComposerProjectPill", () => {
  it("a new chat started in a project shows that project before the first send", () => {
    render(<ComposerProjectPill projects={projects} projectId="p-v5" editable onPick={() => {}} />);
    const pill = screen.getByTestId("composer-project-pill");
    expect(pill).toHaveTextContent("V5 自用版改版");
    expect(pill).toHaveAttribute("data-project-id", "p-v5");
    expect(pill).toHaveAccessibleName("这条会话会放进项目「V5 自用版改版」，点击更改");
  });

  it("the target project can be switched or cleared before sending", () => {
    const onPick = vi.fn();
    render(<ComposerProjectPill projects={projects} projectId="p-v5" editable onPick={onPick} />);
    openPill();
    fireEvent.click(screen.getByRole("menuitem", { name: "论文综述" }));
    expect(onPick).toHaveBeenLastCalledWith("p-thesis");
    openPill();
    fireEvent.click(screen.getByRole("menuitem", { name: "不放进项目" }));
    expect(onPick).toHaveBeenLastCalledWith(null);
  });

  it("a draft outside any project offers the projects", () => {
    const onPick = vi.fn();
    render(<ComposerProjectPill projects={projects} projectId={null} editable onPick={onPick} />);
    expect(screen.getByTestId("composer-project-pill")).toHaveTextContent("不放进项目");
    openPill();
    fireEvent.click(screen.getByRole("menuitem", { name: "V5 自用版改版" }));
    expect(onPick).toHaveBeenCalledWith("p-v5");
  });

  it("renders nothing for someone with no projects", () => {
    const { container } = render(<ComposerProjectPill projects={[]} projectId={null} editable onPick={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("read-only mode opens the project instead of changing it", () => {
    const onOpen = vi.fn();
    render(<ComposerProjectPill projects={projects} projectId="p-thesis" editable={false} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: "所在项目：论文综述，点击打开项目" }));
    expect(onOpen).toHaveBeenCalledWith("p-thesis");
  });
});
