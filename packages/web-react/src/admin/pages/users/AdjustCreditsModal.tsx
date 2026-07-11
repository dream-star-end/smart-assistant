import { useEffect, useState } from 'react'
import { Button, Input, Modal, useToast } from '../../../components/ui'
import { adminSend, apiErrorMessage } from '../../lib/adminApi'
import { fmtYuan, parseYuanToCents } from './format'

type AdjustResult = { ledger_id: string; balance_after: string; audit_id: string }

/**
 * 调整用户余额 —— 两字段（¥ 金额 + 必填 memo）+ 实时 cents 预览。
 *
 * 为何不用 usePrompt：usePrompt 只提供单输入框，而动账需「金额 + 备注」双字段且
 * 金额要实时解析预览（避免 admin 误把「¥1」发成 1 分）。故用 Modal 原语自建。
 * 金额→cents 的解析与 vanilla parseYuanToCents 同语义；服务端另有 ±¥100 万硬 cap。
 */
export function AdjustCreditsModal({
  userId,
  userEmail,
  onClose,
  onDone,
}: {
  userId: string | null
  userEmail?: string
  onClose: () => void
  onDone: () => void
}) {
  const toast = useToast()
  const [amount, setAmount] = useState('')
  const [memo, setMemo] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // 每次打开（userId 变化）重置输入。userId 是「打开/切换用户」触发器（body 内不直接读）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: userId 作为重置触发器
  useEffect(() => {
    setAmount('')
    setMemo('')
    setSubmitting(false)
  }, [userId])

  const cents = parseYuanToCents(amount)
  const preview =
    amount.trim() === ''
      ? '解析后：—'
      : cents == null
        ? '解析后：无效金额（最多 2 位小数、非零）'
        : `解析后：${fmtYuan(cents)}（${cents} 分）`
  const previewTone =
    amount.trim() === '' ? 'text-faint' : cents == null ? 'text-danger' : 'text-success'

  const canSubmit = cents != null && memo.trim().length > 0 && !submitting

  const submit = async () => {
    if (cents == null) {
      toast('金额必须是非零数字，最多 2 位小数（如 1.00 / -0.50）', 'error')
      return
    }
    if (memo.trim().length === 0) {
      toast('备注不能为空', 'error')
      return
    }
    setSubmitting(true)
    try {
      const r = await adminSend<AdjustResult>('POST', `/users/${userId}/credits`, {
        delta: String(cents),
        memo: memo.trim(),
      })
      toast(`已记账，新余额 ${fmtYuan(r.balance_after)}`, 'success')
      onDone()
      onClose()
    } catch (e) {
      toast(`调账失败：${apiErrorMessage(e, '请求失败')}`, 'error')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={userId !== null}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
      title="调整余额"
      description={userEmail ? `用户 ${userEmail}（#${userId}）` : `用户 #${userId}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button variant="primary" onClick={submit} disabled={!canSubmit}>
            {submitting ? '提交中…' : '提交'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-[12.5px] font-medium text-muted" htmlFor="adj-amount">
            金额（¥，支持两位小数；正数加、负数扣）
          </label>
          <Input
            id="adj-amount"
            value={amount}
            placeholder="例如 1.00 或 -0.50"
            autoComplete="off"
            onChange={(e) => setAmount(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && canSubmit) {
                e.preventDefault()
                void submit()
              }
            }}
          />
          <p className={`text-[12px] tabular-nums ${previewTone}`}>{preview}</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-[12.5px] font-medium text-muted" htmlFor="adj-memo">
            备注（必填）
          </label>
          <Input
            id="adj-memo"
            value={memo}
            maxLength={500}
            placeholder="如：补偿 / 退款 / 测试"
            onChange={(e) => setMemo(e.target.value)}
          />
        </div>
      </div>
    </Modal>
  )
}
