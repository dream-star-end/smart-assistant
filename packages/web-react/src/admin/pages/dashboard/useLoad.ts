import { type DependencyList, useCallback, useEffect, useRef, useState } from 'react'

export type UseLoad<T> = {
  data: T | null
  loading: boolean
  error: Error | null
  /** 手动重拉（尊重卸载守卫）。 */
  reload: () => void
}

/**
 * 「载入一次 + 依赖变化重拉 + 手动 reload」的只读数据 hook —— 补齐 useAdminPoll
 * （30s 轮询）之外的场景：非轮询 tab 的首载/刷新，以及 dashboard「运营至今」这类
 * **不应进 30s 轮询**（全表 COUNT/SUM）的重查询。
 *
 * 与 useAdminPoll 的差异：无 interval、无 visibility 补拉 —— 只在 deps 变化或
 * 显式 reload() 时打一次；卸载/deps 变化经 alive 守卫废弃在飞结果。
 */
export function useLoad<T>(
  fetcher: () => Promise<T>,
  deps: DependencyList = [],
  opts: { enabled?: boolean } = {},
): UseLoad<T> {
  const { enabled = true } = opts
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState<Error | null>(null)

  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher
  const runRef = useRef<(() => void) | null>(null)
  const reload = useCallback(() => runRef.current?.(), [])

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      runRef.current = null
      return
    }
    let alive = true
    const run = async () => {
      setLoading(true)
      try {
        const d = await fetcherRef.current()
        if (!alive) return
        setData(d)
        setError(null)
      } catch (e) {
        if (alive) setError(e instanceof Error ? e : new Error(String(e)))
      } finally {
        if (alive) setLoading(false)
      }
    }
    runRef.current = () => void run()
    void run()
    return () => {
      alive = false
      runRef.current = null
    }
    // fetcher 走 ref 不进依赖；deps 变化重拉。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps])

  return { data, loading, error, reload }
}
