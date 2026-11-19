import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { MediaRef } from "../lib/chat/frames";
import { Composer, resetComposerAttachmentCache } from "./Composer";
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

describe("FQ-03 Composer attachments follow draft owner", () => {
  test("attach in A, switch to B, send B without A media; A still has the file", async () => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:owner-a"),
    });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const sends: Array<{ session: string; media?: MediaRef[] }> = [];
    let finishUpload: (media: MediaRef) => void = () => {};
    const onUpload = vi.fn(
      () =>
        new Promise<MediaRef>((resolve) => {
          finishUpload = resolve;
        }),
    );
    const view = render(
      wrap(
        <Composer
          draftKey="session-A"
          onSend={(text, media) => { sends.push({ session: "A", media }); }}
          onUpload={onUpload}
        />,
      ),
    );
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    const file = new File(["private"], "A-private.txt", { type: "text/plain" });
    await act(async () => {
      Object.defineProperty(input, "files", { configurable: true, value: [file] });
      fireEvent.change(input);
    });
    await act(async () => {
      finishUpload({ kind: "file", url: "/stub/A-private.txt" });
    });
    await waitFor(() => expect(screen.getByText("A-private.txt")).toBeInTheDocument());

    await act(async () => {
      view.rerender(
        wrap(
          <Composer
            draftKey="session-B"
            onSend={(text, media) => { sends.push({ session: "B", media }); }}
            onUpload={onUpload}
          />,
        ),
      );
    });
    expect(screen.queryByText("A-private.txt")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("消息输入框"), { target: { value: "hello B" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(sends).toEqual([{ session: "B", media: undefined }]);

    await act(async () => {
      view.rerender(
        wrap(
          <Composer
            draftKey="session-A"
            onSend={(text, media) => { sends.push({ session: "A", media }); }}
            onUpload={onUpload}
          />,
        ),
      );
    });
    expect(screen.getByText("A-private.txt")).toBeInTheDocument();
  });

  test("late upload for A cannot attach to B", async () => {
    const sends: Array<{ session: string; media?: MediaRef[] }> = [];
    let finishUpload: (media: MediaRef) => void = () => {};
    const onUpload = vi.fn(
      () =>
        new Promise<MediaRef>((resolve) => {
          finishUpload = resolve;
        }),
    );
    const view = render(
      wrap(
        <Composer
          draftKey="session-A"
          onSend={(text, media) => { sends.push({ session: "A", media }); }}
          onUpload={onUpload}
        />,
      ),
    );
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    const file = new File(["private"], "late-A.txt", { type: "text/plain" });
    await act(async () => {
      Object.defineProperty(input, "files", { configurable: true, value: [file] });
      fireEvent.change(input);
    });
    await act(async () => {
      view.rerender(
        wrap(
          <Composer
            draftKey="session-B"
            onSend={(text, media) => { sends.push({ session: "B", media }); }}
            onUpload={onUpload}
          />,
        ),
      );
    });
    await act(async () => {
      finishUpload({ kind: "file", url: "/stub/late-A.txt" });
    });
    expect(screen.queryByText("late-A.txt")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("消息输入框"), { target: { value: "B only" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(sends[0]?.session).toBe("B");
    expect(sends[0]?.media).toBeUndefined();
  });

  test("in-flight async onSend in session A never spins or blocks New Session / session B, and clears A even after A→B→A round-trip (OCV5-788)", async () => {
    let resolveA!: (sent: boolean) => void;
    const sends: Array<{ owner: string; text: string }> = [];
    const onSendA = vi.fn(
      (text: string) =>
        new Promise<boolean>((resolve) => {
          sends.push({ owner: "A", text });
          resolveA = resolve;
        }),
    );
    const onSendNew = vi.fn((text: string) => {
      sends.push({ owner: "new", text });
      return true;
    });

    const view = render(wrap(<Composer draftKey="3:session-A" onSend={onSendA} />));
    fireEvent.change(screen.getByLabelText("消息输入框"), { target: { value: "stuck in A" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(onSendA).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector(".animate-spin")).not.toBeNull();
    // Duplicate submit in A while A's onSend is pending must still be blocked.
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(onSendA).toHaveBeenCalledTimes(1);

    // Switch to New Session ("3:__new__"): must NOT spin and must allow immediate send.
    view.rerender(wrap(<Composer draftKey="3:__new__" onSend={onSendNew} />));
    expect(view.container.querySelector(".animate-spin")).toBeNull();
    fireEvent.change(screen.getByLabelText("消息输入框"), { target: { value: "hello from new session" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(onSendNew).toHaveBeenCalledWith("hello from new session", undefined, undefined);
    expect((screen.getByLabelText("消息输入框") as HTMLTextAreaElement).value).toBe("");

    // Switch back to session A while A's onSend is still pending: spinner stays on A, then clears draft on settle.
    view.rerender(wrap(<Composer draftKey="3:session-A" onSend={onSendA} />));
    expect(view.container.querySelector(".animate-spin")).not.toBeNull();
    expect((screen.getByLabelText("消息输入框") as HTMLTextAreaElement).value).toBe("stuck in A");

    await act(async () => {
      resolveA(true);
    });
    expect(view.container.querySelector(".animate-spin")).toBeNull();
    expect((screen.getByLabelText("消息输入框") as HTMLTextAreaElement).value).toBe("");
  });
});
