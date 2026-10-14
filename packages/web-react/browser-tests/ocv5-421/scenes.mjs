// OCV5-421 render lab scenes. Every function runs inside the page (self-contained; uses window.__lab).
export const longCode = (n, label) => "```" + label + "\n" + Array.from({ length: n }, (_, i) =>
  `  const row${i} = items.filter((x) => x.score > ${i % 97}).map((x) => ({ id: x.id, total: x.a + x.b * ${i} }))`).join("\n") + "\n```";

export const TEXT = {
  md: [
    "## 价格与公式",
    "基础版 $5，专业版 $10 每月；企业版 $1,299 起。公式：$E=mc^2$，以及 $2x+1$。",
    "",
    "长行内公式：$\\sum_{i=1}^{n} \\frac{a_i b_i c_i d_i e_i f_i g_i h_i}{\\sqrt{x_i^2 + y_i^2 + z_i^2 + w_i^2 + u_i^2 + v_i^2}} + \\int_0^\\infty e^{-t^2} \\mathrm{d}t$。",
    "",
    "$$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$",
    "",
    "结论见脚注[^1]。",
    "",
    "| 名称 | 链接 | 说明 |",
    "|---|---|---|",
    "| 文档 | https://example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?x=1&y=2 | 第一行<br>第二行 |",
    "| 代码 | `some_extremely_long_identifier_name_without_breaks_abcdefghijklmnopqrstuvwxyz` | 普通 |",
    "",
    "```c++\nint main() { std::cout << \"hi\"; }\n```",
    "",
    "[^1]: 来源说明。",
  ].join("\n"),
};

const ERROR_CODES = [
  ["model_not_available", "当前模型暂不可用"],
  ["auth_error", "登录状态已失效"],
  ["session_persist_unavailable", "会话保存服务暂时不可用"],
  ["project_context_unavailable", "项目上下文暂不可用"],
  ["context_too_long", "上下文过长"],
  ["upstream_failed", "上游服务暂时不可用"],
];
const errorScene = ([code, message]) => ({
  id: `err-${code}`,
  shots: [{ name: "top", scroll: "top" }],
  setup: new Function(`const L = window.__lab; const c = L.begin("触发 ${code}");
    L.raw({ type: "outbound.error", clientMessageId: c, code: ${JSON.stringify(code)}, message: ${JSON.stringify(message)}, isFinal: false });
    L.frame(c, [{ kind: "text", blockId: "e-" + c, messageId: "e-" + c, text: "[error]" }], true);`),
  settleMs: 2000,
  probe: () => [...document.querySelectorAll("main button, [data-lab-scroll] button")].map((b) => (b.textContent || "").trim()).filter(Boolean),
});

export const SCENES = [
  ...ERROR_CODES.map(errorScene),
  {
    id: "md-edge",
    setup: () => { window.__lab.turn({ user: "价格、公式、表格、脚注示例", text: window.__TEXT_MD }); },
    probe: () => ({
      katexInline: document.querySelectorAll(".katex:not(.katex-display .katex)").length,
      currencyAsMath: [...document.querySelectorAll(".katex")].some((k) => /and|专业版|每月/.test(k.textContent || "")),
      literalBr: document.body.innerText.includes("<br>"),
      nodeAttrLeak: document.querySelectorAll("[node]").length,
      footnoteTargetBlank: [...document.querySelectorAll('a[href^="#"]')].filter((a) => a.target === "_blank").length,
      codeLangLabels: [...document.querySelectorAll("pre")].map((p) => p.closest("figure,div")?.querySelector("span")?.textContent).slice(0, 4),
    }),
    shots: [{ name: "top", scroll: "top" }, { name: "table", sel: "table" }],
  },
  {
    id: "code-long",
    setup: () => { window.__lab.turn({ user: "给一段很长的代码", text: "下面是代码：\n\n" + window.__LONG_CODE + "\n\n超长单行：\n\n```\n" + "x".repeat(3000) + "\n```\n\n结束。" }); },
    probe: () => {
      const pres = [...document.querySelectorAll("pre")];
      return { preHeights: pres.map((p) => Math.round(p.getBoundingClientRect().height)), scrollHeight: document.querySelector("[data-lab-scroll]").scrollHeight };
    },
    shots: [{ name: "top", scroll: "top" }, { name: "mid", scroll: 2500 }, { name: "bottom", scroll: "bottom" }],
  },
  {
    id: "tools-mixed",
    expand: true,
    setup: () => {
      window.__lab.turn({
        user: "跑几个命令",
        thinking: "先看目录，再跑测试。".repeat(40),
        tools: [
          { name: "Bash", input: { command: "ls -la /workspace" }, output: "total 8\ndrwxr-xr-x 2 agent agent 4096 .\n-rw-r--r-- 1 agent agent 12 README.md" },
          { name: "Bash", input: { command: "npm test" }, output: "Error: Cannot find module 'vitest'\n    at Module._resolveFilename", isError: true },
          { name: "Read", input: { file_path: "/workspace/big.log" }, output: Array.from({ length: 3000 }, (_, i) => `line ${i} ` + "y".repeat(20)).join("\n") },
          { name: "SomeUnknownTool", input: { q: 1 }, output: "ok" },
        ],
        text: "已完成：目录正常，测试缺少 vitest 依赖。",
      });
    },
    probe: () => ({ running: (document.body.innerText.match(/运行中/g) || []).length }),
    shots: [{ name: "top", scroll: "top" }, { name: "bottom", scroll: "bottom" }],
  },
  {
    id: "stop-tool",
    expand: true,
    setup: () => {
      const L = window.__lab;
      const c = L.begin("跑一个很慢的命令");
      L.frame(c, [{ kind: "text", blockId: "a1", messageId: "a1", text: "好的，开始运行。" }]);
      L.frame(c, [{ kind: "tool_use", blockId: "slow1", toolName: "Bash", inputJson: { command: "sleep 600 && echo done" } }]);
      L.frame(c, [], true, { meta: { interrupted: "user_cancelled" } });
    },
    probe: () => {
      const t = document.body.innerText;
      return { done: /完成|已完成/.test(t), cancelled: /已取消|已停止/.test(t), running: /运行中/.test(t) };
    },
    shots: [{ name: "top", scroll: "top" }],
  },
  {
    id: "legacy-error-tool",
    expand: true,
    setup: () => {
      const L = window.__lab;
      const c = L.begin("跑一个命令然后上游断了");
      L.frame(c, [{ kind: "tool_use", blockId: "slow2", toolName: "Bash", inputJson: { command: "make build" } }]);
      setTimeout(() => L.raw({ type: "error", clientMessageId: c, code: "upstream_failed", message: "upstream failed" }), 300);
    },
    settleMs: 3000,
    probe: () => {
      const t = document.body.innerText;
      return { running: /运行中/.test(t), spinners: document.querySelectorAll(".animate-spin").length, text: t.slice(-400) };
    },
    shots: [{ name: "top", scroll: "top" }],
  },
  {
    id: "mermaid-stream",
    setup: () => {
      const L = window.__lab;
      const c = L.begin("画个流程图");
      window.__mm = { samples: [] };
      L.stream(c, "流程如下：\n\n```mermaid\ngraph TD\nA[开始]-->B[处理]\nB-->C[校验]\nC-->D[归档]\nD-->E[结束]\n```\n\n完成。", { chunk: 3, everyMs: 60 });
    },
    settleMs: 200,
    during: () => new Promise((resolve) => {
      let last = ""; let swaps = 0; let n = 0;
      const t = setInterval(() => {
        const s = document.querySelector("svg[id^=mermaid], [data-mermaid] svg") ? "svg" : /图表渲染中/.test(document.body.innerText) ? "placeholder" : "pre";
        if (s !== last) { swaps++; last = s; }
        if (++n > 140) { clearInterval(t); resolve({ swaps, final: last }); }
      }, 50);
    }),
    shots: [{ name: "top", scroll: "top" }],
  },
  {
    id: "math-partial",
    setup: () => {
      const L = window.__lab;
      const c = L.begin("推导一个公式");
      L.frame(c, [{ kind: "text", blockId: "m1", messageId: "m1", text: "推导如下：\n\n$$\n\\frac{a}{" }]);
    },
    probe: () => ({ katexError: document.querySelectorAll(".katex-error").length, redText: [...document.querySelectorAll("[style*='color']")].filter((e) => /#cc0000|rgb\(204, 0, 0\)/.test(e.getAttribute("style") || "")).length }),
    shots: [{ name: "top", scroll: "top" }],
  },
  {
    id: "perf-stream",
    perf: async (turns) => {
      const L = window.__lab;
      const code = (n) => "```\n" + Array.from({ length: n }, (_, i) => `function f${i}(a, b) { return a.map((x) => x * ${i} + b).filter(Boolean) }`).join("\n") + "\n```";
      const para = "这是一段较长的说明文字，用来模拟模型的正常输出，包含 **加粗**、`行内代码` 和 [链接](https://example.com)。".repeat(4);
      for (let i = 0; i < turns; i++) {
        L.turn({ user: `历史问题 ${i}`, tools: i % 3 === 0 ? [{ name: "Bash", input: { command: `echo ${i}` }, output: `${i}` }] : [],
          text: `${para}\n\n${i % 5 === 0 ? code(20) : "- 列表项一\n- 列表项二"}\n\n| a | b |\n|---|---|\n| ${i} | x |`, chunk: 100000 });
      }
      await new Promise((r) => setTimeout(r, 1500));
      const el = document.querySelector("[data-lab-scroll]"); el.scrollTop = el.scrollHeight;
      await new Promise((r) => setTimeout(r, 800));
      const answer = [para, code(250), para, "| 列1 | 列2 | 列3 |\n|---|---|---|\n" + Array.from({ length: 60 }, (_, i) => `| ${i} | 值 ${i} | 说明 ${i} |`).join("\n"), para, code(150), para].join("\n\n");
      const lt = []; const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) lt.push(e.duration); });
      po.observe({ type: "longtask", buffered: false });
      const gaps = []; let lastF = performance.now(); let on = true;
      const raf = (t) => { gaps.push(t - lastF); lastF = t; if (on) requestAnimationFrame(raf); };
      requestAnimationFrame(raf);
      const c = L.begin("写一段长回答");
      const t0 = performance.now();
      await L.stream(c, answer, { chunk: 40, everyMs: 16 });
      const streamMs = performance.now() - t0;
      await new Promise((r) => setTimeout(r, 2000));
      on = false; po.disconnect();
      const sum = (a) => a.reduce((x, y) => x + y, 0);
      return {
        turns, answerChars: answer.length, frames: Math.ceil(answer.length / 40), idealMs: Math.ceil(answer.length / 40) * 16,
        streamMs: Math.round(streamMs), longTasks: lt.length, longTaskTotalMs: Math.round(sum(lt)), longTaskMaxMs: Math.round(Math.max(0, ...lt)),
        jank50: gaps.filter((g) => g > 50).length, jank100: gaps.filter((g) => g > 100).length, maxGapMs: Math.round(Math.max(...gaps)),
        domNodes: document.getElementsByTagName("*").length,
      };
    },
  },
];
