import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Modal, Spinner } from '../../../components/ui'
import { SelectFilter } from '../../components'
import { adminGet, apiErrorMessage } from '../../lib/adminApi'
import type { ContainerLogs } from './types'

const LINE_OPTIONS = [
  { label: '100 行', value: '100' },
  { label: '200 行', value: '200' },
  { label: '500 行', value: '500' },
]

/**
 * 容器日志查看 Modal（等宽字体、可选行数、可刷新、行数上限由后端 lines 参数控制）。
 *
 * 竞态：同一 modal 内快速切行数 / 点刷新时，用 loadSeq 丢弃晚到的旧响应
 * （对齐 vanilla LOGS_MODAL_STATE.loadSeq）。
 */
export function ContainerLogsModal({
  id,
  label,
  onClose,
}: {
  /** 打开的容器 id；null = 关闭。 */
  id: number | null
  label: string
  onClose: () => void
}) {
  const [lines, setLines] = useState('200')
  const [text, setText] = useState('加载中…')
  const [loading, setLoading] = useState(false)
  const seqRef = useRef(0)
  const bodyRef = useRef<HTMLPreElement>(null)

  const load = useCallback(async (cid: number, n: string) => {
    const mySeq = ++seqRef.current
    setLoading(true)
    setText('加载中…')
    try {
      const data = await adminGet<ContainerLogs>(`/agent-containers/${cid}/logs`, { lines: n })
      if (mySeq !== seqRef.current) return // 被更新的请求/关闭抢占 → 丢弃
      if (data.missing) {
        setText(
          `容器已不存在（docker_ref=${data.docker_ref ?? 'null'}）。数据库行仍可见，可在「用户」页按 user 追查。`,
        )
        return
      }
      let combined = data.combined || '(无输出)'
      if (data.partial === 'bytes_truncated') {
        combined = `⚠ 后端命中 2 MiB 上限，仅展示前 2 MiB，之后内容已截断。\n────\n${combined}`
      } else if (data.partial === 'stream_error') {
        combined = `⚠ docker logs 流中途报错，以下内容不完整。\n────\n${combined}`
      }
      setText(combined)
      // 滚到底看最新
      requestAnimationFrame(() => {
        const el = bodyRef.current
        if (el) el.scrollTop = el.scrollHeight
      })
    } catch (e) {
      if (mySeq !== seqRef.current) return
      setText(`加载失败：${apiErrorMessage(e, '请求失败')}`)
    } finally {
      if (mySeq === seqRef.current) setLoading(false)
    }
  }, [])

  // 打开（id 变化）或切换行数时重拉。id=null（关闭）时 seq++ 使在飞响应作废。
  useEffect(() => {
    if (id === null) {
      seqRef.current++
      return
    }
    void load(id, lines)
  }, [id, lines, load])

  return (
    <Modal
      open={id !== null}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
      title="容器日志"
      description={label}
      className="max-w-3xl"
      footer={
        <>
          <SelectFilter label="行数" value={lines} options={LINE_OPTIONS} onChange={setLines} />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => id !== null && load(id, lines)}
            disabled={loading || id === null}
          >
            {loading ? <Spinner size={14} /> : <RefreshCw size={14} />}
            刷新
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            关闭
          </Button>
        </>
      }
    >
      <pre
        ref={bodyRef}
        className="max-h-[58vh] min-h-[300px] overflow-auto whitespace-pre-wrap break-all rounded-lg bg-hover p-3 font-mono text-[12px] leading-relaxed text-fg"
      >
        {text}
      </pre>
    </Modal>
  )
}
