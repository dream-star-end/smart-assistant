import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { forbiddenTaskboardEntryImports } from "./src/lib/forbidTaskboardEntryImport";
import { describeFirstScreenBudget, firstScreenBudgetReport } from "./src/lib/firstScreenBudget";
import { deferEntryStylesheets } from "./src/lib/nonBlockingCss";

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

/**
 * OCV5-422 慢网首屏:index.html 的入口样式表改为非阻塞(preload + 脚本插入),样式就绪前由内联占位顶着,
 * main.tsx 等样式就绪再挂载 React(防无样式闪屏)。纯函数与说明见 src/lib/nonBlockingCss。
 * 必须排在 ocBuildMeta 之前:构建身份按最终 html 取哈希。
 */
function nonBlockingEntryCss(): Plugin {
  return {
    name: "non-blocking-entry-css",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        if (ctx.path !== "/index.html") return;
        const deferred = deferEntryStylesheets(html);
        if (deferred.hrefs.length === 0) {
          throw new Error("non-blocking-entry-css: index.html 里没有入口样式表 link,构建产物结构变了?");
        }
        return deferred.html;
      },
    },
  };
}

/**
 * Fail the production build if the lazy TaskboardView chunk still imports the
 * SPA entry. That graph made lucide icons share minified names with App
 * callbacks; opening /board then rendered a useCallback as <Kanban />.
 */
function forbidTaskboardEntryImport(): Plugin {
  return {
    name: "forbid-taskboard-entry-import",
    apply: "build",
    generateBundle(_opts, bundle) {
      const chunks = Object.values(bundle).flatMap((item) => {
        if (item.type !== "chunk") return [];
        return [
          {
            type: item.type,
            fileName: item.fileName,
            isEntry: item.isEntry,
            facadeModuleId: item.facadeModuleId,
            imports: item.imports,
          },
        ];
      });
      const bad = forbiddenTaskboardEntryImports(chunks);
      if (bad.length) {
        throw new Error(
          `TaskboardView 异步块不得从 SPA 入口 main chunk 引入（打开任务面板会炸 ChunkErrorBoundary）:\n${bad.join("\n")}`,
        );
      }
    },
  };
}

/**
 * 首屏体量门:index.html 的 modulepreload 集合(= SPA 入口 chunk 的静态 import 闭包,
 * 含入口自身)gzip 总量超过 FIRST_SCREEN_GZIP_BUDGET 即 fail build。2026-09 审计该集合
 * 已达 461117 bytes gzip(useAppRoute 拖教程案例数据 / api.ts 拖 admin 域 / 死依赖等),
 * 修复后实测 436426;当时阈值取实测值上取整到 10KB(439296)+ 20KB 余量 = 459776。
 * 2026-09-10 R5 UX + present_task_approval 落地后,lazy 拆出 TaskApprovalCard /
 * 动态 import taskboardApi 仍测得 451.1KB gzip,吃掉原 20KB 余量并超 449.0KB 门
 * (train tr-20260910T104907Z)。新阈值取 451.1KB 上取整到 10KB = 471040(460.0KB),
 * 约 9KB 余量;仍不许把教程目录/admin 域量级的大模块静态接进入口。
 * 2026-09-17 v5 个人版审计 B 轮合入后 integration 实测 471.4KB(超 11.4KB;main +7.7KB /
 * tapePayload +5.4KB / styles +1.3KB),**阈值不动**,改把「点开才需要」的覆盖层移出入口静态闭包:
 * ImageViewer 三模式(含 ImageAnnotationEditor)、InboxDialog / GithubRepoModal /
 * MessageFeedbackDialog / ProjectSettingsDialog(+ProjectAssetsPanel)改 React.lazy,订阅意图 /
 * 项目色板两处小常量下沉到 lib 以断开红卡 / 侧栏对弹窗的静态边 → 实测 445.5KB(余 14.5KB)。
 * 详见 docs/audit/shell.md §9。
 * 2026-10-11 OCV5-376:余量只剩 1.2KB。名为 styles 的 82KB chunk 其实是 api.ts + protocol + TypeBox +
 * tailwind-merge 的 JS;ProcessDisclosure / lineDiff / agentNames 也只是 rolldown 借来的块名,装的是
 * 聊天卡片、工具摘要和 chat/model·render,首屏渲染离不开,不移出。改为让 protocol 可摇树(见下方
 * rolldownOptions.treeshake)→ 460.6KB,余 10.5KB,阈值不动。每次构建打印一行当前体量与余量。
 * 2026-10-25 P-1(用户拍板「上调或告警后再发」):商业 staging 官方构建硬拒 gzip 460.6KB >
 * 460.0KB(FIRST_SCREEN_GZIP_BUDGET=471040),来自 #1095 OD 收窄合入后的入口闭包。不改告警
 * (硬拒语义保留、其它门禁不动);按既有公式「实测上取整到 10KB」上调阈值:
 * ceil(460.6/10)*10 = 470.0KB = 481280(~9.4KB 余量)。可逆:改回常量即恢复。
 * 2026-10-30 后台整理只留淡灰一行:过程壳在首屏闭包里,不能再拆出去。个人 tip 实测
 * 481102/481280,余量只剩 178。加上这一行后实测 470.4KB,超过 470.0KB。不按 10KB 进位
 * (那会放出约 10KB);只加 1KB 到 471.0KB = 482304。可逆:改回 481280 即恢复。
 * 纯函数与单测在 src/lib/firstScreenBudget。
 */
const FIRST_SCREEN_GZIP_BUDGET = 482304;

function firstScreenBudget(): Plugin {
  return {
    name: "first-screen-budget",
    apply: "build",
    generateBundle(_opts, bundle) {
      const chunks = Object.values(bundle).flatMap((item) => {
        if (item.type !== "chunk") return [];
        return [
          {
            type: item.type,
            fileName: item.fileName,
            code: item.code,
            isEntry: item.isEntry,
            facadeModuleId: item.facadeModuleId,
            imports: item.imports,
          },
        ];
      });
      const report = firstScreenBudgetReport(chunks, FIRST_SCREEN_GZIP_BUDGET, (code) =>
        gzipSync(Buffer.from(code), { level: 9 }).length,
      );
      if (report.overBudget) {
        throw new Error(`first-screen-budget:\n${describeFirstScreenBudget(report)}`);
      }
      // 每次构建都把余量摆出来,而不是等超了才看到(OCV5-376)。
      console.log(
        `first-screen-budget: ${report.totalGzipBytes} / ${FIRST_SCREEN_GZIP_BUDGET} bytes gzip, ` +
          `margin ${FIRST_SCREEN_GZIP_BUDGET - report.totalGzipBytes}`,
      );
    },
  };
}

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), nonBlockingEntryCss(), ocBuildMeta(), forbidTaskboardEntryImport(), firstScreenBudget()],
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
      // 'hidden' = 照常产出 .map 文件(release 目录里保留,供本机栈帧还原/排障),但**不**在
      // bundle 末尾写 `//# sourceMappingURL=` 注释 —— 浏览器/爬虫拿不到指针。
      // 2026-07-26 实测事故:线上 /assets/main-*.js.map 公网 200、901KB、含 72 个源文件的
      // 完整 sourcesContent(等于全量源码泄漏)。本项是四层防护的第一层(源头不留指针),
      // 后三层见 scripts/deploy-v5.sh(rsync 排除 *.map 不进公网池 + 部署活体门)与
      // scripts/v5-caddy-apply.sh(@sourcemap → 404)。true → 'hidden' 不影响任何构建产物
      // 的内容哈希以外的行为,dev(vite serve)不受此项影响。
      sourcemap: "hidden",
      manifest: true,
      // 双 Vite 入口:用户端 SPA(index.html)+ 管理后台(admin.html)。两者共享
      // 同一 assets 目录(内容哈希、可长缓存)与同一设计系统 chunk(react-vendor /
      // radix-vendor),仅入口 html + admin 专属懒块不同。URL 仍是真实文件 /admin.html。
      // 注意:rolldown-vite 下 build.rollupOptions 是 rolldownOptions 的 deprecated 别名,
      // 故 input 与既有 output.codeSplitting 一起放进 rolldownOptions,避免两处配置互相覆盖。
      // 手动分 chunk（rolldown codeSplitting.groups）。目标：首屏 vendor 单独成块走内容哈希
      // 长缓存（vite 默认 assets/[name]-[hash].js），依赖不变时跨发版命中缓存。
      //  - react-vendor / radix-vendor：首屏同步加载。
      //  - lucide-vendor：入口与懒加载中心（任务面板等）共用的图标必须离开 main chunk。
      //    否则 rolldown 把 Kanban/PanelLeft 放进入口后，App 的 useCallback 会复用同一
      //    短名；点「任务」时懒块拿到的已是回调而非图标 → ChunkErrorBoundary。
      //  注意：重渲染库（react-markdown / highlight.js / unified 生态）**不**在此手动归组。
      //  它们只被 components/MarkdownImpl（经 React.lazy 动态 import）引用，自动代码分割
      //  会把它们落进按需异步 chunk；手动归组反而有把「同步图也引用的通用 util（如
      //  is-plain-obj / extend）」一并圈进同一块、从而经该 util 在 entry 建立静态边、把整块
      //  markdown 拽回首屏的风险（已实测复现）。故让动态 import 自然成块，最稳。
      rolldownOptions: {
        // 首屏只用 protocol 的类型、常量和少数纯函数,但 frames/events/research 等模块顶层用
        // TypeBox 建了上百个 schema(Type.Object/Union/...)。打包器不知道这些调用无副作用,
        // 用不到也整段保留,TypeBox 跟着进首屏(OCV5-376 P4)。声明 Type.* 为纯调用,配合
        // packages/protocol 的 "sideEffects": false(模块顶层只有常量/正则/schema,无注册类副作用),
        // 用不到的 schema 和模块就能摇掉:首屏 gzip 469.9KB → 460.6KB(预算 460.0KiB 不动)。
        treeshake: { manualPureFunctions: ["Type"] },
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
                // useMdViewport 被入口(App/useAppRoute)与懒加载中心(任务面板等)共用。
                // 入口直引后 rolldown 会把它并进 main chunk,TaskboardView 懒块随即出现
                // 「异步块 import 入口」的被禁边(见 forbidTaskboardEntryImport)。与
                // lucide-vendor 同理:共享模块单独成块,两边都从它引,不经过入口。
                name: "viewport-shared",
                test: /src[\\/]hooks[\\/]useMdViewport\.ts$/,
                priority: 25,
              },
              {
                name: "lucide-vendor",
                tags: ["$initial"],
                test: /node_modules[\\/]lucide-react[\\/]/,
                priority: 15,
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
      // 并行跑文件,不串行(OCV5-376)。2026-08-21 起命令行带 --maxWorkers=1,本机串行全量
      // 约 60 分钟(CI 约 9 分钟):每个文件都要重付 jsdom 冷加载(本机 require('jsdom') 约 3.3s
      // CPU)与 setup,串行时这些成本一个接一个叠加。实测 8 个 worker 全量 621s,失败只来自
      // 两类可修的依赖:靠全局预取的工具卡体用例(改为各自 loadBeforeAll)和 beforeAll 冷加载
      // MarkdownImpl 超过默认 10s 钩子时限(见 src/test/moduleLoad.ts)。
      // 上限取四分之一核数(v5-dev 16 核 → 4,CI 4 vCPU → 1):这台开发机常有多个会话、Codex
      // 审查同时跑全量,8 个 worker 时负载冲到 30,jsdom 渲染与懒块冷加载被饿到超过 findBy 5s。
      // 并行下的截止线饥饿由 asyncUtilTimeout 校准根治,时序竞态一律修在交互语义上
      // (等 enabled 再点/先等 boot 选中落定),不靠串行掩盖。
      maxWorkers: "25%",
      testTimeout: 15_000,
    },
  };
});
