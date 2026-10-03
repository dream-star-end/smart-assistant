export function assertTestDatabaseUrl(value: string): void
export function assertConnectedTestDatabase(client: {
  query(sql: string): Promise<{ rows: Array<{ db: string }> }>
}): Promise<void>
