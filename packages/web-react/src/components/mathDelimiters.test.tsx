import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import { afterEach, describe, expect, test } from "vitest";
import { normalizeMathDelimiters as N } from "./mathDelimiters";

afterEach(cleanup);

describe("normalizeMathDelimiters(转换)", () => {
  test("行内 \\(...\\) → $...$,行间 \\[...\\] → $$...$$", () => {
    expect(N("能量 \\(E=mc^2\\) 守恒")).toBe("能量 $E=mc^2$ 守恒");
    expect(N("勾股:\\[a^2+b^2=c^2\\]")).toBe("勾股:$$a^2+b^2=c^2$$");
  });

  test("多行行间公式照常转换", () => {
    const src = "推导:\n\\[\nP_n(x) = c_0 + c_1(x-a)\n\\]\n完成";
    expect(N(src)).toBe("推导:\n$$\nP_n(x) = c_0 + c_1(x-a)\n$$\n完成");
  });

  test("代码块 / 行内代码里的 \\( \\[ 不被转换", () => {
    expect(N("行内代码 `f\\(x\\)` 保持")).toBe("行内代码 `f\\(x\\)` 保持");
    const fenced = "```js\nconst s = '\\\\(x\\\\)';\n```";
    expect(N(fenced)).toBe(fenced);
    // 代码外的真公式仍转换,代码内不动
    expect(N("代码 `g\\(a\\)`,公式 \\(b\\)")).toBe("代码 `g\\(a\\)`,公式 $b$");
  });

  test("未闭合围栏代码块(流式)里的 \\( 不被转换", () => {
    // 流式渲染:代码块尚未收到闭合 ``` → 必须吃到 EOF 保护,否则代码里的 \( 被改写。
    const unclosed = "```js\nconst s = '\\\\(x\\\\)';\n";
    expect(N(unclosed)).toBe(unclosed);
    // 未闭合块之后(同段)出现的内容也都在块内,不转换。
    expect(N("```\n\\(a\\) still code")).toBe("```\n\\(a\\) still code");
  });

  test("多反引号 code span(含单反引号)里的 \\( 不被转换", () => {
    expect(N("``a ` b \\(x\\) c`` 外 \\(y\\)")).toBe("``a ` b \\(x\\) c`` 外 $y$");
  });

  test("无 LaTeX 定界符 → 原样返回(快路径)", () => {
    expect(N("纯文本,$已有$ 美元公式不动")).toBe("纯文本,$已有$ 美元公式不动");
  });

  test("占位符不与正文'空格-数字-空格'碰撞", () => {
    // 既有代码块(会被占位)又有 ' 3 ' 文本,还原后 ' 3 ' 必须完好。
    const src = "买了 3 个;`x\\(1\\)`;公式 \\(n\\) 见上 7 次";
    expect(N(src)).toBe("买了 3 个;`x\\(1\\)`;公式 $n$ 见上 7 次");
  });
});

// ── 端到端:归一化后经真实 remark-math + rehype-katex 必须渲染出 KaTeX ──
function renderMd(src: string) {
  return render(
    <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false }]]}>
      {src}
    </ReactMarkdown>,
  );
}

describe("端到端渲染(根治验证)", () => {
  test("归一化后 \\(...\\) / \\[...\\] 渲染成 KaTeX,无残留反斜杠定界符", () => {
    const { container } = renderMd(N("行内 \\(E=mc^2\\),行间:\\[a^2+b^2=c^2\\]"));
    expect(container.querySelector(".katex")).not.toBeNull(); // KaTeX 真渲染了
    const txt = container.textContent || "";
    expect(txt).not.toContain("\\("); // 不再有裸定界符
    expect(txt).not.toContain("\\[");
  });

  test("对照:不归一化则 \\(...\\) 渲染不出 KaTeX(证明修复必要)", () => {
    const { container } = renderMd("行内 \\(E=mc^2\\)"); // 未经 N()
    expect(container.querySelector(".katex")).toBeNull(); // remark-math 不认 → 没渲染
  });

  test("#f3c5d40c 真实失败原文(泰勒展开)归一化后正常渲染", () => {
    // 取自线上响应 #f3c5d40c —— 行内 \(...\) + 多行行间 \[...\] 混排。
    const real =
      "给定函数 \\(f(x)\\),想在 \\(x = a\\) 附近用一个 \\(n\\) 次多项式 \\(P_n(x)\\) 来逼近它:\n\n" +
      "\\[\nP_n(x) = c_0 + c_1(x-a) + c_2(x-a)^2 + \\cdots + c_n(x-a)^n\n\\]\n\n" +
      "其中 \\(c_k = \\frac{f^{(k)}(a)}{k!}\\)。";
    const { container } = renderMd(N(real));
    expect(container.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(4); // 多处公式都渲染
    // \frac 进入 KaTeX:出现在分式结构(.mfrac)里,而非作为原文露出。
    expect(container.querySelector(".katex .mfrac")).not.toBeNull();
    const txt = container.textContent || "";
    expect(txt).not.toContain("\\("); // 无裸行内定界符残留
    expect(txt).not.toContain("\\["); // 无裸行间定界符残留
  });
});
