export const TICKET_TYPES = ['bug', 'feature', 'spike', 'chore'] as const
export type TicketType = (typeof TICKET_TYPES)[number]
