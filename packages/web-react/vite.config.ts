import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * 前端构建身份(版本握手单一权威):对最终 index.html(资产标签已注入)取
 * sha256 前 16 hex,写成 `<meta name="oc-build" content="…">`。
 *  - 内容派生:源码没变的重复构建产出相同 id → 不触发客户端无谓刷新。
 *  - 仅 build 注入(apply:'build');dev 无此 meta → 客户端 reload governor 恒 inert。
 *  - 服务端(commercial frontendBuild probe)与客户端(lib/appUpdate)都只读这同一个
 *    meta,不允许出现第二套版本推导。
 *  - 双入口后**仅** index.html 承载 oc-build:第二入口 admin.html 不注入,避免出现
 *    第二个版本推导源、也不改变 index.html 自身的哈希(两份 html 独立 transform,
 *    admin 注入与否都不影响 index 的 meta 值,这里显式 skip 是为语义清晰 + 零干扰)。
 */
function ocBuildMeta(): Plugin {
  return {
    name: "oc-build-meta",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        // ctx.path 形如 '/index.html' | '/admin.html'。只对用户端 index.html 注入。
        if (ctx.path !== "/index.html") return;
        const id = createHash("sha256").update(html).digest("hex").slice(0, 16);
        if (!html.includes("</head>")) {
          throw new Error(
            "oc-build-meta: index.html 缺 </head>,无法注入构建身份",
          );
        }
        return html.replace(
          "</head>",
          `  <meta name="oc-build" content="${id}">\n  </head>`,
        );
      },
    },
  };
}

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), ocBuildMeta()],
    server: {
      host: "127.0.0.1",
      port: 5174,
      strictPort: true,
    },
    preview: {
      host: "127.0.0.1",
      port: 4174,
      strictPort: true,
    },
    build: {
      outDir: "dist",
      sourcemap: true,
      manifest: true,
      // 双 Vite 入口:用户端 SPA(index.html)+ 管理后台(admin.html)。两者共享
      // 同一 assets 目录(内容哈希、可长缓存)与同一设计系统 chunk(react-vendor /
      // radix-vendor),仅入口 html + admin 专属懒块不同。URL 仍是真实文件 /admin.html。
      // 注意:rolldown-vite 下 build.rollupOptions 是 rolldownOptions 的 deprecated 别名,
      // 故 input 与既有 output.codeSplitting 一起放进 rolldownOptions,避免两处配置互相覆盖。
      // 手动分 chunk（rolldown codeSplitting.groups）。目标：首屏 vendor 单独成块走内容哈希
      // 长缓存（vite 默认 assets/[name]-[hash].js），依赖不变时跨发版命中缓存。
      //  - react-vendor / radix-vendor：首屏同步加载。
      //  注意：重渲染库（react-markdown / highlight.js / unified 生态）**不**在此手动归组。
      //  它们只被 components/MarkdownImpl（经 React.lazy 动态 import）引用，自动代码分割
      //  会把它们落进按需异步 chunk；手动归组反而有把「同步图也引用的通用 util（如
      //  is-plain-obj / extend）」一并圈进同一块、从而经该 util 在 entry 建立静态边、把整块
      //  markdown 拽回首屏的风险（已实测复现）。故让动态 import 自然成块，最稳。
      rolldownOptions: {
        input: {
          main: fileURLToPath(new URL("./index.html", import.meta.url)),
          admin: fileURLToPath(new URL("./admin.html", import.meta.url)),
        },
        output: {
          codeSplitting: {
            groups: [
              {
                name: "react-vendor",
                test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
                priority: 20,
              },
              {
                name: "radix-vendor",
                test: /node_modules[\\/](@radix-ui|@floating-ui|aria-hidden|react-remove-scroll[^\\/]*|use-sidecar|use-callback-ref|get-nonce)[\\/]/,
                priority: 10,
              },
            ],
          },
        },
      },
    },
    test: {
      environment: "jsdom",
      globals: false,
      setupFiles: ["./src/test/setup.ts"],
      // 用例级超时与 setup.ts 的 asyncUtilTimeout(5s)拉开梯度:waitFor 先于用例超时
      // 报出精确断言错误,而不是笼统的 "Test timed out"。
      // 显式权衡:**不**关 fileParallelism —— 实测本机串行 7m12s vs 并行 ~1m(CI 4vCPU
      // 并行 ~72s),6 倍税不可接受;并行下的截止线饥饿由 asyncUtilTimeout 校准根治,
      // 时序竞态一律修在交互语义上(等 enabled 再点/先等 boot 选中落定),不靠串行掩盖。
      testTimeout: 15_000,
    },
  };
});
