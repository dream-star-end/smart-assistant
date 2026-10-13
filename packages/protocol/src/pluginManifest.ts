/**
 * 插件清单 `plugin.json`（schema `openclaude-plugin/1`，OCV5-383）。
 *
 * 一个插件 = 一个目录 + 根目录的 plugin.json。清单把「这个插件由什么组成、要什么权限、怎么登录」
 * 写在一处，取代过去分散在 ConnectorSpec / SecurityDecision / 发布封套 / blueprint / 运行时工件里的
 * 多套写法（问题清单见 docs/plugin-authoring.md 与 OCV5-383 FINDINGS）。
 *
 * 本版真正接通的组件：skills（SKILL.md）、bin（容器内命令，经平台启动器上 PATH）、data（随包数据）、
 * ui（插件专属的 Intelligent UI 组件，OCV5-393：定义只在加载插件时进上下文，见 pluginUi.ts）。
 * http（声明式 API）与 browser（受管浏览器）先在 schema 里占位：写了会得到明确的「暂不支持」错误，
 * 仍走现有发布流程。
 *
 * 校验原则：一次收集全部问题；每条带字段路径与「怎么改」；只拒不改（不悄悄截断、不丢字段）。
 * 纯函数、零依赖：master、容器启动器的单测、前端都可以用同一份。
 */
import { isMarketplaceCategoryId } from './marketplaceTaxonomy.js'

export const PLUGIN_MANIFEST_SCHEMA = 'openclaude-plugin/1'
export const PLUGIN_MANIFEST_FILE = 'plugin.json'
export const PLUGIN_MANIFEST_MAX_BYTES = 64 * 1024

/** 插件名 = 唯一的 slug（也是 bin 命令名的默认值）：小写字母开头，小写字母 / 数字 / 连字符，2–64 位。 */
export const PLUGIN_NAME_RE = /^[a-z][a-z0-9-]{1,63}$/
const BIN_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const ORIGIN_RE = /^https?:\/\/(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d{1,5})?$/
/** 包内相对路径：不以 / 开头，不含 .. 段、反斜杠、空段。 */
const REL_PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\/\/)[A-Za-z0-9._\-/]+$/
/** 组件类型名：小写字母开头，小写字母 / 数字 / 下划线（与前端 IUI_TYPES 同形）。 */
const UI_TYPE_RE = /^[a-z][a-z0-9_]{1,31}$/

export const PLUGIN_INTERPRETERS = ['python3'] as const
export type PluginInterpreter = (typeof PLUGIN_INTERPRETERS)[number]
export const PLUGIN_AUTH_MODES = ['none', 'static-token', 'oauth2-auth-code', 'token-exchange', 'browser-session'] as const
export type PluginAuthMode = (typeof PLUGIN_AUTH_MODES)[number]
export const PLUGIN_LOGIN_KINDS = ['sms-code', 'qr-scan', 'credentials', 'oauth'] as const
export const PLUGIN_USER_INTERACTIONS = ['sms-code', 'qr-scan', 'confirm-each-write'] as const

export type PluginManifest = {
  schema: typeof PLUGIN_MANIFEST_SCHEMA
  name: string
  version: string
  displayName: string
  description: string
  author: { name: string; url?: string }
  license?: string
  homepage?: string
  category?: string
  tags: string[]
  useCases: string[]
  components: {
    skills: { path: string }[]
    bin: { name: string; entry: string; interpreter: PluginInterpreter; description?: string }[]
    data: { path: string; description?: string }[]
    /**
     * 插件专属组件（OCV5-393）。`path`：定义文件（references/ui-<名字>.md，模型按它写组件，只在用到插件时读）；
     * `emit: "cli"`：组件由插件命令直接打印，模型原样转贴，不需要定义文件。二者必须且只能写一个。
     */
    ui: ({ types: string[]; path: string } | { types: string[]; emit: 'cli' })[]
  }
  auth: {
    mode: PluginAuthMode
    login?: { optional: boolean; kind: (typeof PLUGIN_LOGIN_KINDS)[number]; description: string; start?: string }
  }
  permissions: {
    network: string[]
    writes: { id: string; description: string }[]
    userInteraction: (typeof PLUGIN_USER_INTERACTIONS)[number][]
  }
  disclaimer?: { version: number; text: string }
  compat?: { python?: string }
}

export type PluginManifestIssue = { path: string; message: string }
export type PluginManifestResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; errors: PluginManifestIssue[] }

const TOP_KEYS = new Set([
  'schema',
  'name',
  'version',
  'displayName',
  'description',
  'author',
  'license',
  'homepage',
  'category',
  'tags',
  'useCases',
  'components',
  'auth',
  'permissions',
  'disclaimer',
  'compat',
])

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

class Collector {
  errors: PluginManifestIssue[] = []
  add(path: string, message: string): void {
    this.errors.push({ path, message })
  }
  /** 必填字符串，长度 [min, max]。 */
  str(o: Obj, key: string, path: string, min: number, max: number, required = true): string | undefined {
    const v = o[key]
    if (v === undefined) {
      if (required) this.add(path, `缺少必填字段（字符串，${min}–${max} 字）`)
      return undefined
    }
    if (typeof v !== 'string') {
      this.add(path, `应为字符串，现在是 ${typeName(v)}`)
      return undefined
    }
    const t = v.trim()
    if (t.length < min || t.length > max) {
      this.add(path, `长度应为 ${min}–${max} 字，现在 ${t.length} 字`)
      return undefined
    }
    return t
  }
  /** 只认识列出的键：多写的键报错（拼错的字段不会被悄悄忽略）。 */
  keys(o: Obj, allowed: readonly string[], path: string): void {
    for (const k of Object.keys(o)) {
      if (!allowed.includes(k)) this.add(path ? `${path}.${k}` : k, `不认识的字段；允许的字段：${allowed.join('、')}`)
    }
  }
  arr(o: Obj, key: string, path: string, max: number): unknown[] {
    const v = o[key]
    if (v === undefined) return []
    if (!Array.isArray(v)) {
      this.add(path, `应为数组，现在是 ${typeName(v)}`)
      return []
    }
    if (v.length > max) this.add(path, `最多 ${max} 项，现在 ${v.length} 项`)
    return v.slice(0, max)
  }
  strList(o: Obj, key: string, path: string, max: number, itemMin: number, itemMax: number): string[] {
    const out: string[] = []
    this.arr(o, key, path, max).forEach((v, i) => {
      if (typeof v !== 'string' || v.trim().length < itemMin || v.trim().length > itemMax) {
        this.add(`${path}[${i}]`, `应为 ${itemMin}–${itemMax} 字的字符串`)
      } else out.push(v.trim())
    })
    return out
  }
}

function typeName(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return '数组'
  return { string: '字符串', number: '数字', boolean: '布尔值', object: '对象' }[typeof v as string] ?? typeof v
}

function relPath(c: Collector, v: unknown, path: string, prefix?: string): string | undefined {
  if (typeof v !== 'string' || !REL_PATH_RE.test(v)) {
    c.add(path, '应为插件目录内的相对路径（不以 / 开头，不含 ..），如 "scripts/main.py"')
    return undefined
  }
  if (prefix && !v.startsWith(prefix)) {
    c.add(path, `必须放在 ${prefix} 目录下`)
    return undefined
  }
  return v
}

/** 校验并规范化 plugin.json（已 JSON.parse 的值）。 */
export function parsePluginManifest(raw: unknown): PluginManifestResult {
  const c = new Collector()
  if (!isObj(raw)) return { ok: false, errors: [{ path: '', message: 'plugin.json 顶层应为 JSON 对象' }] }
  for (const k of Object.keys(raw)) if (!TOP_KEYS.has(k)) c.add(k, `不认识的字段；顶层允许：${[...TOP_KEYS].join('、')}`)

  if (raw.schema !== PLUGIN_MANIFEST_SCHEMA) c.add('schema', `应为 "${PLUGIN_MANIFEST_SCHEMA}"`)
  const name = c.str(raw, 'name', 'name', 2, 64)
  if (name && !PLUGIN_NAME_RE.test(name)) c.add('name', '只能用小写字母、数字和连字符，且以字母开头，如 "ths" 或 "my-plugin"')
  const version = c.str(raw, 'version', 'version', 5, 32)
  if (version && !SEMVER_RE.test(version)) c.add('version', '应为语义化版本 N.N.N，如 "1.0.0"')
  const displayName = c.str(raw, 'displayName', 'displayName', 1, 40)
  const description = c.str(raw, 'description', 'description', 10, 400)

  let author: PluginManifest['author'] | undefined
  if (!isObj(raw.author)) c.add('author', '缺少作者：{"name": "…", "url": "…"（可选）}')
  else {
    c.keys(raw.author, ['name', 'url'], 'author')
    const n = c.str(raw.author, 'name', 'author.name', 1, 80)
    const u = c.str(raw.author, 'url', 'author.url', 8, 300, false)
    if (u && !/^https:\/\//.test(u)) c.add('author.url', '应为 https:// 链接')
    if (n) author = { name: n, ...(u ? { url: u } : {}) }
  }
  const license = c.str(raw, 'license', 'license', 2, 40, false)
  const homepage = c.str(raw, 'homepage', 'homepage', 8, 300, false)
  if (homepage && !/^https:\/\//.test(homepage)) c.add('homepage', '应为 https:// 链接')
  const category = c.str(raw, 'category', 'category', 2, 40, false)
  if (category && !isMarketplaceCategoryId(category)) c.add('category', 'AI 市场分类 id 不存在（如 finance-business、daily-tools、coding-dev）')
  const tags = c.strList(raw, 'tags', 'tags', 8, 1, 20)
  const useCases = c.strList(raw, 'useCases', 'useCases', 4, 4, 120)

  // components
  const components: PluginManifest['components'] = { skills: [], bin: [], data: [], ui: [] }
  if (!isObj(raw.components)) c.add('components', '缺少组成：至少要有 skills 或 bin')
  else {
    const comp = raw.components
    for (const k of ['http', 'browser']) {
      if (k in comp) c.add(`components.${k}`, `${k} 组件在 openclaude-plugin/1 里暂不支持；API / 浏览器插件请先用 AI 市场「发布插件」流程`)
    }
    c.keys(comp, ['skills', 'bin', 'data', 'ui', 'http', 'browser'], 'components')
    c.arr(comp, 'skills', 'components.skills', 8).forEach((s, i) => {
      const p = `components.skills[${i}]`
      if (!isObj(s)) return c.add(p, '应为 {"path": "SKILL.md"}')
      c.keys(s, ['path'], p)
      const path = relPath(c, s.path, `${p}.path`)
      if (path && !/(^|\/)SKILL\.md$/.test(path)) c.add(`${p}.path`, '应指向一个 SKILL.md 文件')
      if (path) components.skills.push({ path })
    })
    const binNames = new Set<string>()
    c.arr(comp, 'bin', 'components.bin', 8).forEach((b, i) => {
      const p = `components.bin[${i}]`
      if (!isObj(b)) return c.add(p, '应为 {"name", "entry", "interpreter"}')
      c.keys(b, ['name', 'entry', 'interpreter', 'description'], p)
      const bn = c.str(b, 'name', `${p}.name`, 1, 32)
      if (bn && !BIN_NAME_RE.test(bn)) c.add(`${p}.name`, '命令名只能用小写字母、数字和连字符，且以字母开头')
      if (bn && binNames.has(bn)) c.add(`${p}.name`, `命令名 ${bn} 重复`)
      if (bn) binNames.add(bn)
      const entry = relPath(c, b.entry, `${p}.entry`, 'scripts/')
      const interp = b.interpreter
      if (!(PLUGIN_INTERPRETERS as readonly unknown[]).includes(interp))
        c.add(`${p}.interpreter`, `解释器只支持：${PLUGIN_INTERPRETERS.join('、')}`)
      const desc = c.str(b, 'description', `${p}.description`, 2, 200, false)
      if (bn && entry && (PLUGIN_INTERPRETERS as readonly unknown[]).includes(interp))
        components.bin.push({ name: bn, entry, interpreter: interp as PluginInterpreter, ...(desc ? { description: desc } : {}) })
    })
    c.arr(comp, 'data', 'components.data', 16).forEach((d, i) => {
      const p = `components.data[${i}]`
      if (!isObj(d)) return c.add(p, '应为 {"path": "references/…"}')
      c.keys(d, ['path', 'description'], p)
      const path = relPath(c, d.path, `${p}.path`, 'references/')
      const desc = c.str(d, 'description', `${p}.description`, 2, 200, false)
      if (path) components.data.push({ path, ...(desc ? { description: desc } : {}) })
    })
    const uiTypes = new Set<string>()
    c.arr(comp, 'ui', 'components.ui', 4).forEach((u, i) => {
      const p = `components.ui[${i}]`
      if (!isObj(u)) return c.add(p, '应为 {"types": [...], "path": "references/ui-<插件>.md"} 或 {"types": [...], "emit": "cli"}')
      c.keys(u, ['types', 'path', 'emit'], p)
      const types: string[] = []
      if (!Array.isArray(u.types) || u.types.length === 0 || u.types.length > 16) c.add(`${p}.types`, '应为 1–16 个组件类型名')
      else
        u.types.forEach((t, j) => {
          if (typeof t !== 'string' || !UI_TYPE_RE.test(t)) return c.add(`${p}.types[${j}]`, '类型名只能用小写字母、数字和下划线，以字母开头，2–32 位')
          if (uiTypes.has(t)) return c.add(`${p}.types[${j}]`, `组件类型 ${t} 重复`)
          uiTypes.add(t)
          types.push(t)
        })
      const hasPath = u.path !== undefined
      const hasEmit = u.emit !== undefined
      if (hasPath === hasEmit) return c.add(p, '必须且只能写 path（定义文件）或 "emit": "cli"（由插件命令打印）之一')
      if (hasEmit) {
        if (u.emit !== 'cli') return c.add(`${p}.emit`, '只支持 "cli"')
        if (types.length > 0) components.ui.push({ types, emit: 'cli' })
        return
      }
      const path = relPath(c, u.path, `${p}.path`, 'references/')
      // 定义文件不能是 SKILL.md：SKILL.md 在加载技能时整份进上下文，定义要等真正展示这个插件的结果时才读。
      if (path && !/^references\/ui-[a-z0-9-]+\.md$/.test(path)) c.add(`${p}.path`, '定义文件应为 references/ui-<名字>.md')
      else if (path && types.length > 0) components.ui.push({ types, path })
    })
    if (components.skills.length === 0 && components.bin.length === 0 && isObj(raw.components))
      c.add('components', '至少要有一个 skills 或 bin 组件')
  }

  // auth
  let auth: PluginManifest['auth'] = { mode: 'none' }
  if (raw.auth !== undefined) {
    if (!isObj(raw.auth)) c.add('auth', '应为对象，如 {"mode": "none"}')
    else {
      c.keys(raw.auth, ['mode', 'login'], 'auth')
      const mode = raw.auth.mode
      if (!(PLUGIN_AUTH_MODES as readonly unknown[]).includes(mode)) c.add('auth.mode', `应为：${PLUGIN_AUTH_MODES.join('、')}`)
      else auth = { mode: mode as PluginAuthMode }
      if (raw.auth.login !== undefined) {
        const l = raw.auth.login
        if (!isObj(l)) c.add('auth.login', '应为对象')
        else {
          c.keys(l, ['optional', 'kind', 'description', 'start'], 'auth.login')
          if (!(PLUGIN_LOGIN_KINDS as readonly unknown[]).includes(l.kind)) c.add('auth.login.kind', `应为：${PLUGIN_LOGIN_KINDS.join('、')}`)
          const ld = c.str(l, 'description', 'auth.login.description', 4, 300)
          const start = c.str(l, 'start', 'auth.login.start', 2, 120, false)
          if (typeof l.optional !== 'boolean') c.add('auth.login.optional', '应为 true（可选登录）或 false（必须登录才能用）')
          if (ld && typeof l.optional === 'boolean' && (PLUGIN_LOGIN_KINDS as readonly unknown[]).includes(l.kind))
            auth.login = {
              optional: l.optional,
              kind: l.kind as (typeof PLUGIN_LOGIN_KINDS)[number],
              description: ld,
              ...(start ? { start } : {}),
            }
        }
      }
    }
  }

  // permissions
  const permissions: PluginManifest['permissions'] = { network: [], writes: [], userInteraction: [] }
  if (!isObj(raw.permissions)) c.add('permissions', '缺少权限声明：至少写 {"network": [...]}（不访问网络就写空数组）')
  else {
    const pm = raw.permissions
    c.keys(pm, ['network', 'writes', 'userInteraction'], 'permissions')
    if (!Array.isArray(pm.network)) c.add('permissions.network', '应为来源数组，如 ["https://api.example.com"]；不访问网络写 []')
    c.arr(pm, 'network', 'permissions.network', 32).forEach((o, i) => {
      if (typeof o !== 'string' || !ORIGIN_RE.test(o)) c.add(`permissions.network[${i}]`, '应为不带路径的来源，如 "https://api.example.com"（子域可写 https://*.example.com）')
      else permissions.network.push(o)
    })
    c.arr(pm, 'writes', 'permissions.writes', 32).forEach((w, i) => {
      const p = `permissions.writes[${i}]`
      if (!isObj(w)) return c.add(p, '应为 {"id", "description"}')
      c.keys(w, ['id', 'description'], p)
      const id = c.str(w, 'id', `${p}.id`, 2, 64)
      const d = c.str(w, 'description', `${p}.description`, 4, 200)
      if (id && d) permissions.writes.push({ id, description: d })
    })
    c.arr(pm, 'userInteraction', 'permissions.userInteraction', 8).forEach((u, i) => {
      if (!(PLUGIN_USER_INTERACTIONS as readonly unknown[]).includes(u))
        c.add(`permissions.userInteraction[${i}]`, `应为：${PLUGIN_USER_INTERACTIONS.join('、')}`)
      else permissions.userInteraction.push(u as (typeof PLUGIN_USER_INTERACTIONS)[number])
    })
  }

  let disclaimer: PluginManifest['disclaimer']
  if (raw.disclaimer !== undefined) {
    if (!isObj(raw.disclaimer)) c.add('disclaimer', '应为 {"version": 1, "text": "…"}')
    else {
      c.keys(raw.disclaimer, ['version', 'text'], 'disclaimer')
      const v = raw.disclaimer.version
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) c.add('disclaimer.version', '应为正整数；改了声明文字就加 1')
      const t = c.str(raw.disclaimer, 'text', 'disclaimer.text', 10, 2000)
      if (t && typeof v === 'number' && Number.isInteger(v) && v >= 1) disclaimer = { version: v, text: t }
    }
  }
  let compat: PluginManifest['compat']
  if (raw.compat !== undefined) {
    if (!isObj(raw.compat)) c.add('compat', '应为对象，如 {"python": ">=3.8"}')
    else {
      c.keys(raw.compat, ['python'], 'compat')
      const py = c.str(raw.compat, 'python', 'compat.python', 3, 20, false)
      if (py && !/^>=\d+\.\d+$/.test(py)) c.add('compat.python', '写成 ">=3.8" 这样的最低版本')
      if (py) compat = { python: py }
    }
  }
  if (components.bin.length > 0 && !compat?.python && components.bin.some((b) => b.interpreter === 'python3'))
    c.add('compat.python', '用了 python3 解释器时要写最低版本，如 {"python": ">=3.8"}')

  if (c.errors.length > 0 || !name || !version || !displayName || !description || !author) return { ok: false, errors: c.errors }
  return {
    ok: true,
    manifest: {
      schema: PLUGIN_MANIFEST_SCHEMA,
      name,
      version,
      displayName,
      description,
      author,
      ...(license ? { license } : {}),
      ...(homepage ? { homepage } : {}),
      ...(category ? { category } : {}),
      tags,
      useCases,
      components,
      auth,
      permissions,
      ...(disclaimer ? { disclaimer } : {}),
      ...(compat ? { compat } : {}),
    },
  }
}

/** 把错误列表排成给作者看的几行文字（CLI / 日志 / 发布反馈共用）。 */
export function formatPluginManifestErrors(errors: readonly PluginManifestIssue[]): string {
  return errors.map((e) => `- ${e.path || '(顶层)'}：${e.message}`).join('\n')
}
