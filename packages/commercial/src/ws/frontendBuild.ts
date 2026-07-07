import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 前端构建身份探针(版本握手服务端)。
 *
 * 权威源 = `<distDir>/index.html` 里 vite build 注入的 `<meta name="oc-build">`
 * (见 web-react/vite.config.ts ocBuildMeta 插件)。bridge 在每个 userWs accept 时
 * 用它发 `sys.frontend_build` 帧;客户端(lib/appUpdate)比对自己 DOM 里的同一 meta,
 * 在安全点软刷新。**两端读的是同一个文件产物,不存在第二套版本推导。**
 *
 * 缓存:stat mtime + TTL(默认 5s)。dist 被 rsync 覆盖(mtime 变)后最迟 TTL 内
 * 读到新值——虽然按部署纪律 dist 变更必重启 master(全 WS 重连拿新帧),这里不把
 * 纪律当前提,漏重启时探针照样收敛到新 id。
 *
 * 任何失败(文件缺失/无 meta/形态非法)→ null:bridge 不发帧,前端零行为变化。
 * 版本握手是 best-effort 自愈通道,绝不 fail-closed 拖垮主链路。
 */
const OC_BUILD_META_RE = /<meta\s+name="oc-build"\s+content="([0-9a-f]{8,32})"/;

export function createFrontendBuildProbe(
  distDir: string,
  opts?: { ttlMs?: number; now?: () => number },
): () => string | null {
  const ttlMs = opts?.ttlMs ?? 5_000;
  const now = opts?.now ?? Date.now;
  const indexPath = join(distDir, "index.html");
  let cached: { value: string | null; mtimeMs: number; checkedAt: number } | null = null;

  return () => {
    const t = now();
    if (cached && t - cached.checkedAt < ttlMs) return cached.value;
    try {
      const st = statSync(indexPath);
      if (cached && cached.mtimeMs === st.mtimeMs) {
        cached.checkedAt = t;
        return cached.value;
      }
      const html = readFileSync(indexPath, "utf8");
      const m = OC_BUILD_META_RE.exec(html);
      cached = { value: m?.[1] ?? null, mtimeMs: st.mtimeMs, checkedAt: t };
    } catch {
      cached = { value: null, mtimeMs: -1, checkedAt: t };
    }
    return cached.value;
  };
}
