import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MarkdownProps } from "../Markdown";
import { MediaSignProvider } from "../chat/media";
import { ToastProvider, TooltipProvider } from "../ui";
import { OutputViewer } from "./OutputViewer";

const calls: MarkdownProps[] = [];
vi.mock("../Markdown", () => ({
  Markdown: (props: MarkdownProps) => {
    calls.push(props);
    return <div data-testid="md-mock">{props.children}</div>;
  },
}));

afterEach(() => {
  cleanup();
  calls.length = 0;
  vi.unstubAllGlobals();
});

const sign = async (paths: string[]) => Object.fromEntries(paths.map((p) => [p, `/api/media-signed?t=${p}`]));

function show(name: string, body: string) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
  render(
    <ToastProvider>
      <TooltipProvider>
        <MediaSignProvider sign={sign} authKey="u">
          <OutputViewer
            asset={{ id: name, projectId: "p", source: "output", sessionId: null, name, url: "/api/media/x", containerPath: null, mime: null, sizeBytes: body.length, excerpt: null, pinned: false, createdAt: 1, updatedAt: 1 }}
            onClose={() => {}}
            onOpenSession={() => {}}
            onShowVersions={() => {}}
          />
        </MediaSignProvider>
      </TooltipProvider>
    </ToastProvider>,
  );
}

describe("OutputViewer → Markdown 渲染参数", () => {
  it("Markdown 与代码预览都关掉无语言代码块的自动探测，且只读", async () => {
    show("a.md", "# t\n\n```\nplain\n```\n");
    await screen.findByTestId("md-mock");
    expect(calls.at(-1)).toMatchObject({ readOnly: true, autoDetectCode: false });
    cleanup();
    calls.length = 0;
    show("run.sh", "echo hi\n");
    await screen.findByTestId("md-mock");
    expect(calls.at(-1)).toMatchObject({ readOnly: true, autoDetectCode: false });
  });
});
