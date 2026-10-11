import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { MediaSignProvider } from "../chat/media";
import { BrowserStepCard } from "./BrowserStepCard";
import { BROWSER_HOME, browserStepOf } from "./browserSteps";
import { ArtifactInspectContext } from "./context";

afterEach(cleanup);

const sign = async (paths: string[]) => Object.fromEntries(paths.map((p) => [p, `/api/media?sig=x&path=${encodeURIComponent(p)}`]));

const tool = (command: string, output: string, extra: Record<string, unknown> = {}) => ({
  id: "b1",
  toolName: "Bash",
  inputJson: { command },
  output,
  _completed: true,
  ...extra,
});

function renderCard(t: ReturnType<typeof tool>, open?: (target: unknown) => void) {
  const step = browserStepOf(t);
  if (!step) throw new Error("not a browser step");
  return render(
    <MediaSignProvider sign={sign}>
      <ArtifactInspectContext.Provider value={open ? { open } : {}}>
        <BrowserStepCard step={step} tool={t} />
      </ArtifactInspectContext.Provider>
    </MediaSignProvider>,
  );
}

describe("BrowserStepCard", () => {
  test("地址栏 + 标题 + 动作序列 + 截图;「在侧栏查看」把这一步交给详情面板", async () => {
    const open = vi.fn();
    const t = tool(
      "oc-browser goto 'http://127.0.0.1:8765/demo.html' && oc-browser screenshot",
      "- Page URL: http://127.0.0.1:8765/demo.html\n- Page Title: Demo\n- [Screenshot of viewport](.playwright-cli/one.png)",
    );
    const { container } = renderCard(t, open);
    const address = screen.getByTestId("browser-address");
    // 容器回环地址:不开新标签,交给全局「容器预览」监听。
    expect(address).toHaveAttribute("href", "http://127.0.0.1:8765/demo.html");
    expect(address).not.toHaveAttribute("target");
    expect(address).toHaveTextContent("127.0.0.1:8765/demo.html");
    expect(screen.getByTestId("browser-title")).toHaveTextContent("Demo");
    expect(screen.getByTestId("browser-actions")).toHaveTextContent("打开网页");
    await waitFor(() =>
      expect(container.querySelector("img")?.getAttribute("src")).toContain(encodeURIComponent(`${BROWSER_HOME}/.playwright-cli/one.png`)),
    );
    fireEvent.click(screen.getByTestId("browser-open-pane"));
    expect(open).toHaveBeenCalledWith({ kind: "tool", message: t });
    // 截图放大是看图器的按钮;侧栏入口是它旁边的独立按钮,不嵌套。
    expect(container.querySelector("button button")).toBeNull();
  });

  test("一条命令多张截图:胶片条切换主图", async () => {
    const { container } = renderCard(
      tool(
        "oc-browser click e1 && oc-browser screenshot && oc-browser click e2 && oc-browser screenshot",
        "- [Screenshot of viewport](.playwright-cli/a.png)\n- [Screenshot of viewport](.playwright-cli/b.png)",
      ),
    );
    const thumbs = screen.getAllByTestId("browser-shot-thumb");
    expect(thumbs).toHaveLength(2);
    expect(thumbs[0]).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(thumbs[1] as HTMLElement);
    expect(screen.getAllByTestId("browser-shot-thumb")[1]).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => {
      const main = container.querySelector("[data-testid=browser-shot] img");
      expect(main?.getAttribute("src")).toContain(encodeURIComponent(`${BROWSER_HOME}/.playwright-cli/b.png`));
    });
  });

  test("失败:首个 Error 行 + 错误详情折叠;没有面板入口时不渲染按钮", () => {
    renderCard(tool("oc-browser open 'file:///tmp/x.html'", "### Error\nError: Access blocked.\nexit 1", { error: true }));
    expect(screen.getByTestId("browser-error")).toHaveTextContent("Error: Access blocked.");
    expect(screen.getByText("错误详情")).toBeInTheDocument();
    expect(screen.queryByTestId("browser-open-pane")).toBeNull();
  });

  test("公网地址新标签打开", () => {
    renderCard(tool("oc-browser open https://example.com/docs", "- Page Title: Docs"));
    const address = screen.getByTestId("browser-address");
    expect(address).toHaveAttribute("target", "_blank");
    expect(address).toHaveAttribute("rel", "noopener noreferrer");
  });
});
