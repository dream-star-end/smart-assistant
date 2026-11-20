import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { LiveBrowserState } from "../../lib/liveBrowserApi";
import type { AuthSession } from "../../lib/types";
import { LiveBrowserStage } from "./LiveBrowserStage";

const fetchLiveMock = vi.fn();
const sendActionMock = vi.fn();

vi.mock("../../lib/liveBrowserApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/liveBrowserApi")>();
  return {
    ...actual,
    fetchLiveBrowserState: (...args: unknown[]) => fetchLiveMock(...args),
    sendLiveBrowserAction: (...args: unknown[]) => sendActionMock(...args),
  };
});

const MOCK_AUTH = {
  token: "tok",
  refresh: vi.fn(),
  onAuthLost: vi.fn(),
} as unknown as AuthSession;

const ACTIVE_STATE: LiveBrowserState = {
  available: true,
  active: true,
  url: "https://arxiv.org/abs/2501.00001",
  title: "Sample Paper — arXiv",
  viewport: { width: 1280, height: 720 },
  tabs: [
    { index: 0, title: "Sample Paper — arXiv", url: "https://arxiv.org/abs/2501.00001", active: true },
  ],
  imageBase64: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  mimeType: "image/jpeg",
  capturedAt: 1_700_000_000_000,
};

beforeEach(() => {
  fetchLiveMock.mockReset();
  sendActionMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("LiveBrowserStage", () => {
  test("renders idle launcher and opens browser on submit", async () => {
    fetchLiveMock.mockResolvedValue({ available: true, active: false });
    sendActionMock.mockResolvedValue(ACTIVE_STATE);

    render(<LiveBrowserStage agentId="main" auth={MOCK_AUTH} />);
    await screen.findByTestId("live-browser-idle");

    const input = screen.getByTestId("live-browser-launch-input");
    fireEvent.change(input, { target: { value: "arxiv.org/abs/2501.00001" } });
    fireEvent.click(screen.getByTestId("live-browser-launch-btn"));

    await screen.findByTestId("live-browser-active");
    expect(sendActionMock).toHaveBeenCalledWith(MOCK_AUTH, "main", {
      action: "open",
      url: "https://arxiv.org/abs/2501.00001",
    });
    expect(screen.getByTestId("live-browser-frame")).toHaveAttribute(
      "src",
      expect.stringContaining("data:image/jpeg;base64,"),
    );
  });

  test("rejects unsafe protocol in launcher without hitting backend", async () => {
    fetchLiveMock.mockResolvedValue({ available: true, active: false });

    render(<LiveBrowserStage agentId="main" auth={MOCK_AUTH} />);
    await screen.findByTestId("live-browser-idle");

    fireEvent.change(screen.getByTestId("live-browser-launch-input"), {
      target: { value: "file:///etc/passwd" },
    });
    fireEvent.click(screen.getByTestId("live-browser-launch-btn"));

    expect(await screen.findByTestId("live-browser-error")).toHaveTextContent("http:// 或 https://");
    expect(sendActionMock).not.toHaveBeenCalled();
  });

  test("supports takeover click coordinate normalization, text typing, and handback composer prefill", async () => {
    fetchLiveMock.mockResolvedValue(ACTIVE_STATE);
    sendActionMock.mockResolvedValue({
      ...ACTIVE_STATE,
      title: "Logged In — arXiv",
    });
    const onHandBack = vi.fn();

    render(
      <LiveBrowserStage
        agentId="main"
        auth={MOCK_AUTH}
        onHandBackToComposer={onHandBack}
      />,
    );
    await screen.findByTestId("live-browser-active");

    // Enter takeover mode
    fireEvent.click(screen.getByTestId("live-browser-takeover-btn"));
    expect(screen.getByTestId("live-browser-takeover-dock")).toBeInTheDocument();

    // Mock bounding box on viewport image and click at exact center (0.5, 0.5)
    const img = screen.getByTestId("live-browser-frame");
    vi.spyOn(img, "getBoundingClientRect").mockReturnValue({
      left: 100,
      top: 50,
      width: 400,
      height: 200,
      right: 500,
      bottom: 250,
      x: 100,
      y: 50,
      toJSON: () => ({}),
    });
    fireEvent.click(img, { clientX: 300, clientY: 150 });

    await waitFor(() =>
      expect(sendActionMock).toHaveBeenCalledWith(MOCK_AUTH, "main", {
        action: "click",
        x: 0.5,
        y: 0.5,
        normalized: true,
        button: "left",
      }),
    );

    // Send text via bottom takeover dock
    fireEvent.change(screen.getByTestId("live-browser-type-input"), { target: { value: "123456" } });
    fireEvent.click(screen.getByTestId("live-browser-type-submit"));
    await waitFor(() =>
      expect(sendActionMock).toHaveBeenCalledWith(MOCK_AUTH, "main", {
        action: "type",
        text: "123456",
        submit: true,
      }),
    );

    // Hand back to assistant
    fireEvent.click(screen.getByTestId("live-browser-handback-btn"));
    expect(screen.queryByTestId("live-browser-takeover-dock")).toBeNull();
    expect(onHandBack).toHaveBeenCalledWith(
      expect.stringContaining("Logged In — arXiv"),
    );
  });

  test("ignores stale poll frame that resolves after a newer action response", async () => {
    let resolveStalePoll!: (s: LiveBrowserState) => void;
    const stalePollPromise = new Promise<LiveBrowserState>((r) => {
      resolveStalePoll = r;
    });
    fetchLiveMock
      .mockResolvedValueOnce(ACTIVE_STATE)
      .mockReturnValueOnce(stalePollPromise);
    sendActionMock.mockResolvedValue({
      ...ACTIVE_STATE,
      title: "Fresh Action Title",
    });

    render(<LiveBrowserStage agentId="main" auth={MOCK_AUTH} />);
    await screen.findByTestId("live-browser-active");

    // Trigger an action
    fireEvent.click(screen.getByRole("button", { name: "刷新页面" }));
    await waitFor(() =>
      expect(screen.getByTestId("live-browser-status")).toHaveTextContent("Fresh Action Title"),
    );

    // Now resolve the older poll with stale title — must NOT overwrite
    resolveStalePoll({ ...ACTIVE_STATE, title: "Stale Poll Title" });
    await Promise.resolve();
    expect(screen.getByTestId("live-browser-status")).toHaveTextContent("Fresh Action Title");
  });

  test("renders unavailable state cleanly when container lacks oc-browser", async () => {
    fetchLiveMock.mockResolvedValue({ available: false, active: false, reason: "unavailable" });
    render(<LiveBrowserStage agentId="main" auth={MOCK_AUTH} />);
    await screen.findByTestId("live-browser-unavailable");
  });

  test("enforces watch-only mode while assistant is running and exits takeover automatically", async () => {
    fetchLiveMock.mockResolvedValue(ACTIVE_STATE);
    const { rerender } = render(<LiveBrowserStage agentId="main" auth={MOCK_AUTH} running={false} />);
    await screen.findByTestId("live-browser-active");

    fireEvent.click(screen.getByTestId("live-browser-takeover-btn"));
    expect(screen.getByTestId("live-browser-takeover-dock")).toBeInTheDocument();

    // Assistant starts a turn -> takeover automatically hands back to watch-only mode
    rerender(<LiveBrowserStage agentId="main" auth={MOCK_AUTH} running={true} />);
    expect(screen.queryByTestId("live-browser-takeover-dock")).toBeNull();
    expect(screen.getByTestId("live-browser-takeover-btn")).toBeDisabled();
    expect(screen.getByTestId("live-browser-takeover-btn")).toHaveTextContent("助手操作中");
  });

  test("buffers rapid canvas typing into a single type action and releases focus on Escape", async () => {
    fetchLiveMock.mockResolvedValue(ACTIVE_STATE);
    sendActionMock.mockResolvedValue(ACTIVE_STATE);

    render(<LiveBrowserStage agentId="main" auth={MOCK_AUTH} running={false} />);
    await screen.findByTestId("live-browser-active");
    fireEvent.click(screen.getByTestId("live-browser-takeover-btn"));

    const stage = screen.getByTestId("live-browser-stage");
    stage.focus();
    fireEvent.keyDown(stage, { key: "a" });
    fireEvent.keyDown(stage, { key: "b" });
    fireEvent.keyDown(stage, { key: "c" });

    await waitFor(
      () =>
        expect(sendActionMock).toHaveBeenCalledWith(MOCK_AUTH, "main", {
          action: "type",
          text: "abc",
          submit: false,
        }),
      { timeout: 1000 },
    );

    // Escape blurs canvas focus cleanly without triggering a remote action
    sendActionMock.mockClear();
    fireEvent.keyDown(stage, { key: "Escape" });
    expect(document.activeElement).not.toBe(stage);
    expect(sendActionMock).not.toHaveBeenCalled();
  });

  test("preserves text→Enter ordering and cancels pending buffered text/wheel on handback", async () => {
    fetchLiveMock.mockResolvedValue(ACTIVE_STATE);
    sendActionMock.mockResolvedValue(ACTIVE_STATE);

    render(<LiveBrowserStage agentId="main" auth={MOCK_AUTH} running={false} />);
    await screen.findByTestId("live-browser-active");
    fireEvent.click(screen.getByTestId("live-browser-takeover-btn"));

    const stage = screen.getByTestId("live-browser-stage");
    stage.focus();
    fireEvent.keyDown(stage, { key: "x" });
    fireEvent.keyDown(stage, { key: "y" });
    fireEvent.keyDown(stage, { key: "Enter" });

    await waitFor(() => expect(sendActionMock).toHaveBeenCalledTimes(2));
    expect(sendActionMock.mock.calls[0]?.[2]).toEqual({ action: "type", text: "xy", submit: false });
    expect(sendActionMock.mock.calls[1]?.[2]).toEqual({ action: "press", key: "Enter" });

    // Type + wheel then immediately hand back within 160ms: nothing should be sent after handback!
    sendActionMock.mockClear();
    fireEvent.keyDown(stage, { key: "z" });
    fireEvent.wheel(stage, { deltaY: 120 });
    fireEvent.click(screen.getByTestId("live-browser-handback-btn"));

    await new Promise((r) => setTimeout(r, 280));
    expect(sendActionMock).not.toHaveBeenCalled();
  });
});
