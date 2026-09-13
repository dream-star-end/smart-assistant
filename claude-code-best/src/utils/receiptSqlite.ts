import { createRequire } from 'node:module'
import type NodeDatabase from 'better-sqlite3'
import { ReceiptDeliveryCoordinator, type ReceiptSqlValue, type ReceiptSqliteFactory } from '../../../packages/storage/src/receiptDeliveryCoordinator.js'

/** No eager native-addon import: the default CCB runtime is Bun, not Node. */
export async function openReceiptDelivery(
  existingDatabasePath: string,
): Promise<ReceiptDeliveryCoordinator> {
  let open: ReceiptSqliteFactory
  if (process.versions.bun) {
    const { Database } = await import('bun:sqlite')
    open = path => new Database(path, {
      create: false,
      readwrite: true,
      strict: true,
    })
  } else {
    const Database = createRequire(import.meta.url)(
      'better-sqlite3',
    ) as typeof NodeDatabase
    open = path => {
      const db = new Database(path, { fileMustExist: true })
      return { exec: sql => db.exec(sql), prepare: sql => db.prepare<ReceiptSqlValue[]>(sql),
        transaction: write => db.transaction(write), close: () => db.close() }
    }
  }
  return new ReceiptDeliveryCoordinator(existingDatabasePath, open)
}
