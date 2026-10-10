/**
 * htmlpreview 无缝嵌入(OCV5-361 G361f):把模型写的单文件 HTML 包成能直接放进回答里的 srcdoc。
 *
 * 往文档最前面注入三样东西(都在模型代码之前,模型改不掉 CSP,只能叠加更严的):
 *   1. CSP:脚本 / 样式 / 网络请求只认三个固定 CDN;禁止提交表单。图片放开 https(界面稿常用图床)。
 *   2. 主题与样式套件:--oc-* 颜色变量(跟随站点明暗主题,父页实时推送)+ 少量类
 *      (.oc-pills 视角切换按钮组、.oc-stage 舞台、.oc-caption 说明行、.oc-links 下载行……)。
 *   3. 引导脚本:上报内容高度(父页据此自适应,不再固定 288px)、接收主题、把密码输入框停用,
 *      以及(仅当模型代码用到时)生成目录文件桥:`data-oc-src` / `ocFile()` / `data-oc-download`。
 *
 * iframe 仍只有 `sandbox="allow-scripts"`(不同源:拿不到父页 cookie / storage / DOM)。
 * 文件桥只给 `.openclaude/generated/` 下的文件,字节经 postMessage 交给 iframe,iframe 拿不到签名 URL。
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

/** 父页推给 iframe 的主题变量:站点 token → --oc-*。 */
export const EMBED_THEME_TOKENS: Record<string, string> = {
  "--oc-bg": "--color-bg",
  "--oc-surface": "--color-surface",
  "--oc-fg": "--color-fg",
  "--oc-muted": "--color-muted",
  "--oc-faint": "--color-faint",
  "--oc-line": "--color-border",
  "--oc-hover": "--color-hover",
  "--oc-accent": "--color-accent",
  "--oc-accent-soft": "--color-accent-soft",
  "--oc-accent-fg": "--color-accent-fg",
};

export function readThemeVars(root: HTMLElement = document.documentElement): Record<string, string> {
  const cs = getComputedStyle(root);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(EMBED_THEME_TOKENS)) {
    const val = cs.getPropertyValue(v).trim();
    if (val) out[k] = val;
  }
  return out;
}

/** 套件样式:变量给默认值(父页推送后覆盖),元素样式都用 :where() 保持零优先级,模型自己的样式总能盖过。 */
export const EMBED_KIT_CSS = `:root{color-scheme:light;--oc-radius:14px;--oc-font:-apple-system,"PingFang SC","Hiragino Sans GB","Noto Sans SC","Microsoft YaHei","Segoe UI",sans-serif;--oc-bg:#f7f7f3;--oc-surface:#fff;--oc-fg:#1b1d18;--oc-muted:#5f645a;--oc-faint:#8a9086;--oc-line:rgba(0,0,0,.09);--oc-hover:rgba(0,0,0,.045);--oc-accent:#2f6f3e;--oc-accent-soft:rgba(47,111,62,.1);--oc-accent-fg:#fff}
:root[data-theme=dark]{color-scheme:dark}
:where(html,body){margin:0;background:transparent;color:var(--oc-fg);font:15px/1.6 var(--oc-font);-webkit-font-smoothing:antialiased}
:where(*,*::before,*::after){box-sizing:border-box}
:where(canvas,img,svg,video){max-width:100%}
.oc-stack{display:grid;gap:12px}
.oc-pills{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.oc-pill,.oc-pills>button{appearance:none;border:1px solid var(--oc-line);background:var(--oc-surface);color:var(--oc-fg);font:inherit;font-size:13px;line-height:1.2;padding:7px 13px;border-radius:999px;cursor:pointer;transition:background .15s,color .15s,border-color .15s}
.oc-pill:hover,.oc-pills>button:hover{background:var(--oc-hover)}
.oc-pill[aria-pressed=true],.oc-pill.is-active,.oc-pills>button[aria-pressed=true],.oc-pills>button.is-active{background:var(--oc-accent);border-color:var(--oc-accent);color:var(--oc-accent-fg)}
.oc-pill:focus-visible,.oc-pills>button:focus-visible,.oc-btn:focus-visible{outline:2px solid var(--oc-accent);outline-offset:2px}
.oc-stage{position:relative;border-radius:calc(var(--oc-radius) + 4px);background:radial-gradient(120% 90% at 50% 30%,var(--oc-surface),var(--oc-bg));overflow:hidden;touch-action:none}
.oc-caption{display:flex;justify-content:space-between;gap:4px 12px;flex-wrap:wrap;font-size:12px;color:var(--oc-muted)}
.oc-links{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:13px}
.oc-links a,a.oc-link{color:var(--oc-accent);text-decoration:none;cursor:pointer}
.oc-links a:hover,a.oc-link:hover{text-decoration:underline}
.oc-card{background:var(--oc-surface);border:1px solid var(--oc-line);border-radius:var(--oc-radius);box-shadow:0 1px 2px rgba(0,0,0,.04),0 10px 30px -14px rgba(0,0,0,.16)}
.oc-btn{appearance:none;border:0;border-radius:10px;padding:8px 14px;background:var(--oc-accent);color:var(--oc-accent-fg);font:inherit;font-size:14px;cursor:pointer}
.oc-muted{color:var(--oc-muted)}`;

/** 模型代码里静态出现这些写法才启用文件桥(动态拼出来的不算,父页也不会响应)。 */
export function usesFileBridge(code: string): boolean {
  return /data-oc-(?:src|download)\b|\bocFile\s*\(/.test(code);
}

/** 文件桥只给生成目录里的文件。 */
export function isBridgeablePath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    /^\/(?:home\/agent|root)\/\.openclaude\/generated\/[^\0]+$/.test(path) &&
    !path.split("/").includes("..")
  );
}

/** 文件桥单个文件的上限(超过就让用户下载)。 */
export const EMBED_FILE_MAX_BYTES = 40 * 1024 * 1024;

/** 带 canvas / WebGL 的内容:触屏上先点一下再操作(否则手指拖动会被画布吃掉,页面滚不动)。 */
export function isHeavyEmbed(code: string): boolean {
  return /<canvas\b|webgl|three(?:\.module)?(?:\.min)?\.js|from\s+["']three["']|THREE\./i.test(code);
}

/** 流式期间判断 HTML 是否已写完:有 </html> 收尾,或片段以闭合标签结尾且一段时间没再变(由调用方计时)。 */
export function looksComplete(code: string): boolean {
  return /<\/html>\s*$/i.test(code.trim());
}

/** 引导脚本(在 iframe 里跑)。token 只写在这份 srcdoc 里:iframe 被导航到别的页面后,新页面拿不到它。 */
function bootstrap(token: string, bridge: boolean): string {
  return `(function(){
var P=parent,T=${JSON.stringify(token)},last=-1,raf=0,seq=0,wait={};
function post(m){m.oc="embed";m.token=T;try{P.postMessage(m,"*")}catch(e){}}
function size(){raf=0;var d=document.documentElement,b=document.body;var h=Math.ceil(Math.max(d.scrollHeight,b?b.scrollHeight:0,d.getBoundingClientRect().height));if(h!==last){last=h;post({type:"size",h:h})}}
function q(){if(!raf)raf=requestAnimationFrame(size)}
function pw(root){var l=(root||document).querySelectorAll?(root||document).querySelectorAll("input[type=password]"):[];for(var i=0;i<l.length;i++){l[i].disabled=true;l[i].value="";l[i].placeholder="预览中不接受密码"}}
addEventListener("message",function(e){if(e.source!==P)return;var m=e.data;if(!m||m.oc!=="host"||m.token!==T)return;
if(m.type==="theme"){var r=document.documentElement;r.setAttribute("data-theme",m.dark?"dark":"light");for(var k in m.vars)r.style.setProperty(k,m.vars[k]);q()}
if(m.type==="file"&&wait[m.id]){var f=wait[m.id];delete wait[m.id];f(m)}});
${
  bridge
    ? `window.ocFile=function(p){return new Promise(function(res,rej){var id=++seq;wait[id]=function(m){m.ok?res(URL.createObjectURL(new Blob([m.buf],{type:m.mime||""}))):rej(new Error(m.error||"文件不可用"))};post({type:"file",id:id,path:String(p)})})};
function wire(root){var s=(root||document).querySelectorAll?(root||document).querySelectorAll("[data-oc-src]"):[];for(var i=0;i<s.length;i++){(function(el){if(el.__oc)return;el.__oc=1;ocFile(el.getAttribute("data-oc-src")).then(function(u){el.src=u;if(el.load)try{el.load()}catch(e){}},function(){el.setAttribute("data-oc-error","1")})})(s[i])}}
document.addEventListener("click",function(e){var a=e.target&&e.target.closest?e.target.closest("[data-oc-download]"):null;if(!a)return;e.preventDefault();post({type:"download",path:a.getAttribute("data-oc-download"),name:a.getAttribute("download")||""})});`
    : "function wire(){}"
}
function boot(){q();pw();wire();try{new ResizeObserver(q).observe(document.documentElement);if(document.body)new ResizeObserver(q).observe(document.body)}catch(e){}
try{new MutationObserver(function(r){for(var i=0;i<r.length;i++){for(var j=0;j<r[i].addedNodes.length;j++){var n=r[i].addedNodes[j];if(n.nodeType===1){pw(n.parentNode||n);wire(n.parentNode||n)}}}q()}).observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:["type"]})}catch(e){}
post({type:"ready"})}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot);else boot();
addEventListener("load",q);
})();`;
}

/** 注入物放进 <head> 开头(没有 head 就放在 <html> 后 / doctype 后 / 最前),保证在模型脚本之前生效、又不触发怪异模式。 */
export function wrapEmbedHtml(code: string, opts: { token: string; dark: boolean; vars: Record<string, string> }): string {
  const bridge = usesFileBridge(code);
  const vars = Object.entries(opts.vars)
    .map(([k, v]) => `${k}:${v.replace(/[;{}<>]/g, "")}`)
    .join(";");
  const inject =
    `<meta http-equiv="Content-Security-Policy" content="${embedCsp()}">` +
    `<meta name="color-scheme" content="${opts.dark ? "dark" : "light"}">` +
    `<style id="oc-kit">${EMBED_KIT_CSS}${vars ? `\n:root{${vars}}` : ""}</style>` +
    `<script>${bootstrap(opts.token, bridge)}</script>`;
  return injectHead(code, inject, opts.dark);
}

/** 把一段 head 内容放进文档开头:有 <head> 放它里面,没有就放在 <html> 后 / doctype 后 / 最前(不触发怪异模式)。 */
export function injectHead(code: string, inject: string, dark: boolean): string {
  const theme = dark ? "dark" : "light";
  const themed = (s: string) => s.replace(/<html(?=[\s>])/i, `<html data-theme="${theme}"`);
  const head = /<head(?:\s[^>]*)?>/i.exec(code);
  if (head) {
    const at = head.index + head[0].length;
    return themed(`${code.slice(0, at)}${inject}${code.slice(at)}`);
  }
  const html = /<html(?:\s[^>]*)?>/i.exec(code);
  if (html) {
    const at = html.index + html[0].length;
    return themed(`${code.slice(0, at)}<head>${inject}</head>${code.slice(at)}`);
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(code);
  if (doctype) return `${code.slice(0, doctype[0].length)}<head>${inject}</head>${code.slice(doctype[0].length)}`;
  return `<!DOCTYPE html><html data-theme="${theme}"><head>${inject}</head><body>${code}</body></html>`;
}

/** 只加 CSP(懒加载 chunk 未到 / 加载失败时的兜底预览用,不带样式套件和引导脚本)。 */
export function wrapWithCspOnly(code: string): string {
  return injectHead(code, `<meta http-equiv="Content-Security-Policy" content="${embedCsp()}">`, false);
}

/** 从 <title> 取下载文件名。 */
export function embedFileName(code: string): string {
  const t = /<title[^>]*>([^<]{1,80})<\/title>/i.exec(code)?.[1]?.trim();
  const base = (t || "interactive").replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "") || "interactive";
  return `${base}.html`;
}
