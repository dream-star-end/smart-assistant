import { RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
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
  const epoch = useRef(0)
  useEffect(() => {
    epoch.current += 1
    setRefreshed(null)
    setLoading(false)
    setError('')
    return () => {
      epoch.current += 1
    }
  }, [auth, agents])
  const available = refreshed ?? agents
  const refresh = async () => {
    const owner = epoch.current
    setLoading(true)
    setError('')
    try {
      const items = await taskboardApi.listAgents(auth)
      if (owner === epoch.current) setRefreshed(items)
    } catch (e) {
      if (owner === epoch.current && !(e instanceof AuthEpochStaleError)) {
        setError(taskboardErrorMessage(e, '加载助手失败'))
      }
    } finally {
      if (owner === epoch.current) setLoading(false)
    }
  }
  return (
    <Field
      label="新增 AI 阶段的执行助手"
      required
      error={error || undefined}
      hint={
        available.length
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
