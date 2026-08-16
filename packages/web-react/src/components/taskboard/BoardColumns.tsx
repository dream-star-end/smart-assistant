import { Columns3 } from 'lucide-react'
import type { ReactNode } from 'react'
import type { BoardColumn, Ticket } from '../../lib/taskboard'
import { EmptyState } from '../ui'
import { TicketCard } from './TicketCard'

export function BoardColumns({
  columns,
  onOpenTicket,
  renderActions,
}: {
  columns: BoardColumn[]
  onOpenTicket?: (ticket: Ticket) => void
  renderActions?: (ticket: Ticket) => ReactNode
}) {
  if (columns.length === 0) {
    return (
      <EmptyState
        icon={Columns3}
        title="还没有流水线列"
        hint="选一个项目后，单据会按当前流水线阶段分列。"
      />
    )
  }
  return (
    <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto overscroll-x-contain px-4 pb-4">
      {columns.map((col) => (
        <section
          key={col.stage.id}
          data-testid="taskboard-column"
          data-stage-id={col.stage.id}
          className="flex w-72 shrink-0 flex-col rounded-xl bg-bg"
        >
          <header className="flex items-center justify-between gap-2 px-1 py-2">
            <h3 className="truncate text-section font-semibold text-fg">{col.stage.name}</h3>
            <span className="text-caption text-faint">{col.tickets.length}</span>
          </header>
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-0.5">
            {col.tickets.length === 0 ? (
              <p className="px-1 py-6 text-center text-meta text-faint">这一列还没有单据</p>
            ) : (
              col.tickets.map((ticket) => (
                <TicketCard
                  key={ticket.id}
                  ticket={ticket}
                  onOpen={onOpenTicket}
                  actions={renderActions?.(ticket)}
                />
              ))
            )}
          </div>
        </section>
      ))}
    </div>
  )
}
