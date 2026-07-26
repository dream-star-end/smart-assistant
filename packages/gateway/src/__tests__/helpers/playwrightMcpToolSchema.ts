/**
 * `@playwright/mcp` 工具 inputSchema 的**钉版快照**(上游契约的本地权威副本)。
 *
 * 为什么需要它:oc-browser 的 CLI flag → wire 参数名是跨进程契约的一端,另一端在上游
 * MCP server 里。上游在版本升级时改过参数名(`ref` → `target`),我们没跟 → 每一次
 * `oc-browser click/type` 都被上游以 "Invalid arguments" 拒掉。2026-07-25 的 #230
 * 就是这个形态:agent 的每一次点击/输入都失败,浏览器任务全线做不下去。
 *
 * 上游包不是仓库依赖(镜像里全局装,`npx --no-install @playwright/mcp`),测试进程里
 * import 不到,所以这里存一份从**真实 0.0.76 服务端**抓下来的 schema 摘要。它的新鲜度
 * 由两道锁保证:
 *   1. `ocBrowserWireContract.test.ts` 断言镜像 Dockerfile 的 `OC_PLAYWRIGHT_MCP_VERSION`
 *      与下面的 `PINNED_VERSION` 一致 —— 升版必红,逼人重抓。
 *   2. 重抓命令写在下面,不需要考古。
 *
 * ── 重抓方式(升 @playwright/mcp 版本后必做)────────────────────────────────────
 *   node -e '
 *     const {Client}=require("@modelcontextprotocol/sdk/client/index.js");
 *     const {StdioClientTransport}=require("@modelcontextprotocol/sdk/client/stdio.js");
 *     (async()=>{const c=new Client({name:"probe",version:"0"},{capabilities:{}});
 *      await c.connect(new StdioClientTransport({command:"npx",
 *        args:["--no-install","@playwright/mcp","--headless","--caps","core"],env:process.env}));
 *      const {tools}=await c.listTools();
 *      for(const t of tools) console.log(JSON.stringify({name:t.name,
 *        required:t.inputSchema?.required??[],props:Object.keys(t.inputSchema?.properties??{})}));
 *      await c.close();})()'
 *
 * 抓取记录:2026-07-26,@playwright/mcp@0.0.76,`--headless --caps core`。
 */

/** 与镜像 Dockerfile 的 ARG OC_PLAYWRIGHT_MCP_VERSION 必须一致。 */
export const PINNED_VERSION = '0.0.76'

export interface UpstreamToolSchema {
  /** inputSchema.properties 的键集合。 */
  readonly props: readonly string[]
  /** inputSchema.required 声明。 */
  readonly required: readonly string[]
}

/** oc-browser 用到的那几个工具(全量工具表见 ALL_TOOL_NAMES)。 */
export const UPSTREAM_TOOL_SCHEMAS: Readonly<Record<string, UpstreamToolSchema>> = {
  browser_navigate: { props: ['url'], required: ['url'] },
  browser_snapshot: { props: ['target', 'filename', 'depth', 'boxes'], required: [] },
  browser_click: {
    props: ['element', 'target', 'doubleClick', 'button', 'modifiers'],
    required: ['target'],
  },
  browser_type: {
    props: ['element', 'target', 'text', 'submit', 'slowly'],
    required: ['target', 'text'],
  },
  browser_press_key: { props: ['key'], required: ['key'] },
  browser_take_screenshot: {
    props: ['element', 'target', 'type', 'filename', 'fullPage'],
    required: ['type'],
  },
  browser_wait_for: { props: ['time', 'text', 'textGone'], required: [] },
}

/** 0.0.76 `--caps core` 下 tools/list 返回的全部工具名(排序后)。 */
export const ALL_TOOL_NAMES: readonly string[] = [
  'browser_click',
  'browser_close',
  'browser_console_messages',
  'browser_drag',
  'browser_drop',
  'browser_evaluate',
  'browser_file_upload',
  'browser_fill_form',
  'browser_handle_dialog',
  'browser_hover',
  'browser_navigate',
  'browser_navigate_back',
  'browser_network_request',
  'browser_network_requests',
  'browser_press_key',
  'browser_resize',
  'browser_run_code_unsafe',
  'browser_select_option',
  'browser_snapshot',
  'browser_tabs',
  'browser_take_screenshot',
  'browser_type',
  'browser_wait_for',
]

/**
 * 上游 `required` 与"服务端真正强制的"之间的已知出入。
 *
 * 只允许放**实测确认过**的条目:声明 required 但服务端 zod 带默认值,不传也能成功。
 * 每条必须写清怎么验的 —— 否则它就成了绕过门的后门。
 */
export const REQUIRED_BUT_DEFAULTED: readonly {
  tool: string
  prop: string
  evidence: string
}[] = [
  {
    tool: 'browser_take_screenshot',
    prop: 'type',
    evidence:
      '2026-07-26 对 @playwright/mcp@0.0.76 实测:不带 type 调用 browser_take_screenshot ' +
      '返回 isError=undefined 并成功落图(生成的 Playwright 代码里 type 自动为 "png"),' +
      '说明服务端 zod 对该字段带默认值,advertised required 并未强制。',
  },
]
