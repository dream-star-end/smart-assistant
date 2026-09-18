import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { MediaRef } from "../lib/chat/frames";
import { Composer, moveComposerAttachments, resetComposerAttachmentCache } from "./Composer";
import { ToastProvider, TooltipProvider } from "./ui";

afterEach(() => {
  cleanup();
  resetComposerAttachmentCache();
  vi.restoreAllMocks();
});

function wrap(node: ReactNode) {
  return (
    <TooltipProvider>
      <ToastProvider>{node}</ToastProvider>
    </TooltipProvider>
  );
}

async function upload(view: ReturnType<typeof render>, fileName: string) {
  const el = view.container.querySelector("input[type=file]") as HTMLInputElement;
  await act(async () => {
    fireEvent.change(el, {
      target: { files: [new File(["private"], fileName, { type: "text/plain" })] },
    });
  });
}

describe("OCV5-180 composer owner regressions", () => {
  test("unsent new attachments do not migrate to an unrelated existing session", async () => {
    const onUpload = vi.fn(async (): Promise<MediaRef> => ({ kind: "file", url: "/private-new" }));
    const ui = (key: string) => wrap(<Composer draftKey={key} onSend={() => {}} onUpload={onUpload} />);
    const v = render(ui("user-a:new"));
    await upload(v, "new-private.txt");
    v.rerender(ui("user-a:existing-other"));
    expect(screen.queryByText("new-private.txt")).not.toBeInTheDocument();
    v.rerender(ui("user-a:new"));
    expect(screen.getByText("new-private.txt")).toBeInTheDocument();
  });

  test("new attachments do not migrate across account identities", async () => {
    const onUpload = vi.fn(async (): Promise<MediaRef> => ({ kind: "file", url: "/private-new" }));
    const ui = (key: string) => wrap(<Composer draftKey={key} onSend={() => {}} onUpload={onUpload} />);
    const v = render(ui("user-a:new"));
    await upload(v, "account-private.txt");
    resetComposerAttachmentCache();
    v.rerender(ui("user-b:new"));
    expect(screen.queryByText("account-private.txt")).not.toBeInTheDocument();
  });

  test("explicit new→id promotion keeps attachments and finishes a pending upload", async () => {
    let finish!: (media: MediaRef) => void;
    const onUpload = vi.fn(
      () =>
        new Promise<MediaRef>((resolve) => {
          finish = resolve;
        }),
    );
    const ui = (key: string) => wrap(<Composer draftKey={key} onSend={() => {}} onUpload={onUpload} />);
    const v = render(ui("user-a:new"));
    await upload(v, "pending-new.txt");
    expect(screen.getByText("pending-new.txt")).toBeInTheDocument();
    moveComposerAttachments("user-a:new", "user-a:created");
    v.rerender(ui("user-a:created"));
    expect(screen.getByText("pending-new.txt")).toBeInTheDocument();
    await act(async () => {
      finish({ kind: "file", url: "/stub/pending-new.txt" });
    });
    expect(screen.queryByLabelText("重试上传 pending-new.txt")).not.toBeInTheDocument();
    const send = screen.getByRole("button", { name: "发送" });
    expect(send).not.toBeDisabled();
  });

  test("remove after session switch only deletes the current owner attachment", async () => {
    const onUpload = vi.fn(async (file: File): Promise<MediaRef> => ({ kind: "file", url: `/stub/${file.name}` }));
    const ui = (key: string) => wrap(<Composer draftKey={key} onSend={() => {}} onUpload={onUpload} />);
    const v = render(ui("session-A"));
    await upload(v, "A-keep.txt");
    v.rerender(ui("session-B"));
    expect(screen.queryByText("A-keep.txt")).not.toBeInTheDocument();
    await upload(v, "B-drop.txt");
    expect(screen.getByText("B-drop.txt")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "移除 B-drop.txt" }));
    expect(screen.queryByText("B-drop.txt")).not.toBeInTheDocument();
    v.rerender(ui("session-A"));
    expect(screen.getByText("A-keep.txt")).toBeInTheDocument();
  });
});

// Reusable new key is NOT a stable logical draft identity.
test("two successive promotions keep the first pending upload on its own owner", async () => {
  const pending = new Map<string, (value: MediaRef) => void>();
  const onUpload = vi.fn((file: File) => new Promise<MediaRef>(resolve => pending.set(file.name, resolve)));
  const ui = (key: string) => wrap(<Composer draftKey={key} onSend={() => {}} onUpload={onUpload} />);
  const v = render(ui("user-a:new"));
  await upload(v, "first.txt");
  moveComposerAttachments("user-a:new", "user-a:first");
  v.rerender(ui("user-a:first"));
  v.rerender(ui("user-a:new"));
  await upload(v, "second.txt");
  moveComposerAttachments("user-a:new", "user-a:second");
  v.rerender(ui("user-a:second"));
  await act(async () => { pending.get("first.txt")!({ kind: "file", url: "/first" }); });
  expect(screen.queryByText("first.txt")).not.toBeInTheDocument();
  v.rerender(ui("user-a:first"));
  expect(screen.getByText("first.txt")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "发送" })).not.toBeDisabled();
});
