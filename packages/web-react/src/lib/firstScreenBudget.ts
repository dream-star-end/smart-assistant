/**
 * 首屏体量门(纯函数,构建插件 glue 见 vite.config.ts 的 firstScreenBudget())。
 *
 * why:index.html 的 modulepreload 集合 = SPA 入口 chunk 的**静态** import 闭包,
 * 这批 js 不论多大都会在首屏前下载+解析。2026-09 审计发现它已膨胀到 461KB gzip
 * (useAppRoute 拖教程案例数据、api.ts 拖 admin 域、死依赖等)。修复后用这道门把
 * 「新代码把大模块静态接进入口」堵在 CI:超预算直接 fail build,并列出 top chunk
 * 帮定位。动态 import(import())不在静态闭包里,不受本门约束 —— 该懒加载的请懒加载。
 *
 * 与 forbidTaskboardEntryImport 同一模式:纯函数进 src/lib 可单测,vite 插件只做胶水。
 */

export type FirstScreenChunkLike = {
  type: string;
  fileName: string;
  /** chunk 的 js 源码(构建产物文本);gzip 尺寸由注入的 gzipSize 回调计算。 */
  code: string;
  isEntry?: boolean;
  facadeModuleId?: string | null;
  imports?: string[];
};

export type FirstScreenBudgetReport = {
  /** 首屏闭包(入口 + 递归静态依赖)的 gzip 总字节。 */
  totalGzipBytes: number;
  budgetBytes: number;
  overBudget: boolean;
  /** 未被入口闭包引用的 chunk 数(诊断用:若入口丢失依赖会异常)。 */
  closureChunkCount: number;
  /** gzip 最大的前 8 个闭包内 chunk(降序)。 */
  top: { fileName: string; gzipBytes: number }[];
};

/**
 * 用户端 SPA 入口 chunk:isEntry 且 facadeModuleId 指向 index.html。
 * 实测(rolldown-vite 2026-09)HTML 入口 chunk 的 facadeModuleId 是 html 路径
 * (…/index.html)而非 main.tsx。管理后台入口 admin.html 按路径含 admin 排除
 * (与 forbidTaskboardEntryImport 的 isSpaEntryChunk 同一判型)。
 */
export function isFirstScreenEntryChunk(chunk: FirstScreenChunkLike): boolean {
  if (chunk.type !== "chunk" || !chunk.isEntry) return false;
  const id = `${chunk.fileName}\0${chunk.facadeModuleId ?? ""}`;
  return /index\.html$/.test(id) && !/admin/i.test(id);
}

/**
 * 收集首屏静态闭包:入口 chunk + 沿 imports 递归的全部静态依赖(即 index.html
 * 会 modulepreload 的集合,外加入口自身)。imports 是相对路径("./x.js"),产物
 * fileName 带 "assets/" 前缀,按 basename 归一解析(同 forbidTaskboardEntryImport)。
 */
export function collectFirstScreenClosure(
  chunks: readonly FirstScreenChunkLike[],
): FirstScreenChunkLike[] {
  const byBasename = new Map<string, FirstScreenChunkLike[]>();
  for (const chunk of chunks) {
    const base = basename(chunk.fileName);
    const list = byBasename.get(base);
    if (list) list.push(chunk);
    else byBasename.set(base, [chunk]);
  }
  const entry = chunks.find(isFirstScreenEntryChunk);
  if (!entry) return [];
  const seen = new Set<string>([entry.fileName]);
  const closure: FirstScreenChunkLike[] = [entry];
  // 迭代式 BFS:deps 的 import 边在产物里是扁平相对路径,集合去重防环/防重。
  const queue: FirstScreenChunkLike[] = [entry];
  while (queue.length) {
    const current = queue.shift()!;
    for (const imp of current.imports ?? []) {
      for (const dep of byBasename.get(basename(imp)) ?? []) {
        if (seen.has(dep.fileName)) continue;
        seen.add(dep.fileName);
        closure.push(dep);
        queue.push(dep);
      }
    }
  }
  return closure;
}

/**
 * 计算首屏闭包 gzip 总量并对比预算。gzipSize 注入 node:zlib 的 gzipSync
 * (保持本模块零 node 依赖,浏览器 tsconfig 也能编译)。
 */
export function firstScreenBudgetReport(
  chunks: readonly FirstScreenChunkLike[],
  budgetBytes: number,
  gzipSize: (code: string) => number,
): FirstScreenBudgetReport {
  const closure = collectFirstScreenClosure(chunks);
  const sized = closure.map((chunk) => ({
    fileName: chunk.fileName,
    gzipBytes: gzipSize(chunk.code),
  }));
  const totalGzipBytes = sized.reduce((sum, item) => sum + item.gzipBytes, 0);
  const top = [...sized].sort((a, b) => b.gzipBytes - a.gzipBytes).slice(0, 8);
  return {
    totalGzipBytes,
    budgetBytes,
    overBudget: totalGzipBytes > budgetBytes,
    closureChunkCount: closure.length,
    top,
  };
}

/** 超预算时的报错文案:总量 + 预算 + top 8 chunk,直接可贴进 CI 日志定位。 */
export function describeFirstScreenBudget(report: FirstScreenBudgetReport): string {
  const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)}KB`;
  const lines = [
    `首屏(index.html modulepreload 闭包,${report.closureChunkCount} 个 chunk)gzip ${kb(report.totalGzipBytes)} 超过预算 ${kb(report.budgetBytes)}。`,
    "把大模块移出入口静态 import(动态 import / 按需加载),或确认体量增长后上调 FIRST_SCREEN_GZIP_BUDGET 并说明理由:",
    ...report.top.map((item) => `  ${item.fileName}  ${kb(item.gzipBytes)}`),
  ];
  return lines.join("\n");
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}
