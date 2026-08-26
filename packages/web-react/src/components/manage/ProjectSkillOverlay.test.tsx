import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createMemoryAuthSession } from "../../lib/authSession";
import { ToastProvider } from "../ui";
import { ProjectSkillOverlay } from "./ProjectSkillOverlay";

describe("ProjectSkillOverlay", () => {
  it("without work scope shows disabled hint, does not PUT", () => {
    const auth = createMemoryAuthSession(() => {}, "tok");
    render(
      <ToastProvider>
        <ProjectSkillOverlay auth={auth} />
      </ToastProvider>,
    );
    expect(screen.getByTestId("project-skill-overlay-disabled")).toBeInTheDocument();
  });
});
