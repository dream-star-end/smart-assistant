import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatXlsxCellDisplay,
  isXlsxCellError,
  supportsNativeOfficePreview,
  type OfficePreviewPayload,
} from "../../lib/api/wave4Api";
import { createMemoryAuthSession } from "../../lib/authSession";
import { ToastProvider } from "../ui";
import { DeliverableRichPreview } from "./DeliverableRichPreview";
import { formatAnchorLabel } from "./deliverablePreview";
import { OfficeRichPreview } from "./OfficeRichPreview";

const origFetch = globalThis.fetch;
const origCreateObjectURL = URL.createObjectURL;
const origRevokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:mock-office-page");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = origFetch;
  URL.createObjectURL = origCreateObjectURL;
  URL.revokeObjectURL = origRevokeObjectURL;
  vi.restoreAllMocks();
});

describe("OfficeRichPreview · 纯函数与锚点格式化", () => {
  it("准确识别支持零轮次原生预览的 Office 路径与 XLSX 错误单元格", () => {
    expect(supportsNativeOfficePreview("/workspace/deck.pptx")).toBe(true);
    expect(supportsNativeOfficePreview("/workspace/report.DOCX")).toBe(true);
    expect(supportsNativeOfficePreview("/workspace/model.xlsx")).toBe(true);
    expect(supportsNativeOfficePreview("/api/media/abc")).toBe(false);
    expect(supportsNativeOfficePreview("relative/deck.pptx")).toBe(false);
    expect(supportsNativeOfficePreview("/workspace/legacy.xls")).toBe(false);

    expect(isXlsxCellError({ cell: "C4", value: "#DIV/0!" })).toBe(true);
    expect(isXlsxCellError({ cell: "D5", value: null, error: "#REF!" })).toBe(true);
    expect(isXlsxCellError({ cell: "A1", value: 42 })).toBe(false);

    expect(formatXlsxCellDisplay({ cell: "B2", value: 120, formula: "SUM(B1:B1)" }, "values")).toBe("120");
    expect(formatXlsxCellDisplay({ cell: "B2", value: 120, formula: "SUM(B1:B1)" }, "formulas")).toBe("=SUM(B1:B1)");
    expect(formatAnchorLabel({ kind: "cell", sheet: "Summary", ref: "C4" })).toBe("工作表「Summary」单元格 C4");
  });
});

describe("OfficeRichPreview · PPTX / DOCX 零轮次高保真预览", () => {
  const PPTX_PAYLOAD: OfficePreviewPayload = {
    kind: "pptx",
    filePath: "/workspace/q4-review.pptx",
    sha256: "abc123",
    mtimeMs: 1700000000000,
    cacheKey: "k1",
    cached: true,
    previewHandle: "handle_0123456789abcdef",
    pages: [
      {
        index: 1,
        imgPath: "/cache/p1.png",
        notes: "开场强调 Q4 同比增长 38%",
        pageUrl: "/api/file/office-preview/page?handle=handle_0123456789abcdef&page=1",
      },
      {
        index: 2,
        imgPath: "/cache/p2.png",
        notes: "说明成本下降原因",
        pageUrl: "/api/file/office-preview/page?handle=handle_0123456789abcdef&page=2",
      },
    ],
    qaIssues: [
      { severity: "warning", code: "OVERFLOW", message: "第 2 页右侧图表文字接近边界", page: 2 },
    ],
  };

  it("带认证拉取预览与页图、展开讲稿备注、QA 跳页并回流 AnnotationComposer", async () => {
    const auth = createMemoryAuthSession(() => {}, "jwt-office-token");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer jwt-office-token");
      if (url.startsWith("/api/file/office-preview?")) {
        return new Response(JSON.stringify({ preview: PPTX_PAYLOAD }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.startsWith("/api/file/office-preview/page")) {
        return new Response("png-bytes", {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const onAnnotateToComposer = vi.fn();
    render(
      <ToastProvider>
        <DeliverableRichPreview
          path="/workspace/q4-review.pptx"
          auth={auth}
          onAnnotateToComposer={onAnnotateToComposer}
        />
      </ToastProvider>,
    );

    expect(await screen.findByTestId("office-preview-pages")).toBeInTheDocument();
    expect(screen.getByTestId("office-page-counter")).toHaveTextContent("第 1 / 2 页");
    expect(await screen.findByTestId("office-stage-image")).toHaveAttribute("src", "blob:mock-office-page");

    // 展开讲稿备注
    fireEvent.click(screen.getByRole("button", { name: "讲稿备注" }));
    expect(screen.getByText(/开场强调 Q4 同比增长 38%/)).toBeInTheDocument();

    // 展开 QA 面板并点击第 2 页问题自动跳转
    fireEvent.click(screen.getByTestId("office-qa-toggle"));
    expect(screen.getByTestId("office-qa-panel")).toBeInTheDocument();
    fireEvent.click(screen.getByText(/第 2 页右侧图表文字接近边界/));
    expect(screen.getByTestId("office-page-counter")).toHaveTextContent("第 2 / 2 页");

    // 点击「批注此页」直通 AnnotationComposer（带 { kind: 'slide', page: 2 }）
    fireEvent.click(screen.getByTestId("office-annotate-page"));
    expect(screen.getByTestId("deliverable-annotate-anchor")).toHaveTextContent("第 2 页");
    fireEvent.change(screen.getByTestId("deliverable-annotate-input"), {
      target: { value: "把右侧图例字号调小一号避免贴边" },
    });
    fireEvent.click(screen.getByTestId("deliverable-annotate-submit"));

    await waitFor(() => expect(onAnnotateToComposer).toHaveBeenCalledTimes(1));
    const draft = String(onAnnotateToComposer.mock.calls[0]?.[0] ?? "");
    expect(draft).toContain("/workspace/q4-review.pptx");
    expect(draft).toContain("第 2 页");
    expect(draft).toContain("把右侧图例字号调小一号避免贴边");
  });

  it("后端返回错误时零白屏优雅回退至 BinaryOfficeCard", async () => {
    const auth = createMemoryAuthSession(() => {}, "jwt-office-token");
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ message: "unavailable" }), { status: 503 })) as typeof fetch;

    render(
      <ToastProvider>
        <DeliverableRichPreview path="/workspace/broken.docx" auth={auth} />
      </ToastProvider>,
    );

    expect(await screen.findByTestId("deliverable-binary-office")).toBeInTheDocument();
  });
});

describe("OfficeRichPreview · XLSX 多工作表、公式切换与单元格批注", () => {
  const XLSX_PAYLOAD: OfficePreviewPayload = {
    kind: "xlsx",
    filePath: "/workspace/finance.xlsx",
    sha256: "def456",
    mtimeMs: 1700000000000,
    cacheKey: "k2",
    cached: false,
    maxRowsPerSheet: 500,
    sheets: [
      {
        name: "Summary",
        totalRows: 1200,
        totalCols: 3,
        truncated: true,
        rows: [
          [
            { cell: "A1", value: "指标" },
            { cell: "B1", value: "数值" },
            { cell: "C1", value: "同比" },
          ],
          [
            { cell: "A2", value: "毛利率" },
            { cell: "B2", value: 42.5, formula: "=D2/E2" },
            { cell: "C2", value: "#DIV/0!", error: "#DIV/0!", formula: "=B2/0" },
          ],
        ],
        formulas: [
          { cell: "B2", formula: "=D2/E2", value: 42.5 },
          { cell: "C2", formula: "=B2/0", value: "#DIV/0!" },
        ],
        errorCells: [{ sheet: "Summary", cell: "C2", error: "#DIV/0!", formula: "=B2/0" }],
      },
      {
        name: "Detail",
        totalRows: 10,
        totalCols: 2,
        truncated: false,
        rows: [
          [
            { cell: "A1", value: "地区" },
            { cell: "B1", value: "收入" },
          ],
        ],
        formulas: [],
        errorCells: [],
      },
    ],
    errorCells: [{ sheet: "Summary", cell: "C2", error: "#DIV/0!", formula: "=B2/0" }],
    qaIssues: [],
  };

  it("支持多 Sheet 切换、计算值/公式切换、错误定位与点选单元格一键批注", async () => {
    const auth = createMemoryAuthSession(() => {}, "jwt-xlsx-token");
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ preview: XLSX_PAYLOAD }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as typeof fetch;

    const onAnnotate = vi.fn();
    render(
      <ToastProvider>
        <OfficeRichPreview
          path="/workspace/finance.xlsx"
          name="finance.xlsx"
          auth={auth}
          onAnnotate={onAnnotate}
          fallback={<div data-testid="fallback">fallback</div>}
        />
      </ToastProvider>,
    );

    expect(await screen.findByTestId("office-preview-xlsx")).toBeInTheDocument();
    expect(screen.getByTestId("office-xlsx-truncated")).toHaveTextContent("共 1200 行");
    expect(screen.getByTestId("office-xlsx-error-bar")).toHaveTextContent("Summary!C2");

    // 切换到公式模式
    fireEvent.click(screen.getByTestId("office-xlsx-mode-formulas"));
    expect(screen.getByText("=D2/E2")).toBeInTheDocument();

    // 切换到 Detail sheet，再通过错误定位条一键跳回 Summary!C2
    fireEvent.click(screen.getByTestId("office-xlsx-sheet-tab-1"));
    expect(screen.getByText("地区")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("office-xlsx-error-jump-C2"));
    expect(screen.getByTestId("office-xlsx-selection-bar")).toHaveTextContent("Summary!C2");

    // 点选「批注此单元格」触发 { kind: 'cell', sheet: 'Summary', ref: 'C2' }
    fireEvent.click(screen.getByTestId("office-annotate-cell"));
    expect(onAnnotate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "cell", sheet: "Summary", ref: "C2" }),
      expect.stringContaining("Summary!C2"),
    );
  });
});
