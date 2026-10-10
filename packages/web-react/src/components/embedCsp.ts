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
 * 把注入内容放到文档最前面,不去解析模型的 HTML 找 <head>(注释里的 "<head>" 之类会把注入骗进注释)。
 * 只跳过开头的空白 / 注释 / doctype(放在 doctype 前面会进怪异模式)。HTML 解析器会把 <html>/<head>
 * 之前出现的 meta / style / script 放进真正的 head,之后再出现的 <html>/<head> 标签只合并属性、不另起 head,
 * 所以注入物一定在 head 里、一定早于模型的任何脚本执行。没有 doctype 的补一个标准模式 doctype。
 */
export function injectHead(code: string, inject: string): string {
  const lead = /^(?:\s|<!--[\s\S]*?-->)*<!doctype[^>]*>/i.exec(code);
  if (lead) return `${lead[0]}${inject}${code.slice(lead[0].length)}`;
  return `<!DOCTYPE html>${inject}${code}`;
}

/** 只加 CSP(懒加载 chunk 未到 / 加载失败时的兜底预览用,不带样式套件和引导脚本)。 */
export function wrapWithCspOnly(code: string): string {
  return injectHead(code, `<meta http-equiv="Content-Security-Policy" content="${embedCsp()}">`);
}
