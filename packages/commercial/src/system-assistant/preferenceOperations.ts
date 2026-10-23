/** Real preference operations reuse the manual setting validators and atomic writer. */
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import {
  getVersionedPreferences, patchPreferences, PreferencesError, PreferencesPatchSchema,
  PreferencesSchema, resolvePreferencesPatch, type Preferences, type PreferencesPatch,
} from '../user/preferences.js'
import { type SystemActor, type SystemOperation, SystemOperationRejected } from './operations.js'

const LABELS: Readonly<Record<string, string>> = Object.freeze({
  theme: '界面主题', default_model: '默认模型', default_effort: '默认思考强度',
  notify_email: '邮件通知', notify_telegram: 'Telegram 通知', qq_proactive_push: 'QQ 主动通知',
  wechat_show_tool_calls: '微信工具过程', wechat_proactive_push: '微信主动通知',
  auto_dream_enabled: '后台记忆整理', auto_optimizer_enabled: '自进化与匿名平台发现上报',
  hotkeys: '快捷键', intelligent_ui: '交互式回答', input_prediction: '输入预测',
  disabled_plugins: '停用的插件', enabled_plugins: '启用的默认关闭插件',
  system_assistant_profile: '会话称呼授权', system_assistant_recommendations: '主动推荐',
})
const patchSchema = PreferencesPatchSchema.refine(p => Object.keys(p).length > 0, 'empty patch')
const readSchema = z.object({ keys: z.array(PreferencesSchema.keyof()).min(1).max(32).optional() }).strict()
const DEFAULT_KEYS = ['theme', 'default_model', 'default_effort', 'intelligent_ui', 'input_prediction', 'system_assistant_recommendations']
interface Snapshot { prefs: Preferences; updated_at: string; version: string }
export interface PreferenceOperationDeps {
  /** Fresh account status/role check; no ensure/account mutation. */
  authorize(actor: SystemActor): Promise<void>
  privacySupported(userId: string): Promise<boolean>
  /** True only after each background formal write also creates its own approved proposal. */
  backgroundApprovalReady?: (userId: string) => Promise<boolean>
  read?: (userId: string) => Promise<Snapshot>
  resolve?: (userId: string, raw: unknown) => Promise<PreferencesPatch>
  write?: (userId: string, patch: unknown, version: string, role: SystemActor['role']) => Promise<unknown>
}
function display(value: unknown): string {
  if (value === undefined) return '使用系统默认值'
  if (value === null) return '恢复系统默认值'
  if (typeof value === 'boolean') return value ? '开启' : '关闭'
  return typeof value === 'string' ? value : JSON.stringify(value)
}
async function translate<T>(work: () => Promise<T>): Promise<T> {
  try { return await work() } catch (e) {
    if (!(e instanceof PreferencesError)) throw e
    const code = e.code === 'VALIDATION' ? 'INVALID_INPUT' : e.code
    if (code === 'INTERNAL') throw e
    throw new SystemOperationRejected(code)
  }
}
export function preferenceOperations(deps: PreferenceOperationDeps): SystemOperation[] {
  const read = deps.read ?? getVersionedPreferences
  const resolve = deps.resolve ?? resolvePreferencesPatch
  const write = deps.write ?? patchPreferences
  async function validate(actor: SystemActor, raw: unknown): Promise<PreferencesPatch> {
    const normalized = await translate(() => resolve(actor.userId, raw))
    if ((normalized.auto_dream_enabled === true || normalized.auto_optimizer_enabled === true) &&
        !await deps.backgroundApprovalReady?.(actor.userId)) throw new SystemOperationRejected('UNAVAILABLE')
    const profile = (normalized as Record<string, unknown>).system_assistant_profile
    if (profile && typeof profile === 'object' && (profile as { enabled?: unknown }).enabled === true &&
        !await deps.privacySupported(actor.userId)) throw new SystemOperationRejected('CONFLICT')
    return normalized
  }
  const common = { version: 1, topic: 'preferences', executor: 'master' as const,
    roles: ['user', 'admin'] as const, authorize: deps.authorize }
  return [{
    ...common, id: 'preferences.read', title: '查看偏好设置', effect: 'read', schema: readSchema,
    input: { keys: { type: 'array', optional: true, values: Object.keys(PreferencesSchema.shape) } },
    read: async (actor, raw) => {
      const { keys } = raw as z.infer<typeof readSchema>
      const snapshot = await read(actor.userId)
      const wanted = keys ?? DEFAULT_KEYS
      return { prefs: Object.fromEntries(wanted.filter(k => k in snapshot.prefs).map(k => [k, snapshot.prefs[k as keyof Preferences]])), version: snapshot.version }
    },
  }, {
    ...common, id: 'preferences.update', title: '更改偏好设置', effect: 'write', schema: patchSchema, frozenSchema: patchSchema,
    input: { type: 'object', patch: Object.keys(PreferencesPatchSchema.shape), null: '恢复默认值' },
    prepare: async (actor, raw) => {
      const args = await validate(actor, raw)
      const snapshot = await read(actor.userId)
      const fields = Object.keys(args).sort()
      const consequences = ['仅修改列出的账号偏好；已有对话历史不会撤回。', '不会安装、授权插件，也不会替你发送通知。']
      if (fields.includes('default_model') || fields.includes('default_effort')) consequences.push('影响后续采用默认值的会话；模型用量按实际所选模型计费。')
      if (args.auto_dream_enabled === true) consequences.push('后台记忆整理可改动正式记忆并消耗模型额度；执行仍受套餐权限和平台可用性限制。')
      if (args.auto_optimizer_enabled === true) consequences.push('允许自进化审计并向平台上报匿名发现；后台任务可能消耗模型额度。')
      if (fields.includes('system_assistant_profile')) consequences.push('新授权只适用于指定会话；撤回后续注入不能删除模型已接收的历史内容。')
      return { args, expectedVersion: snapshot.version, resourceKey: `preferences:${actor.userId}`, preview: {
        title: '更改偏好设置', description: '请核对本次修改；状态变化会使这次审批失效。', scope: '本人账号偏好',
        before: fields.map(k => ({ label: LABELS[k] ?? k, value: display(snapshot.prefs[k as keyof Preferences]) })),
        after: fields.map(k => ({ label: LABELS[k] ?? k, value: display((args as Record<string, unknown>)[k]) })),
        consequences, destructive: false, price: { kind: 'none' as const, label: '保存设置不收费', note: '启用功能后的实际模型任务或第三方服务仍按原规则收费。' },
      } }
    },
    authorizeExecution: async (actor, execution) => {
      await deps.authorize(actor)
      const normalized = await validate(actor, execution.args)
      if (!execution.expectedVersion || !isDeepStrictEqual(normalized, execution.args)) throw new SystemOperationRejected('CONFLICT')
    },
    execute: async (actor, execution) => {
      if (!execution.expectedVersion) throw new SystemOperationRejected('CONFLICT')
      await translate(() => write(actor.userId, execution.args, execution.expectedVersion!, actor.role))
      return { summary: '偏好已保存。', completion: 'done' }
    },
  }]
}
