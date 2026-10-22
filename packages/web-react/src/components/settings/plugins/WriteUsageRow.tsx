/* 插件卡片上的「今日已用 / 上限」（OCV5-553）：只有声明了每日写上限的插件（当前只有抖音）才有。 */
import type { RuntimePluginAccount } from '../../../lib/connectors'
import { ListRow } from '../../ui'

type WriteUsage = NonNullable<RuntimePluginAccount['writeUsage']>

/** 北京时间 HH:MM（与确认卡上的时间一致）。 */
function beijingClock(iso: string): string | null {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  const d = new Date(ms + 8 * 3_600_000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

export function WriteUsageRow({ usage, accountName }: { usage: WriteUsage; accountName: string }) {
  const cooldown = usage.cooldownUntil ? beijingClock(usage.cooldownUntil) : null
  return (
    <ListRow className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-[14px] leading-5 text-fg">今日已用 / 上限</div>
        {usage.available ? (
          <ul
            aria-label={`${accountName}今日写入用量`}
            className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-meta text-muted"
          >
            {usage.buckets.map((bucket) => (
              <li
                key={bucket.bucket}
                className={bucket.used >= bucket.cap ? 'text-warning' : undefined}
              >
                {bucket.label}{' '}
                <span className="tabular-nums">
                  {bucket.used} / {bucket.cap}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-0.5 text-meta text-faint">
            今日用量暂不可用，写入会照常受上限约束。
          </div>
        )}
        {cooldown && (
          <output className="mt-1 block text-meta text-warning">
            账号触发过风控，写操作暂停到北京时间 {cooldown}。
          </output>
        )}
        <div className="mt-0.5 text-meta text-faint">
          按北京时间自然日计（{usage.day}），次日 0 点重置。
        </div>
      </div>
    </ListRow>
  )
}
