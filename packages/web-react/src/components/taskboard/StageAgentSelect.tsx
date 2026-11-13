import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AuthEpochStaleError } from '../../lib/api'
import { type BoardAgent, taskboardApi, taskboardErrorMessage } from '../../lib/taskboard'
import type { AuthSession } from '../../lib/types'
import { Field, IconButton, Select } from '../ui'

const EMPTY_AGENTS: readonly BoardAgent[] = []

/** Explicit binding for newly created builtin stages; never infer an assistant. */
export function StageAgentSelect({
  auth,
  agents = EMPTY_AGENTS,
  value,
  onValueChange,
}: {
  auth: AuthSession
  agents?: readonly BoardAgent[]
  value: string
  onValueChange: (value: string) => void
}) {
  const [refreshed, setRefreshed] = useState<BoardAgent[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const currentOwner = useRef({ auth, agents, active: true })
  const available = refreshed ?? agents
  const refresh = useCallback(async () => {
    const owner = currentOwner.current
    setLoading(true)
    setError('')
    try {
      const items = await taskboardApi.listAgents(auth)
      if (owner.active && currentOwner.current === owner) setRefreshed(items)
    } catch (e) {
      if (owner.active && currentOwner.current === owner && !(e instanceof AuthEpochStaleError)) {
        setError(taskboardErrorMessage(e, '加载助手失败'))
      }
    } finally {
      if (owner.active && currentOwner.current === owner) setLoading(false)
    }
  }, [auth])
  useEffect(() => {
    const owner = { auth, agents, active: true }
    currentOwner.current = owner
    setRefreshed(null)
    setLoading(false)
    setError('')
    if (agents.length === 0) void refresh()
    return () => {
      owner.active = false
    }
  }, [auth, agents, refresh])
  return (
    <Field
      label="新增 AI 阶段的执行助手"
      required
      error={error || undefined}
      hint={
        loading
          ? '正在加载已安装助手…'
          : error
            ? '可以刷新助手列表后重试。'
            : available.length
              ? '用于新建的内置 AI 阶段，模型跟随助手默认。已有阶段和自定义模板保持原配置。'
              : '请先安装助手，再刷新列表并选择。未配置的 AI 阶段不会自动运行。'
      }
    >
      <div className="flex items-center gap-2">
        <Select
          aria-label="新增 AI 阶段的执行助手"
          data-testid="builtin-execution-agent"
          className="min-w-0 flex-1"
          selectClassName="min-h-11"
          value={value}
          onValueChange={onValueChange}
          placeholder="请选择执行助手"
          options={[
            ...(value && !available.some((a) => a.id === value)
              ? [{ value, label: `${value}（当前不可用，请重新选择）`, disabled: true }]
              : []),
            ...available.map((a) => ({ value: a.id, label: a.name || a.id })),
          ]}
        />
        <IconButton
          type="button"
          className="min-h-11 min-w-11"
          aria-label="刷新执行助手"
          disabled={loading}
          onClick={() => void refresh()}
        >
          <RefreshCw size={16} />
        </IconButton>
      </div>
    </Field>
  )
}
