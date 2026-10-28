/**
 * 浏览器操作的完整解析(OCV5-374,只在懒加载块里用):oc-browser(Bash 调 playwright-cli)和
 * MCP browser_* 两条路,归一成「动作序列 + 页面 + 截图」。工具卡正文、详情面板的浏览器页、产出页都只读
 * 这里;首屏只需要的「是不是浏览器操作」在 browserDetect.ts,动作表与命令识别和这里同源。
 *
 * 截图路径:playwright-cli 的输出写相对路径 `.playwright-cli/page-….png`,相对的是
 * oc-browser.sh 先 `cd` 进去的 OPENCLAUDE_HOME(容器里固定 /home/agent/.openclaude)。
 * 旧代码用 `/\/…\.png/` 从相对路径里抠出 `/page-….png` 当容器文件:缩略图是坏图,折叠规则还把这一步
 * 当成「交付的图片」留在处理过程外面。
 */
import { OC_BROWSER_CALL_RE, browserToolShape, isBrowserStepMessage } from "./browserDetect";
import type { ToolLike } from "./format";
import { asStr } from "./format";
import { parseMcpName } from "./meta";
import { resolveToolStatus } from "./status";

/** oc-browser.sh 里 playwright-cli 的工作目录(OPENCLAUDE_HOME 的容器默认值)。 */
export const BROWSER_HOME = "/home/agent/.openclaude";
/** 平台交付目录:存到这里的截图是要给用户的产物,其余截图是代理自己核对用的过程证据。 */
export const DELIVERABLE_PREFIX = "/home/agent/.openclaude/generated/";

export type BrowserAction = { verb: string; label: string; detail: string };

export type BrowserStep = {
  actions: BrowserAction[];
  /** 打开的地址,或输出里最后一个 Page URL。 */
  url: string;
  /** 输出里最后一个 Page Title。 */
  title: string;
  /** 输出里证实存在的截图:容器绝对路径(按出现顺序、去重)。 */
  shots: string[];
  /** 命令 / 参数要求存到的位置(`--filename`);输出没给路径时卡片用它,折叠规则不认它。 */
  requestedShots: string[];
  /** 取过页面结构(snapshot)。 */
  snapshot: boolean;
  /** 失败的首个 Error 行;成功为空串。 */
  error: string;
  running: boolean;
  /** 原始输出(错误详情 / 页面快照折叠用)。 */
  output: string;
};

/** 已登记的 oc-browser 动作(browser 技能文档 + 实际出现过的 resize / type 等)。 */
const VERB_LABELS = {
  open: "打开网页",
  goto: "打开网页",
  "tab-new": "新标签页",
  "tab-list": "查看标签页",
  "tab-select": "切换标签页",
  "tab-close": "关闭标签页",
  snapshot: "读取页面",
  find: "查找元素",
  click: "点击",
  dblclick: "双击",
  hover: "悬停",
  fill: "填写",
  type: "输入文本",
  press: "按键",
  select: "选择选项",
  check: "勾选",
  uncheck: "取消勾选",
  upload: "上传文件",
  drag: "拖拽",
  screenshot: "截图",
  resize: "调整窗口",
  eval: "执行脚本",
  "run-code": "执行代码",
  "go-back": "返回上一页",
  "go-forward": "前进",
  reload: "刷新网页",
  "state-save": "保存登录状态",
  close: "关闭浏览器",
} as const satisfies Record<string, string>;
type OcBrowserVerb = keyof typeof VERB_LABELS;
const isVerb = (v: string): v is OcBrowserVerb => Object.prototype.hasOwnProperty.call(VERB_LABELS, v);

const MCP_OPS: Record<string, OcBrowserVerb> = {
  browser_navigate: "goto",
  browser_navigate_back: "go-back",
  browser_take_screenshot: "screenshot",
  browser_snapshot: "snapshot",
  browser_click: "click",
  browser_type: "type",
  browser_fill_form: "fill",
  browser_press_key: "press",
  browser_select_option: "select",
  browser_hover: "hover",
  browser_drag: "drag",
  browser_file_upload: "upload",
  browser_evaluate: "eval",
  browser_run_code: "run-code",
  browser_resize: "resize",
  browser_close: "close",
  browser_tabs: "tab-list",
};

const NAV_VERBS = new Set(["open", "goto", "tab-new"]);
const IMAGE_EXT = /\.(?:png|jpe?g|webp)$/i;

/** 一个截图位置 → 容器绝对路径;相对路径按 BROWSER_HOME 解析。拒绝 `..`、协议、控制字符。 */
export function resolveBrowserPath(raw: string): string | null {
  const value = raw.trim().replace(/^["'`<(]+|["'`>),.;:]+$/g, "");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-char screen (same as mediaSign.isContainerPathAllowed)
  if (!value || value.includes("..") || /[\0-\x1f\x7f]/.test(value)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//") || value.startsWith("~")) return null;
  if (!IMAGE_EXT.test(value)) return null;
  if (value.startsWith("/")) return value;
  return `${BROWSER_HOME}/${value.replace(/^\.\//, "")}`;
}

/**
 * 输出里的截图:markdown 链接 `[Screenshot …](path)`、`Saved … path` 这类整段路径。
 * 只认图片扩展名;相对路径(`.playwright-cli/…`)按 BROWSER_HOME 解析,不再截半段。
 */
export function browserShotPaths(text: string): string[] {
  const found: string[] = [];
  const push = (raw: string | undefined) => {
    const path = raw ? resolveBrowserPath(raw) : null;
    if (path && !found.includes(path)) found.push(path);
  };
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) push(m[1]);
  // 链接之外的路径必须以空白 / 行首 / 引号开头,`foo/page.png` 的后半段不会被当成绝对路径。
  for (const m of text.matchAll(/(?:^|[\s"'`=])((?:\/|\.playwright-cli\/)[^\s"'`<>()]+)/gm)) push(m[1]);
  return found;
}

function lastMatch(text: string, re: RegExp): string {
  let value = "";
  for (const m of text.matchAll(re)) value = (m[1] ?? "").trim();
  return value;
}

function firstErrorLine(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const hit = lines.find((l) => l && !/^#{1,6}\s/.test(l) && /\berror\b/i.test(l));
  return hit ?? lines.find((l) => l && !/^#{1,6}\s/.test(l)) ?? "";
}

function cliArgs(command: string, start: number): string[] {
  const tail = command.slice(start);
  const end = tail.search(/[\n;&|]/);
  const segment = end < 0 ? tail : tail.slice(0, end);
  const tokens = [...segment.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((t) => ({ text: t[1] ?? t[2] ?? t[3] ?? "", bare: !!t[3] }));
  // 去掉 shell 重定向(`2>&1`、`>/dev/null`、`> out.txt`):它们不是动作参数,`2>` 曾被当成元素显示。
  const args: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    if (t.bare && /^\d*[<>]/.test(t.text)) {
      if (/^\d*[<>]+$/.test(t.text)) i++;
      continue;
    }
    args.push(t.text);
  }
  return args;
}

function actionDetail(verb: string, args: string[]): string {
  const plain = args.filter((a) => !a.startsWith("--"));
  if (NAV_VERBS.has(verb)) return plain[0] ?? "";
  if (verb === "fill") return plain[1] ? `${plain[0] ?? ""} ← ${plain[1]}` : (plain[0] ?? "");
  if (verb === "resize") return plain.length >= 2 ? `${plain[0]}×${plain[1]}` : "";
  if (verb === "eval" || verb === "run-code") return "";
  return plain[0] ?? "";
}

/** 命令位置的每个已登记 `oc-browser <verb>`,带上它的参数详情。 */
function cliActions(command: string): BrowserAction[] {
  const actions: BrowserAction[] = [];
  for (const m of command.matchAll(OC_BROWSER_CALL_RE)) {
    const verb = (m[1] ?? "").toLowerCase();
    if (!isVerb(verb)) continue;
    const end = (m.index ?? 0) + m[0].length;
    actions.push({ verb, label: VERB_LABELS[verb], detail: actionDetail(verb, cliArgs(command, end)) });
  }
  return actions;
}

function cliFilenames(command: string): string[] {
  const names: string[] = [];
  for (const m of command.matchAll(/--filename(?:=|\s+)("[^"]+"|'[^']+'|\S+)/g)) {
    const path = resolveBrowserPath((m[1] ?? "").replace(/^["']|["']$/g, ""));
    if (path) names.push(path);
  }
  return names;
}

function mcpDetail(verb: string, input: Record<string, unknown> | null): string {
  if (!input) return "";
  if (NAV_VERBS.has(verb)) return asStr(input.url);
  if (verb === "resize") return input.width && input.height ? `${input.width}×${input.height}` : "";
  if (verb === "eval" || verb === "run-code") return "";
  const target = asStr(input.element) || asStr(input.ref);
  const text = asStr(input.text) || asStr(input.key);
  return target && text ? `${target} ← ${text}` : target || text;
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/**
 * 一条工具行 → 浏览器步骤;不是浏览器操作返回 null。
 * `command`:调用方已拿到的 Bash 命令(工具卡分派处),行里没有输入时用它。
 */
export function browserStepOf(message: ToolLike, command?: string): BrowserStep | null {
  if (!isBrowserStepMessage(message, command)) return null;
  const { name, input, tool, shell } = browserToolShape(message, command);
  const output = [textOf(tool.output), message.bashTail?.tail ?? ""].filter(Boolean).join("\n");
  const status = resolveToolStatus({ name, tool });
  const failed = status.kind === "error" || /^(?:#{1,6}\s*)?Error\b/im.test(output);
  const mcp = parseMcpName(name);
  let actions: BrowserAction[];
  let requested: string[] = [];
  if (mcp) {
    const verb = MCP_OPS[mcp.op];
    actions = verb ? [{ verb, label: VERB_LABELS[verb], detail: mcpDetail(verb, input) }] : [];
    const filename = asStr(input?.filename) || asStr(input?.path);
    const resolved = filename ? resolveBrowserPath(filename) : null;
    if (resolved) requested = [resolved];
  } else {
    actions = cliActions(shell);
    requested = cliFilenames(shell);
  }
  const nav = actions.find((a) => NAV_VERBS.has(a.verb));
  const pageUrl = lastMatch(output, /^\s*-?\s*Page URL:\s*(\S+)/gim);
  const tookShot = actions.some((a) => a.verb === "screenshot");
  const shots = failed || !tookShot ? [] : browserShotPaths(output);
  return {
    actions,
    url: pageUrl || nav?.detail || "",
    title: failed ? "" : lastMatch(output, /^\s*-?\s*Page Title:\s*(.+)$/gim),
    shots,
    requestedShots: failed || !tookShot ? [] : requested.filter((p) => !shots.includes(p)),
    snapshot: actions.some((a) => a.verb === "snapshot"),
    error: failed ? firstErrorLine(output) : "",
    running: status.kind === "running",
    output,
  };
}

/** 截图是交付物(存进平台交付目录)而不是过程证据。 */
export function isDeliverableShot(path: string): boolean {
  return path.startsWith(DELIVERABLE_PREFIX);
}

/** 地址栏显示:主机 + 路径(去掉协议、`www.`、末尾斜杠);解析不了按原样截断。 */
export function displayAddress(url: string): { host: string; path: string } {
  // 浏览器刚打开、还没导航时停在 about:blank:解析出来 host 为空、路径是 "blank",地址栏和操作记录都写成「blank」。
  if (url.trim().toLowerCase() === "about:blank") return { host: "空白页", path: "" };
  try {
    const u = new URL(url);
    const path = `${u.pathname === "/" ? "" : u.pathname}${u.search}`;
    return { host: u.host.replace(/^www\./, ""), path };
  } catch {
    return { host: url.slice(0, 80), path: "" };
  }
}

export type BrowserTurnStep = { message: ToolLike & { id?: string; ts?: number }; step: BrowserStep };

/** 一轮里的浏览器操作(按出现顺序)。详情面板的「浏览器」页和它的开关只看这里。 */
export function collectBrowserSteps(rows: readonly (ToolLike & { id?: string; role?: string; ts?: number })[]): BrowserTurnStep[] {
  const out: BrowserTurnStep[] = [];
  for (const message of rows) {
    if (message.role !== undefined && message.role !== "tool") continue;
    const step = browserStepOf(message);
    if (step) out.push({ message, step });
  }
  return out;
}
