import Database from 'better-sqlite3'
import { ReceiptDeliveryCoordinator, type ReceiptSqlValue } from './receiptDeliveryCoordinator.js'

export * from './receiptDeliveryCoordinator.js'

/** Existing Node consumer API; no changes to ordinary gateway SQLite stores. */
export class ReceiptDeliveryStore extends ReceiptDeliveryCoordinator {
  constructor(dbPath: string, now: () => number = Date.now) {
    super(dbPath, path => {
      const db = new Database(path, { fileMustExist: true })
      return {
        exec: sql => db.exec(sql),
        prepare: sql => db.prepare<ReceiptSqlValue[]>(sql),
        transaction: write => db.transaction(write),
        close: () => db.close(),
      }
    }, now)
  }
}
