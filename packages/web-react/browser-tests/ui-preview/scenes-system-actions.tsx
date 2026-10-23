/** Native IUI design fixtures only. No login, product API, or real settings mutation. */
import type { SystemActionDetail } from '@openclaude/protocol/browser'
import { useEffect, useMemo } from 'react'
import { IuiBlock } from '../../src/components/iui/IuiBlock'
import { ChatInteractionContext, ToolCardActionsContext, type SystemActionCardActions } from '../../src/components/tool/context'
import type { Scene } from './types'
const id = 'b5be0795-e604-45ee-bd8b-a519324b5cf4'
const reference = JSON.stringify({ type: 'system_action', proposalId: id })
function fixture(state: SystemActionDetail['state'] = 'prepared'): SystemActionDetail {
  return { id, operationId: 'models.session.set', title: '切换当前会话模型', state, executor: 'browser',
    createdAt: Date.now(), updatedAt: Date.now(), expiresAt: Date.now() + 300000, previewHash: 'design-preview-hash', result: null,
    preview: { title: '切换当前会话的模型？', description: '为日常笔记整理尝试轻量模型。', scope: '仅当前会话，下一条消息起生效',
      before: [{ label: '当前模型', value: '通用模型（示例）' }], after: [{ label: '目标模型', value: '轻量模型（示例）' }],
      consequences: ['进行中的回答保持原模型。', '默认模型不变，可随时重新选择。'],
      price: { kind: 'usage', label: '按目标模型价格计费（示例）', rates: [{ label: '输入 / 输出 / 缓存', value: '确认时读取本人实时目录' }], note: '本场景全部数据为设计示例，不进行模型请求。' }, destructive: false } }
}
function ClickConfirmation() {
  useEffect(() => {
    const timer = setInterval(() => {
      const button = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === '查看并确认' && !b.disabled)
      if (button) { button.click(); clearInterval(timer) }
    }, 50)
    return () => clearInterval(timer)
  }, [])
  return null
}
function Study({ confirm = false, state = 'prepared', readOnly = false }: { confirm?: boolean; state?: SystemActionDetail['state']; readOnly?: boolean }) {
  const actions = useMemo<SystemActionCardActions>(() => {
    const proof = { confirmations: 0, challenges: 0, reads: 0 }
    ;(window as unknown as { __systemActionProof: typeof proof }).__systemActionProof = proof
    return { identityKey: 'native-design-fixture',
    getDetail: async () => { proof.reads++; return { ...fixture(state), preview: state === 'unknown' ? null : fixture().preview } },
    getConfirmation: async () => { proof.challenges++; return { detail: fixture(), nonce: 'design-only-nonce' } },
    confirm: async () => { proof.confirmations++; return { ...fixture(), state: 'succeeded', result: { summary: '本页演示已切换，没有调用系统API。', completion: 'done' } } },
    deny: async () => ({ ...fixture(), state: 'denied' }),
  } }, [state])
  return <ToolCardActionsContext.Provider value={{ systemActions: actions }}><ChatInteractionContext.Provider value={{ sendUserText: () => {} }}>
    <main className="mx-auto max-w-5xl space-y-5 px-5 py-8">
      <header><h1 className="text-xl font-semibold text-fg">原生智能 UI · 样式对照</h1><p className="mt-2 text-body text-muted">现有组件与系统操作使用同一 Frame、Button、Modal 和主题。全部为设计示例。</p></header>
      <div className="grid items-start gap-6 md:grid-cols-2">
        <section><h2 className="mb-3 text-body font-medium text-muted">现有表单组件</h2><IuiBlock code={JSON.stringify({ type: 'form', title: '整理阅读笔记', subtitle: '既有原生组件', fields: [{ id: 'topic', label: '笔记主题', placeholder: '输入主题' }, { id: 'style', label: '整理方式', kind: 'select', options: ['简短摘要', '结构大纲'] }], submit: '生成草稿（示例）' })} readOnly={readOnly} /></section>
        <section><h2 className="mb-3 text-body font-medium text-muted">系统操作 · 复用同一组件体系</h2><IuiBlock code={reference} readOnly={readOnly} /></section>
      </div>
      <IuiBlock code={JSON.stringify({ type: 'kv', title: '既有展示类组件', items: [{ label: '外框', value: '展示内容不增加卡片外框' }, { label: '操作', value: '浅色面板，确认使用原生sheet' }] })} />
    </main>
    {confirm && <ClickConfirmation />}
  </ChatInteractionContext.Provider></ToolCardActionsContext.Provider>
}
export const systemActionScenes: Scene[] = [
  { id: 'system-actions-compare', label: '新旧原生组件对照', group: '工作区', viewports: ['desktop','mobile'], api: {}, render: () => <Study /> },
  { id: 'system-actions-confirm', label: '原生系统确认sheet', group: '工作区', viewports: ['desktop','mobile'], api: {}, render: () => <Study confirm /> },
  { id: 'system-actions-readonly', label: '分享只读不可操作', group: '工作区', viewports: ['desktop','mobile'], api: {}, render: () => <Study readOnly /> },
  { id: 'system-actions-unknown', label: '未知结果不重复执行', group: '工作区', viewports: ['desktop','mobile'], api: {}, render: () => <Study state="unknown" /> },
]
