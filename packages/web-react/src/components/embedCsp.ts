/**
 * htmlpreview 嵌入的 CSP 和注入位置。单独成文件是为了体积:首屏的兜底预览(Markdown.tsx)只要这一点,
 * 样式套件和引导脚本(./embedDoc)只进懒加载 chunk。
 */

/** 允许加载脚本 / 样式 / 网络请求的 CDN(固定版本由提示词要求)。 */
export const EMBED_CDN_HOSTS = ["https://cdn.jsdelivr.net", "https://unpkg.com", "https://cdnjs.cloudflare.com"];

export function embedCsp(): string {
  const cdn = EMBED_CDN_HOSTS.join(" ");
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' blob: ${cdn}`,
    `style-src 'unsafe-inline' ${cdn} https://fonts.googleapis.com`,
    `font-src data: ${cdn} https://fonts.gstatic.com`,
    "img-src data: blob: https:",
    `media-src data: blob: ${cdn}`,
    `connect-src data: blob: ${cdn}`,
    "worker-src blob:",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

/**
 * 我们自己的 doctype + 注入内容永远放在第 0 个字节,模型写的任何东西(注释、doctype、脚本)都排在后面。
 * 不去「跳过开头的注释 / doctype」:HTML 解析器对注释的切分(例如 `<!-->` 本身就是一个完整注释)和正则不同,
 * 跳错一次,模型的脚本就会先于 CSP 执行(Codex r2 用 `<!--><script src=…>` 复现过)。
 * 模型后面再写的 doctype 只是一个被忽略的解析错误,不影响标准模式;出现在 <html>/<head> 之前的
 * meta / style / script 会被解析器放进真正的 head。
 */
export function injectHead(code: string, inject: string): string {
  return `<!DOCTYPE html>${inject}${code}`;
}

/** 只加 CSP(懒加载 chunk 未到 / 加载失败时的兜底预览用,不带样式套件和引导脚本)。 */
export function wrapWithCspOnly(code: string): string {
  return injectHead(code, `<meta http-equiv="Content-Security-Policy" content="${embedCsp()}">`);
}
